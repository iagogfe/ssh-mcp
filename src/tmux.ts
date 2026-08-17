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
    // Idempotent, not check-then-act: `has-session || new-session` races two
    // concurrent cold calls (normal under MCP, which issues parallel tool
    // calls) -- both see no session, both attempt new-session, and the loser
    // gets tmux's own "duplicate session" error, which `set -eu` turns into a
    // hard failure of the whole script. Attempting the create FIRST removes
    // the gap: the loser's new-session fails harmlessly (2>/dev/null) because
    // the winner already made the session, and has-session in the else branch
    // then confirms it exists either way. A genuine failure (tmux cannot
    // start a session at all) still fails both commands -- has-session is the
    // last command run in that case, so `set -e` still aborts on it.
    //
    // The `if` form also makes creation OBSERVABLE, not just idempotent: only
    // the call that actually created a fresh session -- the winner of a
    // cold-start race, or any call after the session was killed (an operator
    // running `tmux kill-session`, a host reboot) -- prints a warning. Every
    // other call, including the losers of that race, stays silent, exactly as
    // before. Without this, a killed session is recreated and used as if
    // nothing happened: the next command runs in $HOME instead of wherever a
    // prior `cd` left it, and reports success.
    `if tmux new-session -d -s ${session} 2>/dev/null; then`,
    `  echo "ssh-mcp: started a fresh tmux session; any previous shell state is gone" >&2`,
    'else',
    `  tmux has-session -t ${session}`,
    'fi',
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
    // Reclaim workdirs left behind by sessions that are gone. The per-workdir
    // prune below only ever sees the live session's own directory, so a dir
    // whose session died is never touched again -- 60 had accumulated in /tmp on
    // one host. A directory's mtime moves on every command that creates or
    // removes a token file, so 7 days without one means nothing has used it for
    // a week; a session idle that long simply gets its workdir recreated on the
    // next command by the `[ ! -d "$D" ]` check above. This runs only when a new
    // workdir is created -- rare, and the same event that produces the litter --
    // because scanning /tmp on every command would cost latency for nothing.
    `  find "\${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'ssh-mcp.*' -mtime +7 -exec rm -rf {} + 2>/dev/null || true`,
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
  //
  // The exec body sources the command (`.`) rather than running it as a
  // subprocess, so `cd`/`export` mutate the persistent pane shell instead of a
  // throwaway one. But `.` runs in the CURRENT shell: if the command calls the
  // real `exit` builtin, POSIX has that terminate the pane shell itself — and
  // since it's the session's only pane, tmux tears the whole session down with
  // it, wedging every later call.
  //
  // A shell *function* named `exit` cannot fix this: `exit` is a POSIX special
  // built-in, so dash refuses to even parse `exit() { ... }` ("Bad function
  // name"); and on bash, `return` inside that function returns from the
  // function's own call frame, not from the sourced script, so execution of
  // the sourced script resumes right after the `exit` call instead of
  // stopping — silently discarding an early-exit guard.
  //
  // An *alias* is different: alias expansion is a textual, parse-time
  // substitution, so `alias exit=return` turns a later `exit N` into a
  // literal `return N`, parsed as if the SAME LINE had written `return`
  // instead. When that line is a top-level statement of the sourced script
  // itself, `return` stops the sourcing (not the pane shell) and reports N as
  // its exit status — matching what an ad-hoc command's caller expects,
  // including inside a subshell or pipeline element (there it just ends that
  // forked subshell, same as real `exit`, because the "currently sourcing"
  // state a POSIX shell tracks is copied into the fork). `shopt -s
  // expand_aliases` makes this correct even if the pane shell is ever invoked
  // non-interactively (bash only expands aliases by default when interactive;
  // dash does not gate on it, and silently ignores the unknown `shopt`
  // builtin). The alias is removed again once the exit code is captured, so
  // it never leaks into a human attaching to the same session. sudo's body
  // runs the command as a real subprocess (`sh`), where `exit` already only
  // ends that subprocess, so it needs neither shadow.
  //
  // KNOWN, ACCEPTED RESIDUAL: "a top-level statement of the sourced script
  // itself" above is load-bearing. If the command *defines its own function*
  // and that function calls `exit` (a `die`/`fail`-style helper is the common
  // idiom -- `die() { echo "$1" >&2; exit 1; }; die boom`), the aliased
  // `return` executes from *inside that function's own call frame*, so it
  // returns from the function, not from the sourced script. Execution
  // continues past the call site with the wrong ($?) status, exactly like the
  // bash-only bug Critical 1 fixed -- verified live on both dash and bash
  // (see test/tmux-session.test.ts). This is not fixed here: fixing it would
  // mean either abandoning `.`-sourcing (losing cd/export persistence, this
  // feature's whole point) or letting `exit` inside a user-defined function
  // kill the pane shell again (worse than a swallowed guard). Verified
  // `\exit`/`command exit` are NOT a safe workaround: bypassing the alias
  // reaches the real builtin, which kills the pane exactly like an
  // unshadowed `exit` would. The only verified-safe form is writing the
  // helper with `return` and checking it at the call site (`die() { echo
  // "$1" >&2; return 1; }; die boom || exit 1`) -- `exit` back at the
  // sourced script's own top level still stops correctly.
  const body =
    kind === 'sudo'
      ? `sudo -n sh '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo \\$? > '$D/rc.$T'`
      : `shopt -s expand_aliases 2>/dev/null; alias exit=return; . '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo \\$? > '$D/rc.$T'; unalias exit 2>/dev/null`;

  // The timestamp write must be atomic: a poll landing between create and
  // write of a direct `>` redirect would see an existing-but-empty start
  // file. Writing to a temp name and renaming into place means start.$T is
  // never observable half-written (rename() is atomic within a directory).
  const payload = detach
    // The job is backgrounded inside a subshell that the pane shell then runs in
    // the FOREGROUND: the subshell exits immediately, so the pane's job table
    // never holds an entry for the real job. Without that, bash announces the
    // completion ("[1]+ Done { shopt -s expand_aliases; ... }") whenever it next
    // reaps it -- and if an unrelated command is running at that moment, the
    // announcement lands in THAT command's stderr, leaking this script's own
    // payload text to the caller. Reproduced 4/4 by detaching a 2 s job and
    // running a 5 s command alongside it.
    ? `date +%s > '$D/start.$T.tmp' && mv '$D/start.$T.tmp' '$D/start.$T'; ( { ${body}; } & )`
    : body;

  const lines = [
    preamble(session),
    `T='${token}'`,
    // Tokens are per-manager-instance random, not globally unique, and the
    // workdir deliberately survives restarts (that's what lets a jobId still
    // resolve after one) -- so a stale file from an old, never-collected run
    // that happened to land on the same token must not be mistaken for this
    // run's own output. Clearing it first means the first write anyone sees
    // is always this run's.
    'rm -f "$D/cmd.$T" "$D/out.$T" "$D/err.$T" "$D/rc.$T" "$D/start.$T"',
    'cat > "$D/cmd.$T"',
    `tmux send-keys -t ${session} "${payload}" Enter`,
  ];

  if (!detach) {
    lines.push(
      // Adaptive poll. A flat `sleep 0.1` made latency bimodal: the command
      // either finished before the first check (~10 ms) or cost a full 100 ms,
      // measured on a live host as medians of 13 ms and 111 ms across two
      // otherwise identical runs. Backing off keeps short commands — the common
      // case — near the floor while a long-running one converges on the old
      // cadence rather than forking `sleep` hundreds of times: on a 3 s command
      // a flat 0.01 spent 2.8x the forks of 0.1, this schedule 1.9x, and past
      // ~1.2 s it costs exactly what 0.1 always did.
      //
      // The loop also has to be able to GIVE UP. Its only exit used to be the
      // rc file appearing -- but nothing writes that once the tmux session or
      // the workdir is gone, and by then the caller has already timed out and
      // abandoned this SSH channel, so nothing kills the loop either. Verified
      // live on a real host: `exec cmd` (replaces the pane shell),
      // `tmux kill-session` on its own session, and a command that deletes the
      // workdir (a `/tmp` sweep does it) each left a poller at ppid=1 still
      // spinning minutes later, accumulating for the life of the machine.
      // Ctrl-C recovery cannot rescue these: it writes rc into the very
      // session/workdir that no longer exists.
      //
      // Two guards, priced differently. The workdir test is a shell builtin, so
      // it runs every pass. `tmux has-session` forks, so it waits until the slow
      // tier (~0.6 s in, by which point a fast command has long finished) and
      // then runs every 20th pass, i.e. about every 2 s -- bounding an orphan to
      // seconds while costing ~0.3% of the wait it guards.
      'n=0; while [ ! -s "$D/rc.$T" ]; do n=$((n+1));'
        + ' if [ $n -lt 50 ]; then sleep 0.002;'
        + ' elif [ $n -lt 100 ]; then sleep 0.01;'
        + ' else sleep 0.1; fi;'
        + ' if [ ! -d "$D" ]; then'
        + ' echo "ssh-mcp: the session workdir disappeared while the command was running;'
        + ' its result cannot be collected" >&2; exit 75; fi;'
        + ` if [ $n -ge 100 ] && [ $((n % 20)) -eq 0 ] && ! tmux has-session -t ${session} 2>/dev/null; then`
        + ' echo "ssh-mcp: the tmux session disappeared while the command was running;'
        + ' shell state is gone and the result cannot be collected" >&2; exit 75; fi;'
        + ' done',
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
//
// When the timed-out command's own token is known, this also plants a
// synthetic completion marker for it. Ctrl-C aborts the whole sourced compound
// line (see buildRunScript) *before* it reaches its `echo $? > rc.$T`, so the
// outer channel script that sent that command -- already abandoned by the
// caller after its own timeout, but still alive on the remote host, still
// blocked in `while [ ! -s "$D/rc.$T" ]; do sleep 0.1; done` -- would otherwise
// never see rc.$T appear and would poll forever, leaking a process for the
// life of the remote host. Writing rc.$T here (only if nothing already has:
// a real completion racing in first must win) lets that orphaned poller
// finish its own cleanup and exit normally. 130 is the conventional
// 128+SIGINT exit code.
export function buildInterruptScript(session: string, token?: string): string {
  assertSessionName(session);
  const lines = [`tmux send-keys -t ${session} C-c 2>/dev/null || true`];
  if (token !== undefined) {
    assertToken(token);
    lines.push(
      `D=$(tmux show-environment -t ${session} SSH_MCP_DIR 2>/dev/null | sed -n 's/^SSH_MCP_DIR=//p')`,
      `[ -n "$D" ] && [ ! -s "$D/rc.${token}" ] && { printf '130' > "$D/rc.${token}.tmp" 2>/dev/null && mv "$D/rc.${token}.tmp" "$D/rc.${token}" 2>/dev/null; } || true`,
    );
  }
  return lines.join('\n') + '\n';
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
    `tmux not found on ${host}.`,
    'A persistent session (cd/export across calls) needs tmux on the remote host.',
    '',
  ];
  const cmd = pm ? PM_COMMANDS[pm] : undefined;
  if (cmd) {
    lines.push(`  ${cmd}`, '');
  } else {
    lines.push("  Install tmux with the host's package manager.", '');
  }
  lines.push('Or run stateless (old behavior, no persistent cd/export): --noTmux');
  return lines.join('\n');
}

export const JOB_MARKER = 'SSH_MCP_JOB';

// Delimits the job's own stderr within the status script's single real stdout
// stream (see buildJobStatusScript for why: the job's stderr cannot travel on
// the script's own real stderr, or formatCommandResult reformats an
// otherwise-successful exit-0 status script as if it had failed, mislabeling
// the job's stdout as the script's stderr and appending a bogus [exit 0]).
//
// Unlike JOB_MARKER, this marker can appear anywhere in the job's own stdout,
// not just before it -- so a job printing a bare 'SSH_MCP_JOB_STDERR' line
// would truncate its own stdout there and mislabel everything after it
// (including the real marker) as stderr, recreating the exact bug this
// exists to fix. jobStderrMarker() scopes the marker to the job's own token,
// which carries a random per-manager-instance component (see nextToken()) a
// job cannot predict or forge.
export const JOB_STDERR_MARKER = 'SSH_MCP_JOB_STDERR';

export function jobStderrMarker(token: string): string {
  return `${JOB_STDERR_MARKER}_${token}`;
}

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
    `  printf '\\n${jobStderrMarker(token)}\\n'`,
    '  cat "$D/err.$T"',
    '  rm -f "$D/cmd.$T" "$D/out.$T" "$D/err.$T" "$D/rc.$T" "$D/start.$T"',
    'else',
    // Defense in depth alongside the atomic write in buildRunScript: even if
    // start.$T were ever read empty or non-numeric, this must degrade to
    // "running 0s" rather than crash on arithmetic and skip the marker
    // entirely (`|| true` also keeps `set -e` from aborting on a cat that
    // fails to find the file at all).
    '  S=$(cat "$D/start.$T" 2>/dev/null || true)',
    `  case "$S" in ''|*[!0-9]*) E=0 ;; *) E=$(( $(date +%s) - S )) ;; esac`,
    `  printf '${JOB_MARKER} running %s\\n' "$E"`,
    '  tail -c 2000 "$D/out.$T" 2>/dev/null || true',
    `  printf '\\n${jobStderrMarker(token)}\\n'`,
    '  tail -c 2000 "$D/err.$T" 2>/dev/null || true',
    'fi',
    'exit 0',
  ].join('\n');
}

