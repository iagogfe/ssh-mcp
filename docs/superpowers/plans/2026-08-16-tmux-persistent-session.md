# tmux Persistent Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cd`, `export`, and shell state persist across MCP tool calls by keeping the remote shell inside a tmux session on the target host.

**Architecture:** A new pure module `src/tmux.ts` builds the POSIX shell scripts and parses their output; `src/index.ts` keeps sole ownership of SSH I/O and runs those scripts over the existing `conn.exec()` channel. Session state lives on the remote host in tmux, so every tool call still uses a short-lived SSH channel and the current exit-code/stdout/stderr path is untouched.

**Tech Stack:** TypeScript (ES2022, Node16 modules), `ssh2`, `zod` v4, `@modelcontextprotocol/server` v2, vitest, Docker Compose for the SSH fixture.

**Spec:** `docs/superpowers/specs/2026-08-16-tmux-persistent-session-design.md`

## Deviation from the spec — read before Task 1

The spec's Architecture table places `probeTmux()` and `runInTmux()` inside
`src/tmux.ts`. Both need `execSshCommandWithConnection`, which lives in
`src/index.ts`, and `src/index.ts` needs the builders from `src/tmux.ts` — a
circular import. ESM tolerates it only when nothing is used at module-init
time, which is a fragile property to depend on.

This plan therefore keeps `src/tmux.ts` **100% pure** — string builders and
parsers, no I/O, no imports from `src/index.ts` — and puts `probeTmux()` and
`runInTmux()` in `src/index.ts` next to the SSH machinery they use. Every other
decision in the spec stands unchanged. The payoff: the whole new module is unit
testable with no SSH server, which is the testing goal the spec set out.

## Global Constraints

- Node >= 20; no new npm dependencies.
- Remote scripts are **POSIX sh only**. `.` not `source`; no `[[ ]]`, no arrays, no `local`. The tmux session's shell may be `dash`.
- Default tmux session name: `ssh-mcp`. Configurable via `--tmuxSession` / `SSH_MCP_TMUX_SESSION`.
- Session names must match `^[A-Za-z0-9_-]+$`; tokens must match `^[A-Za-z0-9]+$`. Both are rejected at build time, never quoted-and-hoped.
- Mode precedence, first match wins: `suPassword` set → `su`; `--noTmux` → `stateless`; tmux present → `tmux`; tmux absent → `blocked`.
- In `blocked` mode nothing executes on the remote host — `exec` and `sudo-exec` throw `ProtocolError(InvalidParams)` with install guidance.
- Job status is signalled by a `SSH_MCP_JOB <state> <value>` first line of stdout, never by a reserved exit code.
- These exports keep their current signatures: `execSshCommandWithConnection`, `execSshCommand`, `formatCommandResult`, `parseMaxBytes`, `sanitizeCommand`, `sanitizeDescription`, `verifyHostKeySync`, `buildConnectConfig`.
- The `su -` path (`src/index.ts:428-520`, `src/index.ts:748-792`) is not modified by any task.
- Target version: 2.0.0.
- Run tests with `npm test` (wraps `cross-env SSH_MCP_DISABLE_MAIN=1 vitest --run`). A single file: `npm test -- test/tmux.test.ts`.

---

### Task 1: Pure script builders for command execution

**Files:**
- Create: `src/tmux.ts`
- Test: `test/tmux.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TmuxMode = 'tmux' | 'stateless' | 'su' | 'blocked'`
  - `const DEFAULT_TMUX_SESSION = 'ssh-mcp'`
  - `function assertSessionName(session: string): void` — throws `Error` on invalid
  - `function assertToken(token: string): void` — throws `Error` on invalid
  - `interface RunScriptOptions { session: string; token: string; kind: 'exec' | 'sudo'; detach?: boolean }`
  - `function buildRunScript(opts: RunScriptOptions): string`
  - `function buildInterruptScript(session: string): string`

- [ ] **Step 1: Write the failing tests**

Create `test/tmux.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  assertSessionName,
  assertToken,
  buildRunScript,
  buildInterruptScript,
  DEFAULT_TMUX_SESSION,
} from '../src/tmux';

describe('assertSessionName', () => {
  it('accepts plain names', () => {
    expect(() => assertSessionName('ssh-mcp')).not.toThrow();
    expect(() => assertSessionName('deploy_1')).not.toThrow();
  });

  it('rejects anything that could break out of the tmux argument', () => {
    for (const bad of ['a b', "a'b", 'a;b', 'a$b', 'a:b', 'a.b', '', '../x']) {
      expect(() => assertSessionName(bad)).toThrow(/session name/i);
    }
  });
});

describe('assertToken', () => {
  it('accepts the manager token format', () => {
    expect(() => assertToken('k1z')).not.toThrow();
    expect(() => assertToken('k2mz')).not.toThrow();
  });

  it('rejects non-alphanumeric tokens', () => {
    for (const bad of ['k1 z', "k1'z", 'k1;z', '', 'k1.z']) {
      expect(() => assertToken(bad)).toThrow(/token/i);
    }
  });
});

describe('buildRunScript', () => {
  const base = { session: DEFAULT_TMUX_SESSION, token: 'k1z', kind: 'exec' as const };

  it('bootstraps the session idempotently', () => {
    const s = buildRunScript(base);
    expect(s).toContain('tmux has-session -t ssh-mcp 2>/dev/null || tmux new-session -d -s ssh-mcp');
  });

  it('recovers the workdir from the tmux environment before creating one', () => {
    const s = buildRunScript(base);
    expect(s).toContain('tmux show-environment -t ssh-mcp SSH_MCP_DIR');
    expect(s).toContain('mktemp -d');
    expect(s).toContain('tmux set-environment -t ssh-mcp SSH_MCP_DIR');
    expect(s.indexOf('show-environment')).toBeLessThan(s.indexOf('mktemp -d'));
  });

  it('rejects a workdir path containing quotes or spaces', () => {
    const s = buildRunScript(base);
    expect(s).toContain('exit 78');
  });

  it('prunes stale files', () => {
    expect(buildRunScript(base)).toContain("find \"$D\" -type f -mtime +7 -delete");
  });

  it('reads the command from stdin instead of interpolating it', () => {
    const s = buildRunScript(base);
    expect(s).toContain('cat > "$D/cmd.$T"');
  });

  it('sources the command file so cd and export mutate the session shell', () => {
    const s = buildRunScript(base);
    expect(s).toContain(". '$D/cmd.$T'");
    expect(s).not.toContain('source ');
  });

  it('keeps $? unexpanded so the tmux shell evaluates it', () => {
    expect(buildRunScript(base)).toContain('echo \\$? >');
  });

  it('waits on a non-empty rc file, not mere existence', () => {
    const s = buildRunScript(base);
    expect(s).toContain('while [ ! -s "$D/rc.$T" ]');
    expect(s).not.toContain('while [ ! -f "$D/rc.$T" ]');
  });

  it('returns stdout, stderr and the exit code through the channel', () => {
    const s = buildRunScript(base);
    expect(s).toContain('cat "$D/out.$T"');
    expect(s).toContain('cat "$D/err.$T" >&2');
    expect(s).toContain('exit "$RC"');
  });

  it('runs sudo as a subprocess so root cannot mutate session state', () => {
    const s = buildRunScript({ ...base, kind: 'sudo' });
    expect(s).toContain("sudo -n sh '$D/cmd.$T'");
    expect(s).not.toContain(". '$D/cmd.$T'");
  });

  it('detach backgrounds the subshell and records a start time', () => {
    const s = buildRunScript({ ...base, detach: true });
    expect(s).toContain("date +%s > '$D/start.$T'");
    expect(s).toContain('; } &');
  });

  it('detach omits the collect block so it returns immediately', () => {
    const s = buildRunScript({ ...base, detach: true });
    expect(s).not.toContain('while [ ! -s "$D/rc.$T" ]');
    expect(s).not.toContain('exit "$RC"');
  });

  it('produces different scripts for different tokens', () => {
    expect(buildRunScript(base)).not.toEqual(buildRunScript({ ...base, token: 'k2z' }));
  });

  it('validates its inputs', () => {
    expect(() => buildRunScript({ ...base, session: 'a;b' })).toThrow();
    expect(() => buildRunScript({ ...base, token: "a'b" })).toThrow();
  });
});

describe('buildInterruptScript', () => {
  it('sends Ctrl-C to the session', () => {
    expect(buildInterruptScript('ssh-mcp')).toContain('tmux send-keys -t ssh-mcp C-c');
  });

  it('validates the session name', () => {
    expect(() => buildInterruptScript('a b')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tmux.test.ts`
