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
    // $D is interpolated into a single-quoted context in the send-keys payload
    // below; a literal quote in TMPDIR would break out of it, which is why this
    // guard exists. Spaces and double quotes are rejected too out of caution,
    // though single quotes actually preserve them literally with no break.
    // The guard runs here, before set-environment, so a bad path is discarded
    // before it can be persisted: once nothing bad can ever be stored, any path
    // recovered later from show-environment is one that already passed this
    // check, and no second guard is needed outside the `if`.
    '  case "$D" in *[\\\'\\"\\ ]*) echo "ssh-mcp: unsafe workdir path: $D" >&2; exit 78;; esac',
    `  tmux set-environment -t ${session} SSH_MCP_DIR "$D"`,
    'fi',
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

export interface TmuxProbe {
  tmux: string | null;  // version string, e.g. "tmux 3.4"
  pm: string | null;    // detected package manager, only when tmux is missing
}

// Runs over the plain conn.exec() channel — the path that already exists — so
// the probe never depends on the feature it is probing for. The package manager
// is detected in the same round trip to keep the failure message copy-pasteable.
export function buildProbeScript(): string {
  return [
    `printf '\\n'`,
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