// Splits the job's own stdout from its own stderr, both carried on the single
// `stdout` string (see jobStderrMarker). The caller's own `token` must match
// the one buildJobStatusScript was built with -- that's what makes the split
// unforgeable by the job's own output (see jobStderrMarker's comment). The
// marker printf always leads with its own newline, so it lands on a clean
// line even when the job's own stdout doesn't end in one -- at the cost of
// one possible extra blank line folded into `stdout` when it already did. A
// missing marker (e.g. a caller that only ever had stdout to begin with)
// degrades to "no stderr" rather than throwing.
export function parseJobStatus(stdout: string, token: string): JobStatus {
  const nl = stdout.indexOf('\n');
  const first = nl === -1 ? stdout : stdout.slice(0, nl);
  const rest = nl === -1 ? '' : stdout.slice(nl + 1);

  const m = first.match(new RegExp(`^${JOB_MARKER} (running|done) (-?\\d+)$`));
  if (!m) {
    throw new Error(`job status marker missing; got ${JSON.stringify(first.slice(0, 80))}`);
  }

  const sep = `\n${jobStderrMarker(token)}\n`;
  const sepIdx = rest.indexOf(sep);
  const jobStdout = sepIdx === -1 ? rest : rest.slice(0, sepIdx);
  const jobStderr = sepIdx === -1 ? '' : rest.slice(sepIdx + sep.length);

  const value = parseInt(m[2], 10);
  return m[1] === 'running'
    ? { state: 'running', elapsedSeconds: value, exitCode: null, stdout: jobStdout, stderr: jobStderr }
    : { state: 'done', elapsedSeconds: null, exitCode: value, stdout: jobStdout, stderr: jobStderr };
}