Expected: FAIL — `Failed to resolve import "../src/tmux"`.

- [ ] **Step 3: Write the implementation**

Create `src/tmux.ts`:

```typescript
// Pure builders for the POSIX shell scripts that drive the remote tmux session.
// This module performs no I/O and imports nothing from src/index.ts, which keeps
// it free of a circular dependency and unit testable without an SSH server.
//
// Everything here targets POSIX sh: the tmux session's shell may be dash, so no
// bashisms (`source`, `[[ ]]`, arrays, `local`).

export type TmuxMode = 'tmux' | 'stateless' | 'su' | 'blocked';

export const DEFAULT_TMUX_SESSION = 'ssh-mcp';

// tmux session names cannot contain '.' or ':' (it parses them as window/pane
// separators). Restricting to this set also means the name never needs shell
// quoting, so there is no escaping to get wrong.
const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^[A-Za-z0-9]+$/;

export function assertSessionName(session: string): void {
  if (!SESSION_RE.test(session)) {
    throw new Error(
      `Invalid tmux session name ${JSON.stringify(session)}: only letters, digits, '-' and '_' are allowed`,
    );
  }
}

export function assertToken(token: string): void {
  if (!TOKEN_RE.test(token)) {
    throw new Error(`Invalid command token ${JSON.stringify(token)}: only letters and digits are allowed`);
  }
}

export interface RunScriptOptions {
  session: string;
  token: string;
  kind: 'exec' | 'sudo';
  detach?: boolean;
}

// Preamble shared by every remote script: attach or create the session, recover
// the working directory from the session's own environment, and create one with
// mktemp if it is missing.
//
// The workdir is deliberately NOT a predictable path like /tmp/ssh-mcp-$(id -u):
// on a multi-user host another user could pre-create that as a symlink and
// redirect our writes. mktemp -d creates it atomically, mode 700, under an
// unguessable name. Storing the path in the tmux session recovers it on every
// call and survives an MCP server restart, which is what keeps job ids valid.
function preamble(session: string): string {
  return [
    'set -eu',
    `tmux has-session -t ${session} 2>/dev/null || tmux new-session -d -s ${session}`,
    `D=$(tmux show-environment -t ${session} SSH_MCP_DIR 2>/dev/null | sed -n 's/^SSH_MCP_DIR=//p')`,
    'if [ -z "$D" ] || [ ! -d "$D" ]; then',
    '  D=$(mktemp -d "${TMPDIR:-/tmp}/ssh-mcp.XXXXXXXX")',
    `  tmux set-environment -t ${session} SSH_MCP_DIR "$D"`,
    'fi',
    // $D is interpolated into a single-quoted context in the send-keys payload
    // below. A quote or space in TMPDIR would break out of it, so refuse instead.
    'case "$D" in *[\\\'\\"\\ ]*) echo "ssh-mcp: unsafe workdir path: $D" >&2; exit 78;; esac',
    'find "$D" -type f -mtime +7 -delete 2>/dev/null || true',
  ].join('\n');
}

export function buildRunScript(opts: RunScriptOptions): string {
  const { session, token, kind, detach = false } = opts;
  assertSessionName(session);
  assertToken(token);

  // Redirections and `$?` must survive into the tmux shell, so `$?` is escaped
  // here while `$D` and `$T` expand in the outer (channel) shell.
  const body =
    kind === 'sudo'
      ? `sudo -n sh '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo \\$? > '$D/rc.$T'`
      : `. '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo \\$? > '$D/rc.$T'`;

  const payload = detach
    ? `date +%s > '$D/start.$T'; { ${body}; } &`
    : body;

  const lines = [
    preamble(session),
    `T='${token}'`,
    'cat > "$D/cmd.$T"',
    `tmux send-keys -t ${session} "${payload}" Enter`,
  ];

  if (!detach) {
    lines.push(
      'while [ ! -s "$D/rc.$T" ]; do sleep 0.1; done',
      'cat "$D/out.$T"',
      'cat "$D/err.$T" >&2',
      'RC=$(cat "$D/rc.$T")',
      'rm -f "$D/cmd.$T" "$D/out.$T" "$D/err.$T" "$D/rc.$T"',
      'exit "$RC"',
    );
  }

  return lines.join('\n') + '\n';
}

// Sent after a command times out, so the wedged command dies and the session
// stays usable for the next call.
export function buildInterruptScript(session: string): string {
  assertSessionName(session);
  return `tmux send-keys -t ${session} C-c 2>/dev/null || true\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/tmux.test.ts`
Expected: PASS, all cases in the four `describe` blocks.

- [ ] **Step 5: Verify the generated script parses as POSIX sh**

Run:
```bash
npx tsx -e "import('./src/tmux.ts').then(m => console.log(m.buildRunScript({session:'ssh-mcp',token:'k1z',kind:'exec'})))" > /tmp/gen.sh 2>/dev/null || \
npm run build && node -e "import('./build/tmux.js').then(m=>{const fs=require('fs');fs.writeFileSync('/tmp/gen.sh',m.buildRunScript({session:'ssh-mcp',token:'k1z',kind:'exec'}))})"
sh -n /tmp/gen.sh && echo "POSIX OK"
```
Expected: `POSIX OK`. If `sh -n` reports a syntax error, the `case` line's escaping is the likely culprit — print the generated script and fix the escaping before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/tmux.ts test/tmux.test.ts
git commit -m "feat(tmux): add pure builders for remote session scripts"
```

---

### Task 2: tmux preflight probe and install guidance

**Files:**
- Modify: `src/tmux.ts`
- Modify: `test/tmux.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the module existing.
- Produces:
  - `interface TmuxProbe { tmux: string | null; pm: string | null }`
  - `function buildProbeScript(): string`
  - `function parseProbeOutput(stdout: string): TmuxProbe`
  - `function installHint(pm: string | null, host: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/tmux.test.ts`:

```typescript
import { buildProbeScript, parseProbeOutput, installHint } from '../src/tmux';

describe('buildProbeScript', () => {
  it('checks tmux and falls back to detecting a package manager', () => {
    const s = buildProbeScript();
    expect(s).toContain('command -v tmux');
    for (const pm of ['apt-get', 'apk', 'dnf', 'yum', 'pacman', 'zypper']) {
      expect(s).toContain(pm);
    }
  });
});

describe('parseProbeOutput', () => {
  it('reads the tmux version when present', () => {
    expect(parseProbeOutput('tmux=tmux 3.4\n')).toEqual({ tmux: 'tmux 3.4', pm: null });
  });

  it('reads the package manager when tmux is missing', () => {
    expect(parseProbeOutput('tmux=\npm=apt-get\n')).toEqual({ tmux: null, pm: 'apt-get' });
  });

  it('treats a missing tmux with no package manager as both null', () => {
    expect(parseProbeOutput('tmux=\n')).toEqual({ tmux: null, pm: null });
  });

  it('ignores unrelated noise on the channel', () => {
    expect(parseProbeOutput('motd banner\ntmux=tmux 2.8\n')).toEqual({ tmux: 'tmux 2.8', pm: null });
  });

  it('treats empty output as tmux absent', () => {
    expect(parseProbeOutput('')).toEqual({ tmux: null, pm: null });
  });
});

describe('installHint', () => {
  it('names the host and the exact command', () => {
    const msg = installHint('apt-get', 'db01.example.com');
    expect(msg).toContain('db01.example.com');
    expect(msg).toContain('sudo apt-get install -y tmux');
    expect(msg).toContain('--noTmux');
  });

  it('uses each package manager idiom', () => {
    expect(installHint('apk', 'h')).toContain('sudo apk add tmux');
    expect(installHint('pacman', 'h')).toContain('sudo pacman -S --noconfirm tmux');
    expect(installHint('dnf', 'h')).toContain('sudo dnf install -y tmux');
    expect(installHint('yum', 'h')).toContain('sudo yum install -y tmux');
    expect(installHint('zypper', 'h')).toContain('sudo zypper install -y tmux');
  });

  it('degrades without a command line when no package manager was found', () => {
    const msg = installHint(null, 'h');
    expect(msg).toContain('h');
    expect(msg).not.toContain('install -y');
    expect(msg).toContain('--noTmux');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tmux.test.ts`
Expected: FAIL — `buildProbeScript is not a function` (and the same for the other two).

- [ ] **Step 3: Write the implementation**

Append to `src/tmux.ts`:

```typescript
export interface TmuxProbe {
  tmux: string | null;  // version string, e.g. "tmux 3.4"
  pm: string | null;    // detected package manager, only when tmux is missing
}

// Runs over the plain conn.exec() channel — the path that already exists — so
// the probe never depends on the feature it is probing for. The package manager
// is detected in the same round trip to keep the failure message copy-pasteable.
export function buildProbeScript(): string {
  return [
    'if command -v tmux >/dev/null 2>&1; then',
    `  printf 'tmux=%s\\n' "$(tmux -V)"`,
    'else',
    `  printf 'tmux=\\n'`,
    '  for m in apt-get apk dnf yum pacman zypper; do',
    `    command -v "$m" >/dev/null 2>&1 && { printf 'pm=%s\\n' "$m"; break; }`,
    '  done',
    'fi',
    '',
  ].join('\n');
}

export function parseProbeOutput(stdout: string): TmuxProbe {
  let tmux: string | null = null;
  let pm: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('tmux=')) {
      const v = line.slice('tmux='.length).trim();
      tmux = v.length > 0 ? v : null;
    } else if (line.startsWith('pm=')) {
      const v = line.slice('pm='.length).trim();
      pm = v.length > 0 ? v : null;
    }
  }
  return { tmux, pm };
}

const PM_COMMANDS: Record<string, string> = {
  'apt-get': 'sudo apt-get install -y tmux',
  dnf: 'sudo dnf install -y tmux',
  yum: 'sudo yum install -y tmux',
  zypper: 'sudo zypper install -y tmux',
  apk: 'sudo apk add tmux',
  pacman: 'sudo pacman -S --noconfirm tmux',
};

export function installHint(pm: string | null, host: string): string {
  const lines = [
    `tmux não encontrado em ${host}.`,
    'Sessão persistente (cd/export entre comandos) precisa de tmux no host remoto.',
    '',
  ];
  const cmd = pm ? PM_COMMANDS[pm] : undefined;
  if (cmd) {
    lines.push(`  ${cmd}`, '');
  } else {
    lines.push('  Instale tmux pelo gerenciador de pacotes do host.', '');
  }
  lines.push('Ou rode sem estado (comportamento antigo, sem cd/export persistentes): --noTmux');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/tmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.test.ts
git commit -m "feat(tmux): add preflight probe and install guidance"
```

---

### Task 3: Background job script and status parsing

**Files:**
- Modify: `src/tmux.ts`
- Modify: `test/tmux.test.ts`

**Interfaces:**
- Consumes: `assertSessionName`, `assertToken` from Task 1.
- Produces:
  - `interface JobStatus { state: 'running' | 'done'; elapsedSeconds: number | null; exitCode: number | null; stdout: string; stderr: string }`
  - `function buildJobStatusScript(opts: { session: string; token: string }): string`
  - `function parseJobStatus(stdout: string, stderr: string): JobStatus`
  - `const JOB_MARKER = 'SSH_MCP_JOB'`

- [ ] **Step 1: Write the failing tests**

Append to `test/tmux.test.ts`:

```typescript
import { buildJobStatusScript, parseJobStatus, JOB_MARKER } from '../src/tmux';

describe('buildJobStatusScript', () => {
  const base = { session: 'ssh-mcp', token: 'k7z' };

  it('fails on an unknown job instead of reporting it as running', () => {
    const s = buildJobStatusScript(base);
    expect(s).toContain('[ -e "$D/start.$T" ]');
    expect(s).toContain('exit 78');
  });

  it('emits the done marker before any user output', () => {
    const s = buildJobStatusScript(base);
    const marker = s.indexOf(`printf 'SSH_MCP_JOB done`);
    const out = s.indexOf('cat "$D/out.$T"');
    expect(marker).toBeGreaterThan(-1);
    expect(out).toBeGreaterThan(marker);
  });

  it('emits the running marker with elapsed seconds and partial output', () => {
    const s = buildJobStatusScript(base);
    expect(s).toContain(`printf 'SSH_MCP_JOB running`);
    expect(s).toContain('tail -c 2000 "$D/out.$T"');
    expect(s).toContain('tail -c 2000 "$D/err.$T"');
  });

  it('reaps the job files only once done', () => {
    const s = buildJobStatusScript(base);
    const rm = s.indexOf('rm -f');
    const elseIdx = s.indexOf('else');
    expect(rm).toBeGreaterThan(-1);
    expect(rm).toBeLessThan(elseIdx);
  });

  it('always exits 0 so the user exit code cannot collide with the state', () => {
    expect(buildJobStatusScript(base).trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('validates its inputs', () => {
    expect(() => buildJobStatusScript({ session: 'a;b', token: 'k7z' })).toThrow();
    expect(() => buildJobStatusScript({ session: 'ssh-mcp', token: 'k 7' })).toThrow();
  });
});

describe('parseJobStatus', () => {
  it('parses a running job and strips the marker line', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 47\nbuilding step 3\n`, 'warn\n');
    expect(r.state).toBe('running');
    expect(r.elapsedSeconds).toBe(47);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toBe('building step 3\n');
    expect(r.stderr).toBe('warn\n');
  });

  it('parses a finished job with its exit code', () => {
    const r = parseJobStatus(`${JOB_MARKER} done 10\nall output\n`, 'boom\n');
    expect(r.state).toBe('done');
    expect(r.exitCode).toBe(10);
    expect(r.elapsedSeconds).toBeNull();
    expect(r.stdout).toBe('all output\n');
  });

  it('does not mistake user output that looks like the marker', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 5\n${JOB_MARKER} done 0\n`, '');
    expect(r.state).toBe('running');
    expect(r.stdout).toBe(`${JOB_MARKER} done 0\n`);
  });

  it('treats a missing marker as a protocol failure', () => {
    expect(() => parseJobStatus('no marker here\n', '')).toThrow(/marker/i);
  });

  it('handles a job with no output yet', () => {
    const r = parseJobStatus(`${JOB_MARKER} running 0\n`, '');
    expect(r.state).toBe('running');
    expect(r.stdout).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tmux.test.ts`
Expected: FAIL — `buildJobStatusScript is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/tmux.ts`:

```typescript
export const JOB_MARKER = 'SSH_MCP_JOB';

export interface JobStatus {
  state: 'running' | 'done';
  elapsedSeconds: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// The state travels on the FIRST LINE of stdout, not on the exit code. When a
// job is done this script must surface the user's own exit code, so a reserved
// code would be indistinguishable from a user command that happened to exit
// with the same value. The marker is written before any user output, so user
// output can never be mistaken for it.
export function buildJobStatusScript(opts: { session: string; token: string }): string {
  const { session, token } = opts;
  assertSessionName(session);
  assertToken(token);

  return [
    'set -eu',
    `D=$(tmux show-environment -t ${session} SSH_MCP_DIR 2>/dev/null | sed -n 's/^SSH_MCP_DIR=//p')`,
    '[ -n "$D" ] && [ -d "$D" ] || { echo "ssh-mcp: session workdir not found" >&2; exit 78; }',
    `T='${token}'`,
    `[ -e "$D/start.$T" ] || { echo "ssh-mcp: unknown jobId $T" >&2; exit 78; }`,
    'if [ -s "$D/rc.$T" ]; then',
    `  printf '${JOB_MARKER} done %s\\n' "$(cat "$D/rc.$T")"`,
    '  cat "$D/out.$T"',
    '  cat "$D/err.$T" >&2',
    '  rm -f "$D/cmd.$T" "$D/out.$T" "$D/err.$T" "$D/rc.$T" "$D/start.$T"',
    'else',
    `  printf '${JOB_MARKER} running %s\\n' "$(( $(date +%s) - $(cat "$D/start.$T") ))"`,
    '  tail -c 2000 "$D/out.$T" 2>/dev/null || true',
    '  tail -c 2000 "$D/err.$T" >&2 2>/dev/null || true',
    'fi',
    'exit 0',
  ].join('\n');
}

export function parseJobStatus(stdout: string, stderr: string): JobStatus {
  const nl = stdout.indexOf('\n');
  const first = nl === -1 ? stdout : stdout.slice(0, nl);
  const rest = nl === -1 ? '' : stdout.slice(nl + 1);

  const m = first.match(new RegExp(`^${JOB_MARKER} (running|done) (-?\\d+)$`));
  if (!m) {
    throw new Error(`job status marker missing; got ${JSON.stringify(first.slice(0, 80))}`);
  }

  const value = parseInt(m[2], 10);
  return m[1] === 'running'
    ? { state: 'running', elapsedSeconds: value, exitCode: null, stdout: rest, stderr }
    : { state: 'done', elapsedSeconds: null, exitCode: value, stdout: rest, stderr };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/tmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tmux.ts test/tmux.test.ts
git commit -m "feat(tmux): add background job script and status parsing"
```

---

### Task 4: Mode resolution on the connection manager

**Files:**
- Modify: `src/index.ts` (`SSHConfig` at `:258`, `SSHConnectionManager` at `:301`)
- Test: `test/tmux-mode.test.ts`

**Interfaces:**
- Consumes: `TmuxMode`, `DEFAULT_TMUX_SESSION`, `buildProbeScript`, `parseProbeOutput` from `src/tmux.ts`.
- Produces on `SSHConnectionManager`:
  - `getTmuxSession(): string`
  - `getProbe(): TmuxProbe | null`
  - `resolveMode(runProbe: (script: string) => Promise<string>): Promise<TmuxMode>`
  - `resetMode(): void`
- Produces on `SSHConfig`: `noTmux?: boolean`, `tmuxSession?: string`

`resolveMode` takes the probe runner as a parameter rather than reaching for
`execSshCommandWithConnection` itself. That keeps it unit testable with a stub
and keeps the SSH dependency at the call site.

- [ ] **Step 1: Write the failing tests**

Create `test/tmux-mode.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SSHConnectionManager } from '../src/index';

const base = { host: '127.0.0.1', port: 22, username: 'test', password: 'test' };

describe('SSHConnectionManager.resolveMode', () => {
  it('picks su mode without probing when suPassword is set', async () => {
    const probe = vi.fn();
    const m = new SSHConnectionManager({ ...base, suPassword: 'x' });
    expect(await m.resolveMode(probe)).toBe('su');
    expect(probe).not.toHaveBeenCalled();
  });

  it('picks stateless mode without probing when noTmux is set', async () => {
    const probe = vi.fn();
    const m = new SSHConnectionManager({ ...base, noTmux: true });
    expect(await m.resolveMode(probe)).toBe('stateless');
    expect(probe).not.toHaveBeenCalled();
  });

  it('prefers su over noTmux', async () => {
    const m = new SSHConnectionManager({ ...base, suPassword: 'x', noTmux: true });
    expect(await m.resolveMode(vi.fn())).toBe('su');
  });

  it('picks tmux mode when the probe finds tmux', async () => {
    const m = new SSHConnectionManager(base);
    expect(await m.resolveMode(async () => 'tmux=tmux 3.4\n')).toBe('tmux');
    expect(m.getProbe()).toEqual({ tmux: 'tmux 3.4', pm: null });
  });

  it('picks blocked mode when the probe does not find tmux', async () => {
    const m = new SSHConnectionManager(base);
    expect(await m.resolveMode(async () => 'tmux=\npm=apk\n')).toBe('blocked');
    expect(m.getProbe()).toEqual({ tmux: null, pm: 'apk' });
  });

  it('probes only once per connection', async () => {
    const probe = vi.fn(async () => 'tmux=tmux 3.4\n');
    const m = new SSHConnectionManager(base);
    await m.resolveMode(probe);
    await m.resolveMode(probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes after resetMode, so a reconnect re-evaluates the host', async () => {
    const probe = vi.fn(async () => 'tmux=tmux 3.4\n');
    const m = new SSHConnectionManager(base);
    await m.resolveMode(probe);
    m.resetMode();
    await m.resolveMode(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('defaults the session name and honours an override', () => {
    expect(new SSHConnectionManager(base).getTmuxSession()).toBe('ssh-mcp');
    expect(new SSHConnectionManager({ ...base, tmuxSession: 'deploy' }).getTmuxSession()).toBe('deploy');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/tmux-mode.test.ts`
Expected: FAIL — `m.resolveMode is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/index.ts`, add to the import block near `src/index.ts:11`:

```typescript
import {
  DEFAULT_TMUX_SESSION,
  buildProbeScript,
  parseProbeOutput,
  type TmuxMode,
  type TmuxProbe,
} from './tmux.js';
```

Extend `SSHConfig` (`src/index.ts:258`) with two fields:

```typescript
  noTmux?: boolean;           // Force the stateless per-command exec path
  tmuxSession?: string;       // tmux session name (defaults to 'ssh-mcp')
```

Add to `SSHConnectionManager` (after `tokenSeq` at `src/index.ts:309`):

```typescript
  private tmuxMode: TmuxMode | null = null;
  private probe: TmuxProbe | null = null;

  getTmuxSession(): string {
    return this.sshConfig.tmuxSession || DEFAULT_TMUX_SESSION;
  }

  getProbe(): TmuxProbe | null {
    return this.probe;
  }

  // Cleared whenever the connection drops so a reconnect re-evaluates the host.
  resetMode(): void {
    this.tmuxMode = null;
    this.probe = null;
  }

  // Resolved once per connection. Precedence is fixed: su elevation owns the
  // shell, so tmux cannot also own it; an explicit --noTmux beats a probe; and
  // only then does the host get asked whether tmux exists.
  //
  // runProbe is injected rather than called directly so this stays testable
  // without an SSH server, and so src/tmux.ts can remain free of I/O.
  async resolveMode(runProbe: (script: string) => Promise<string>): Promise<TmuxMode> {
    if (this.tmuxMode) return this.tmuxMode;

    if (this.sshConfig.suPassword) {
      this.tmuxMode = 'su';
    } else if (this.sshConfig.noTmux) {
      this.tmuxMode = 'stateless';
    } else {
      this.probe = parseProbeOutput(await runProbe(buildProbeScript()));
      this.tmuxMode = this.probe.tmux ? 'tmux' : 'blocked';
    }
    return this.tmuxMode;
  }
```

In the three connection-teardown handlers (`src/index.ts:370` `'end'`,
`src/index.ts:377` `'close'`, and `src/index.ts:362` `'error'`), add
`this.resetMode();` next to the existing `this.conn = null;`. Also call it in
`close()` (`src/index.ts:535`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/tmux-mode.test.ts`
Expected: PASS, 8 cases.

- [ ] **Step 5: Verify nothing else regressed**

Run: `npm test -- test/output.test.ts test/maxChars.test.ts test/maxOutputBytes.test.ts test/security.test.ts`
Expected: PASS. These need no SSH server.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/tmux-mode.test.ts
git commit -m "feat(tmux): resolve execution mode once per connection"
```

---

### Task 5: Run commands through tmux, with timeout recovery

**Files:**
- Modify: `src/index.ts`
- Modify: `docker-compose.yml`
- Test: `test/tmux-session.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces in `src/index.ts`:
  - `export async function runInTmux(manager: SSHConnectionManager, command: string, opts: { kind: 'exec' | 'sudo'; detach?: boolean; maxBytes: number }): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>`
  - `export async function jobStatus(manager: SSHConnectionManager, jobId: string, maxBytes: number): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>`
  - `export async function ensureMode(manager: SSHConnectionManager): Promise<TmuxMode>`

- [ ] **Step 1: Add tmux to the test fixture**

Replace `docker-compose.yml` with:

```yaml
services:
  ssh:
    image: lscr.io/linuxserver/openssh-server:latest
    environment:
      - USER_NAME=test
      - PASSWORD_ACCESS=true
      - USER_PASSWORD=secret
      - SUDO_ACCESS=true
      - DOCKER_MODS=linuxserver/mods:universal-package-install
      - INSTALL_PACKAGES=tmux
    ports:
      - "2222:2222"
```

Run:
```bash
docker compose down -v && docker compose up -d
sleep 20
docker compose exec ssh tmux -V
```
Expected: a tmux version string. If the mod has not finished installing, wait and retry — it installs on first boot.

- [ ] **Step 2: Write the failing tests**

Create `test/tmux-session.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SSHConnectionManager, runInTmux, jobStatus, ensureMode } from '../src/index';

const host = process.env.SSH_HOST || '127.0.0.1';
const port = Number(process.env.SSH_PORT || 2222);
const username = process.env.SSH_USER || 'test';
const password = process.env.SSH_PASSWORD || 'secret';

const cfg = { host, port, username, password, insecureHostKey: true, tmuxSession: 'ssh-mcp-test' };
const text = (r: any) => r.content[0].text as string;

describe('tmux session (live SSH + tmux)', () => {
  let m: SSHConnectionManager;

  beforeEach(async () => {
    m = new SSHConnectionManager(cfg);
    await m.connect();
    expect(await ensureMode(m)).toBe('tmux');
  });

  afterEach(async () => {
    try {
      await runInTmux(m, 'true', { kind: 'exec', maxBytes: 0 });
    } catch { /* ignore */ }
    m.close();
  });

  it('keeps the working directory between calls', async () => {
    await runInTmux(m, 'cd /tmp', { kind: 'exec', maxBytes: 0 });
    const r = await runInTmux(m, 'pwd', { kind: 'exec', maxBytes: 0 });
    expect(text(r).trim()).toBe('/tmp');
  }, 30000);

  it('keeps exported environment between calls', async () => {
    await runInTmux(m, 'export SSH_MCP_PROBE=bar', { kind: 'exec', maxBytes: 0 });
    const r = await runInTmux(m, 'echo "[$SSH_MCP_PROBE]"', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('[bar]');
  }, 30000);

  it('reuses the same shell process', async () => {
    const a = text(await runInTmux(m, 'echo $$', { kind: 'exec', maxBytes: 0 })).trim();
    const b = text(await runInTmux(m, 'echo $$', { kind: 'exec', maxBytes: 0 })).trim();
    expect(a).toBe(b);
    expect(a).toMatch(/^\d+$/);
  }, 30000);

  it('preserves a two-digit exit code', async () => {
    const r: any = await runInTmux(m, 'exit 10', { kind: 'exec', maxBytes: 0 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('[exit 10]');
  }, 30000);

  it('keeps stderr separate from stdout', async () => {
    const r: any = await runInTmux(m, 'echo out; echo err >&2', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('out');
    expect(text(r)).toContain('stderr:');
    expect(text(r)).toContain('err');
  }, 30000);

  it('does not wrap a long line', async () => {
    const r = await runInTmux(m, 'printf "%0.sx" $(seq 1 500); echo', { kind: 'exec', maxBytes: 0 });
    const line = text(r).split('\n').find((l) => l.startsWith('x'));
    expect(line?.length).toBe(500);
  }, 30000);

  it('a timed-out command does not contaminate the next one', async () => {
    const slow = new SSHConnectionManager(cfg);
    await slow.connect();
    await ensureMode(slow);
    await expect(
      runInTmux(slow, 'sleep 120; echo POISON', { kind: 'exec', maxBytes: 0, timeoutMs: 2000 }),
    ).rejects.toThrow(/timed out/i);

    const r = await runInTmux(slow, 'echo clean', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('clean');
    expect(text(r)).not.toContain('POISON');
    slow.close();
  }, 60000);

  it('runs a detached job and collects it', async () => {
    const start: any = await runInTmux(m, 'sleep 2; echo late; exit 3', {
      kind: 'exec', detach: true, maxBytes: 0,
    });
    const id = text(start).match(/jobId=([A-Za-z0-9]+)/)?.[1];
    expect(id).toBeTruthy();

    const running: any = await jobStatus(m, id!, 0);
    expect(text(running)).toContain('[running]');

    let done: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = await jobStatus(m, id!, 0);
      if (!text(done).includes('[running]')) break;
    }
    expect(text(done)).toContain('late');
    expect(text(done)).toContain('[exit 3]');
  }, 60000);

  it('rejects an unknown jobId', async () => {
    await expect(jobStatus(m, 'nosuchtoken', 0)).rejects.toThrow(/unknown jobId/i);
  }, 30000);

  it('does not let the session shell block on a detached job', async () => {
    await runInTmux(m, 'sleep 30', { kind: 'exec', detach: true, maxBytes: 0 });
    const r = await runInTmux(m, 'echo responsive', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('responsive');
  }, 30000);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- test/tmux-session.test.ts`
Expected: FAIL — `runInTmux is not a function`.

- [ ] **Step 4: Write the implementation**

Add to the `src/tmux.js` import in `src/index.ts`:

```typescript
import {
  DEFAULT_TMUX_SESSION,
  JOB_MARKER,
  buildInterruptScript,
  buildJobStatusScript,
  buildProbeScript,
  buildRunScript,
  installHint,
  parseJobStatus,
  parseProbeOutput,
  type TmuxMode,
  type TmuxProbe,
} from './tmux.js';
```

Add after `execSshCommandWithConnection` (i.e. after `src/index.ts:826`):

```typescript
// Resolve the execution mode, running the tmux preflight over the plain
// conn.exec() channel when one is needed. Throws with install guidance when the
// host has no tmux: an agent that believes state persisted when it did not
// produces worse failures than an explicit error.
export async function ensureMode(manager: SSHConnectionManager): Promise<TmuxMode> {
  const mode = await manager.resolveMode(async (script) => {
    const res = await execSshCommandWithConnection(manager, script, undefined, 0);
    return res.content[0]?.text ?? '';
  });
  if (mode === 'blocked') {
    const probe = manager.getProbe();
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      installHint(probe?.pm ?? null, (manager as any).sshConfig.host),
    );
  }
  return mode;
}

export interface RunInTmuxOptions {
  kind: 'exec' | 'sudo';
  detach?: boolean;
  maxBytes: number;
  timeoutMs?: number;
}

// Run one command inside the persistent tmux session. The command travels over
// the channel's stdin into a file and is only ever referenced by path, so it is
// never interpolated into a shell string.
export async function runInTmux(
  manager: SSHConnectionManager,
  command: string,
  opts: RunInTmuxOptions,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const session = manager.getTmuxSession();
  const token = manager.nextToken();
  const script = buildRunScript({ session, token, kind: opts.kind, detach: opts.detach });

  try {
    const res = await execSshCommandWithConnection(manager, script, command, opts.maxBytes, opts.timeoutMs);
    if (opts.detach) {
      return {
        content: [{ type: 'text', text: `[detached] jobId=${token} — collect with job_status("${token}")` }],
      };
    }
    return res;
  } catch (err: any) {
    // A wedged command would otherwise keep the session busy for every later
    // call. Ctrl-C frees it; failure to send is not worth masking the timeout.
    if (/timed out/i.test(err?.message || '')) {
      try {
        await execSshCommandWithConnection(manager, buildInterruptScript(session), undefined, 0, 5000);
      } catch { /* best effort */ }
    }
    throw err;
  }
}

export async function jobStatus(
  manager: SSHConnectionManager,
  jobId: string,
  maxBytes: number,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const script = buildJobStatusScript({ session: manager.getTmuxSession(), token: jobId });
  const raw = await execSshCommandWithConnection(manager, script, undefined, 0);
  const combined = raw.content[0]?.text ?? '';

  // The script exits 0 in both states, so formatCommandResult returns plain
  // stdout unless the script itself failed (exit 78 for an unknown job), in
  // which case the marker is absent and parseJobStatus throws.
  let status;
  try {
    status = parseJobStatus(combined, '');
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      combined.includes('unknown jobId')
        ? `unknown jobId ${jobId}`
        : `job_status failed: ${combined.slice(0, 200)}`,
    );
  }

  if (status.state === 'running') {
    const head = `[running] ${status.elapsedSeconds}s — jobId=${jobId}`;
    return { content: [{ type: 'text', text: [head, status.stdout].filter(Boolean).join('\n') }] };
  }
  return formatCommandResult(
    { stdout: status.stdout, stderr: status.stderr, exitCode: status.exitCode },
    maxBytes,
  );
}
```

Note the extra `timeoutMs` parameter on `execSshCommandWithConnection`. Change
its signature (`src/index.ts:722`) to accept it, defaulting to the existing
constant, and use it for the timer at `src/index.ts:739`:

```typescript
export async function execSshCommandWithConnection(
  manager: SSHConnectionManager,
  command: string,
  stdin?: string,
  maxBytes: number = 8192,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
```

and inside, replace both `DEFAULT_TIMEOUT` uses with `timeoutMs`. All existing
callers pass four arguments or fewer, so their behavior is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/tmux-session.test.ts`
Expected: PASS, 10 cases. If `keeps the working directory between calls` fails
with `/config` or `/home/test` instead of `/tmp`, the session is being recreated
between calls — check that `tmuxSession` is threaded through and that
`has-session` is not failing silently by running
`docker compose exec ssh tmux ls`.

- [ ] **Step 6: Verify the untouched paths still pass**

Run: `npm test -- test/persistent-connection.test.ts test/smoke.ssh.test.ts`
Expected: PASS. These exercise the stateless path and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts docker-compose.yml test/tmux-session.test.ts
git commit -m "feat(tmux): execute commands in a persistent remote session"
```

---

### Task 6: Wire the tools, flags and descriptions

**Files:**
- Modify: `src/index.ts` (config block `:46-94`, `exec` tool `:563`, `sudo-exec` tool `:634`)
- Modify: `test/description.test.ts`
- Test: `test/tmux-tools.test.ts`

**Interfaces:**
- Consumes: `ensureMode`, `runInTmux`, `jobStatus` from Task 5.
- Produces: the `job_status` MCP tool; a `detach` parameter on `exec`; `--noTmux` and `--tmuxSession` flags.

- [ ] **Step 1: Write the failing tests**

Create `test/tmux-tools.test.ts`, modelled on the spawn helper in
`test/description.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const serverPath = join(process.cwd(), 'build', 'index.js');

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

// Starts the server, sends one JSON-RPC request, returns the response.
function rpc(method: string, params: any, extraArgs: string[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath, '--host=127.0.0.1', '--user=test', ...extraArgs], {
      env: { ...process.env, SSH_MCP_TEST: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 10000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) { clearTimeout(timer); child.kill(); resolve(msg); }
        } catch { /* partial line */ }
      }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
  });
}

describe('tool surface', () => {
  it('exposes job_status alongside exec and sudo-exec', async () => {
    const res = await rpc('tools/list', {});
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toContain('exec');
    expect(names).toContain('sudo-exec');
    expect(names).toContain('job_status');
  }, 20000);

  it('tells the agent that state persists, so it can rely on cd', async () => {
    const res = await rpc('tools/list', {});
    const exec = res.result.tools.find((t: any) => t.name === 'exec');
    expect(exec.description).toMatch(/persist/i);
    expect(exec.description).toMatch(/working directory|cd/i);
  }, 20000);

  it('offers detach on exec', async () => {
    const res = await rpc('tools/list', {});
    const exec = res.result.tools.find((t: any) => t.name === 'exec');
    expect(Object.keys(exec.inputSchema.properties)).toContain('detach');
  }, 20000);

  it('drops job_status when tmux is disabled', async () => {
    const res = await rpc('tools/list', {}, ['--noTmux']);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).not.toContain('job_status');
  }, 20000);

  it('rejects an invalid tmux session name at startup', async () => {
    await expect(rpc('tools/list', {}, ['--tmuxSession=bad name'])).rejects.toThrow();
  }, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npm test -- test/tmux-tools.test.ts`
Expected: FAIL — `job_status` is absent from the tool list.

- [ ] **Step 3: Add the config flags**

In the config block of `src/index.ts` (after `KEY` at `:53`):

```typescript
const NO_TMUX = argvConfig.noTmux !== undefined || process.env.SSH_MCP_NO_TMUX === '1';
const TMUX_SESSION = argvConfig.tmuxSession ?? process.env.SSH_MCP_TMUX_SESSION ?? DEFAULT_TMUX_SESSION;
```

In `validateConfig` (`src/index.ts:96`), add:

```typescript
  if (config.tmuxSession !== undefined && config.tmuxSession !== null) {
    try { assertSessionName(config.tmuxSession); } catch (e: any) { errors.push(e.message); }
  }
```

Import `assertSessionName` alongside the other `./tmux.js` imports.

- [ ] **Step 4: Thread the config into both connection managers**

Both tool handlers build an `SSHConfig` (`src/index.ts:577` and
`src/index.ts:647`). Add these two fields to each:

```typescript
              noTmux: NO_TMUX,
              tmuxSession: TMUX_SESSION,
```

- [ ] **Step 5: Branch the exec tool**

Replace the `exec` tool registration body from `src/index.ts:599`
(`await connectionManager.ensureConnected();`) through the `return result;`
at `:624` with:

```typescript
          await connectionManager.ensureConnected();
          const mode = await ensureMode(connectionManager);

          const commandWithDescription = description
            ? `${sanitizedCommand} # ${sanitizeDescription(description)}`
            : sanitizedCommand;

          if (mode === 'tmux') {
            return await runInTmux(connectionManager, commandWithDescription, {
              kind: 'exec',
              detach,
              maxBytes: resolveMaxBytes(maxBytes),
            });
          }

          // su and stateless modes keep the existing behavior verbatim.
          if (detach) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              'detach requires tmux mode; it is unavailable with --suPassword or --noTmux',
            );
          }

          if ((connectionManager as any).getSuPassword && (connectionManager as any).getSuPassword()) {
            try {
              await Promise.race([
                (connectionManager as any).ensureElevated(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Elevation timeout')), 5000)),
              ]);
            } catch (err) {
              // Fall back to non-elevated execution if elevation times out.
            }
          }

          return await execSshCommandWithConnection(
            connectionManager,
            commandWithDescription,
            undefined,
            resolveMaxBytes(maxBytes),
          );
```

Update the `exec` schema and description:

```typescript
server.registerTool("exec", {
  description:
    "Execute a shell command on the remote SSH server and return the output. " +
    "Shell state persists between calls: the working directory set with cd and " +
    "variables set with export remain in effect for subsequent commands. " +
    "Use detach for long-running work and collect it with job_status.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute on the remote SSH server"),
    description: z.string().optional().describe("Optional description of what this command will do"),
    detach: z.boolean().optional().describe("Run in the background and return a jobId immediately; collect with job_status"),
    maxBytes: z.number().int().optional().describe("Max output bytes before head+tail truncation; 0 disables. Defaults to server config."),
  }),
}, async ({ command, description, detach, maxBytes }) => {
```

- [ ] **Step 6: Branch the sudo-exec tool**

In `sudo-exec`, immediately after `await connectionManager.ensureConnected();`
(`src/index.ts:670`) insert:

```typescript
                const mode = await ensureMode(connectionManager);
```

and immediately before the `if (connectionManager.isRootShell())` check
(`src/index.ts:697`) insert:

```typescript
                // In tmux mode a passwordless sudo runs inside the session, so it
                // inherits the working directory. With a password it cannot: sudo -S
                // needs a private stdin, and the session's stdin is the shared pane.
                if (mode === 'tmux' && !connectionManager.getSudoPassword()) {
                  return await runInTmux(connectionManager, commandWithDescription, {
                    kind: 'sudo',
                    maxBytes: resolveMaxBytes(maxBytes),
                  });
                }
```

- [ ] **Step 7: Register the job_status tool**

After the `sudo-exec` registration block (`src/index.ts:719`):

```typescript
// Only meaningful in tmux mode, which is also the only mode that can produce a
// jobId, so the tool is hidden when tmux is disabled. The su check mirrors the
// one at src/index.ts:593: a bare --suPassword flag resolves to null and does
// NOT enable su mode, so only a non-null value disables tmux here.
const SU_ACTIVE = SUPASSWORD !== null && SUPASSWORD !== undefined;
if (!NO_TMUX && !SU_ACTIVE) {
  server.registerTool("job_status", {
    description:
      "Check a background job started with exec(detach: true). While running it " +
      "returns the elapsed time and the tail of the output; once finished it " +
      "returns the full output and exit code, and frees the job.",
    inputSchema: z.object({
      jobId: z.string().describe("The jobId returned by exec with detach: true"),
      maxBytes: z.number().int().optional().describe("Max output bytes before head+tail truncation; 0 disables."),
    }),
  }, async ({ jobId, maxBytes }) => {
    if (!connectionManager) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'No active connection; run exec first');
    }
    await connectionManager.ensureConnected();
    await ensureMode(connectionManager);
    return await jobStatus(connectionManager, jobId, resolveMaxBytes(maxBytes));
  });
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm run build && npm test -- test/tmux-tools.test.ts test/description.test.ts`
Expected: PASS. `test/description.test.ts` may assert on the old `exec`
description text — update those assertions to match the new wording rather than
reverting the description.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS. Report any failure with its output rather than adjusting the
test to match the code.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts test/tmux-tools.test.ts test/description.test.ts
git commit -m "feat(tmux): wire tools, flags and job_status"
```

---

### Task 7: Documentation and release

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Bump the version**

In `package.json`, set `"version": "2.0.0"`. Also update the hardcoded server
version at `src/index.ts:553` (`version: '1.5.0'`) to `'2.0.0'`.

- [ ] **Step 2: Document the feature in README.md**

Add a section after the existing configuration table covering:

- Shell state (`cd`, `export`) persists between tool calls, backed by a tmux
  session named `ssh-mcp` on the remote host.
- tmux is required. Without it, calls fail with an install command rather than
  running statelessly, so the agent can never assume state that is not there.
- `--noTmux` / `SSH_MCP_NO_TMUX=1` restores the 1.x per-command behavior.
- `--tmuxSession=<name>` / `SSH_MCP_TMUX_SESSION` isolates two servers running
  as the same user on the same host. Names must match `^[A-Za-z0-9_-]+$`.
- `--suPassword` takes precedence and disables tmux; the `su -` path is unchanged.
- `exec(detach: true)` returns a jobId; `job_status(jobId)` collects it. Jobs
  survive an MCP server restart because the working directory is stored in the
  tmux session.
- `sudo-exec` **without** a password runs inside the session and sees the
  current working directory; **with** a password it runs on a separate channel
  and starts from the login directory, because `sudo -S` needs a private stdin.
- Commands serialize through one remote shell; `detach` is the escape hatch.
- `tmux attach -t ssh-mcp` on the remote host shows the live session.
- Recovery from a poisoned session: `tmux kill-session -t ssh-mcp`; the next
  command rebuilds it.

Add a "Breaking changes in 2.0.0" subsection listing: tmux now required by
default, `exec` gains `detach`, `job_status` is new.

- [ ] **Step 3: Verify the build and full suite**

Run: `npm run build && npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json src/index.ts
git commit -m "docs: document tmux-backed persistent sessions; release 2.0.0"
```

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin feat/tmux-persistent-session
gh pr create --title "feat: tmux-backed persistent remote sessions (2.0.0)" --body "$(cat <<'EOF'
## What

Shell state (`cd`, `export`) now persists across MCP tool calls. The remote
shell lives in a tmux session on the target host instead of being recreated per
command.

## Why

Measured on a live host: the SSH connection was already being reused, but every
call opened a new channel, so the shell PID changed, the working directory reset
to `$HOME`, and exported variables vanished.

## Approach

tmux rather than a persistent PTY channel. Keeping the session on the remote host
means each call still uses a short-lived `conn.exec()` channel, which preserves
stdout/stderr separation, unwrapped long lines, and the existing exit-code path —
all of which a shared PTY destroys.

Design: `docs/superpowers/specs/2026-08-16-tmux-persistent-session-design.md`
Plan: `docs/superpowers/plans/2026-08-16-tmux-persistent-session.md`

## Breaking changes

- tmux is required on the remote host. Without it, calls fail with an install
  command instead of silently running statelessly.
- `--noTmux` restores the 1.x per-command behavior.
- New `job_status` tool and `detach` parameter on `exec`.

## Trade-offs

- Commands serialize through one remote shell. `detach` is the escape hatch.
- `sudo-exec` with a password still runs on a separate channel and does not see
  the session's working directory: `sudo -S` needs a private stdin.
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: Architecture → 1; Mode
resolution → 4, 6; Preflight → 2, 5; Command flow → 1, 5; Working directory
security → 1; Background jobs → 3, 5, 6; sudo handling → 6; Injection surface →
1, 5; Error handling → 5; Impact on existing code → 4, 5, 6, 7; Testing → 1-6;
Accepted trade-offs → 7.

**Known deviations from the spec**, both recorded above:
1. `probeTmux`/`runInTmux` live in `src/index.ts`, not `src/tmux.ts`, to avoid a
   circular import and keep the new module pure.
2. `execSshCommandWithConnection` gains an optional fifth parameter `timeoutMs`.
   The spec did not mention it; the timeout-recovery test needs a short timeout
   without a 60-second wait. Existing callers are unaffected.

**Type consistency.** `TmuxMode`, `TmuxProbe`, `JobStatus`, and
`RunScriptOptions` are defined in Tasks 1-3 and used with the same names and
shapes in Tasks 4-6. `getTmuxSession()`, `getProbe()`, `resolveMode()`, and
`resetMode()` are declared in Task 4 and called in Task 5. `runInTmux`,
`jobStatus`, and `ensureMode` are declared in Task 5 and called in Task 6.

**Not covered, by design** (spec "Follow-ups"): FIFO sudo password delivery,
`job_list`, named parallel sessions.
