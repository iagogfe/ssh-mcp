# Persistent remote sessions backed by tmux

Date: 2026-08-16
Status: approved design, not yet implemented
Target version: 2.0.0

## Problem

Every tool call runs its command in a fresh remote shell, so no state survives
between calls. An agent that runs `cd /var/log` and then `tail syslog` finds
itself back in `$HOME` for the second command.

Measured on a live host (`192.168.1.27`, three consecutive `exec` calls):

| Observation | Evidence |
|---|---|
| The SSH connection *is* reused | `sshd: worker [priv]` stayed PID 1601482 across calls |
| The shell is new every call | shell PID went 1601552 → 1601573 |
| Working directory resets | `cd /tmp` in call 1; call 2 reported `/home/worker` |
| Environment is lost | `export FOO=bar` in call 1; call 2 reported `foo=[]` |

The cause is `conn.exec()` in `execSshCommandWithConnection` (`src/index.ts:796`):
each call opens a new SSH channel, sshd forks a session, and the shell dies when
the channel closes. PAM therefore also logs a session open/close per command.

The connection layer needs no work — `SSHConnectionManager` already keeps one
`ssh2.Client` alive for the process lifetime. Only shell state is missing.

## Goals

- `cd`, `export`, shell functions, and history persist across tool calls.
- Exit code, stdout, and stderr stay exactly as accurate as they are today.
- Long-running work (deploy, build) does not block the agent.
- A human can attach to the live session and watch what the agent is doing.

## Non-goals

- Parallel command execution within one host. Commands serialize through a
  single remote shell. Accepted; see "Accepted trade-offs".
- Multiple named sessions per host. One fixed session, agent-invisible.
- Feeding a sudo password into the tmux session. See "sudo handling".
- Job enumeration (`job_list`). The agent holds the ids it created.

## Why tmux rather than a persistent PTY channel

The rejected alternative was to keep one `conn.shell()` PTY open and fence each
command with sentinel markers — the mechanism `ensureElevated()` already
implements for `su -` (`src/index.ts:428-520`, consumed at `src/index.ts:748-792`).

tmux moves the session state out of the SSH channel and onto the remote host.
Each tool call therefore keeps using a short-lived `conn.exec()` channel, which
preserves three properties a shared PTY destroys:

| Property | Persistent PTY | tmux |
|---|---|---|
| stdout separated from stderr | lost — a PTY merges them; the su branch already hardcodes `stderr: ''` (`src/index.ts:784`) | preserved |
| Long lines intact | broken — `cols: 80` wraps them (`src/index.ts:443`) | preserved |
| An interactive command (`top`, `vim`) wedges… | the whole connection | only that tmux window |
| State survives an MCP server restart | no | yes |
| A human can watch it live | no | `tmux attach -t ssh-mcp` |

The cost is a hard dependency on tmux at the remote end, one extra round trip of
polling latency (~100 ms), and temporary files under `/tmp`.

## Architecture

One new module, `src/tmux.ts`:

| Export | Purpose |
|---|---|
| `probeTmux(manager)` | Runs the preflight over `conn.exec()`; returns `{ tmux: string \| null, pm: string \| null }` |
| `installHint(pm, host)` | Builds the operator-facing "install tmux" message |
| `buildRunScript(opts)` | Returns the shell script for one command. Pure |
| `buildJobStatusScript(opts)` | Returns the shell script for `job_status`. Pure |
| `runInTmux(manager, command, opts)` | Calls the existing `execSshCommandWithConnection` with the built script |

`src/index.ts` is already 954 lines and carries argv parsing, config, host key
verification, connection management, tool registration, and command execution.
No new responsibility is added to it: `exec` and `sudo-exec` gain a mode branch,
and two job tools are registered. Everything tmux-specific lives in `src/tmux.ts`.

The script builders are pure string functions. This matters for testing: nearly
every existing test needs a live SSH server, whereas the new logic is unit
testable in milliseconds.

## Mode resolution

Resolved once per connection, in this order. The first match wins.

1. `--suPassword` set → **su mode**. The existing `su -` PTY path runs unchanged
   and tmux is disabled. Elevating with `su` inside tmux hits the same
   password-in-a-PTY problem already documented at `src/index.ts:692`. The
   preflight does not run.
2. `--noTmux` (or `SSH_MCP_NO_TMUX=1`) → **stateless mode**. Today's behavior.
   The preflight does not run.
3. Otherwise → run the preflight.
   - tmux found → **tmux mode**.
   - tmux missing → **blocked mode**. Every `exec` and `sudo-exec` call fails
     with the install guidance. Nothing executes on the remote host.

`--tmuxSession=<name>` (`SSH_MCP_TMUX_SESSION`, default `ssh-mcp`) prevents two
MCP servers running as the same user on the same host from sharing state
unintentionally.

The probe result is cached on the manager and re-run if the connection drops and
reconnects.

## Preflight

Runs once per connection over `conn.exec()` — the existing code path, untouched.
It detects the package manager in the same round trip so the failure message is
copy-pasteable rather than generic.

```sh
if command -v tmux >/dev/null 2>&1; then
  printf 'tmux=%s\n' "$(tmux -V)"
else
  printf 'tmux=\n'
  for m in apt-get apk dnf yum pacman zypper; do
    command -v "$m" >/dev/null 2>&1 && { printf 'pm=%s\n' "$m"; break; }
  done
fi
```

Message on failure:

```
tmux não encontrado em <host>.
Sessão persistente (cd/export entre comandos) precisa de tmux no host remoto.

  sudo apt-get install -y tmux

Ou rode sem estado: --noTmux
```

Package manager mapping: `apt-get`, `dnf`, `yum`, `zypper` → `<pm> install -y tmux`;
`apk` → `apk add tmux`; `pacman` → `pacman -S --noconfirm tmux`. When none is
detected, the message omits the command line and says to install tmux by
whatever means the host provides.

The failure is raised as a `ProtocolError` with code `InvalidParams`, because the
condition is a configuration problem the operator must fix, not a transient
internal fault.

## Command flow

One `conn.exec()` per tool call. The user's command arrives over the channel's
stdin and is never interpolated into a shell string.

```sh
set -eu
tmux has-session -t <session> 2>/dev/null || tmux new-session -d -s <session>
D=$(tmux show-environment -t <session> SSH_MCP_DIR 2>/dev/null | sed -n 's/^SSH_MCP_DIR=//p')
[ -n "$D" ] && [ -d "$D" ] || {
  D=$(mktemp -d "${TMPDIR:-/tmp}/ssh-mcp.XXXXXXXX")
  tmux set-environment -t <session> SSH_MCP_DIR "$D"
}
find "$D" -type f -mtime +7 -delete 2>/dev/null || true
T='<token>'
cat > "$D/cmd.$T"
tmux send-keys -t <session> "<payload>" Enter
# --- collect block: blocking calls only, omitted when detach is set ---
while [ ! -s "$D/rc.$T" ]; do sleep 0.1; done
cat "$D/out.$T"
cat "$D/err.$T" >&2
RC=$(cat "$D/rc.$T")
rm -f "$D"/*."$T"
exit "$RC"
```

With `detach` set, everything from the collect block down is omitted: the script
ends after `send-keys` and exits 0, and `runInTmux` returns the token as the
`jobId`. Waiting there would defeat the point of detaching.

stdout, stderr, and the exit code return through the channel machinery that
already exists (`src/index.ts:814-821`), so `formatCommandResult` needs no
change. There is no sentinel parsing, no ANSI stripping, and no line-width
handling, because no PTY sits between the command and the result.

`<token>` is generated by `SSHConnectionManager.nextToken()` (`src/index.ts:316`),
which is already monotonic per manager.

### Payload per tool

| Tool | Payload sent to `send-keys` |
|---|---|
| `exec` | `. '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo $? > '$D/rc.$T'` |
| `exec` with `detach` | `date +%s > '$D/start.$T'; { . '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo $? > '$D/rc.$T'; } &` |
| `sudo-exec`, no password | `sudo -n sh '$D/cmd.$T' > '$D/out.$T' 2> '$D/err.$T'; echo $? > '$D/rc.$T'` |

`exec` uses `.` (not `source`, which is a bashism — the tmux shell may be `dash`)
so that `cd` and `export` mutate the session shell. `sudo-exec` uses `sudo -n sh`,
which inherits the session's working directory but runs in a subprocess, so root
cannot mutate the unprivileged session's state.

The detached form backgrounds a subshell, returning the session shell to its
prompt immediately. Without this, a ten-minute deploy would block every
subsequent `send-keys` behind it.

### Why `-s` and not `-f`

`[ ! -f "$D/rc.$T" ]` would stop looping in the window between the redirect
creating the file and `echo` writing to it, and the subsequent `cat` would read
an empty exit code. `-s` requires the file to be non-empty.

### Why bootstrap runs on every command

`has-session || new-session` costs one process and makes the session
self-healing: if a human or a reboot kills it, the next command recreates it.
State is lost in that case but the server never becomes unusable.

## Working directory security

A predictable path such as `/tmp/ssh-mcp-$(id -u)` is attackable on a
multi-user host: another user can pre-create it as a symlink and redirect the
output writes. The design therefore uses `mktemp -d`, which creates the
directory atomically, with mode 700, under an unpredictable name.

The path is stored inside the tmux session with `tmux set-environment`, which
serves two purposes: it is recovered on every command without a second probe,
and it survives an MCP server restart — which is what keeps `jobId` values valid
across restarts.

A `[ -O "$D" ]` ownership test was considered and rejected: `-O` is not in POSIX
`test` and `dash` does not guarantee it. `mktemp -d` removes the need for the
check.

Stale files are pruned at bootstrap with `find "$D" -type f -mtime +7 -delete`,
covering jobs whose results were never collected.

## Background jobs

```
exec(command, detach: true)  → { jobId }, returns immediately
job_status(jobId)            → running (with partial output) | final result
```

`jobId` is the token. Combined with the workdir living in the tmux session, a
job started before an MCP server restart is still collectable afterwards.

A detached `exec` returns a single text block naming the id and how to collect
it, so the id survives in the agent's transcript:

```
[detached] jobId=k7z — collect with job_status("k7z")
```

`job_status` always exits 0 and emits a status line as the first line of stdout,
which `src/tmux.ts` parses and strips:

```
SSH_MCP_JOB running <elapsed-seconds>
SSH_MCP_JOB done <exit-code>
```

The status must not be carried on the script's exit code: when the job is done
the script would have to exit with the user's exit code, so a user command
exiting 75 would be indistinguishable from a "still running" sentinel of 75. The
first-line marker has no such collision, because the marker is written before
any user output.

While running, `job_status` returns the elapsed time plus `tail -c 2000` of each
stream, so an agent can follow a build. When done it returns the full result
through `formatCommandResult` and deletes the job's files.

An unknown `jobId` — no `start.$T` file — is reported as an error rather than as
a job that is still running.

## sudo handling

| Case | Path | Sees the session `cwd` |
|---|---|---|
| `sudo-exec`, no `sudoPassword` | tmux session, `sudo -n sh` | yes |
| `sudo-exec`, `sudoPassword` set | today's `conn.exec()` channel | no |
| Any command in su mode | today's `su -` PTY | n/a |

`sudo -S` needs a private stdin to receive the password. The tmux session's
stdin is the shared pane, so writing the password there would echo it into the
session and race with sudo's prompt. Passing it over a FIFO is possible and is
recorded as a follow-up, not built now: none of the four MCP servers currently
configured use `sudoPassword` (three pass `--disableSudo`, and the fourth
connects as root).

This asymmetry is documented in the README so the behavior is not surprising.

## Injection surface

Today `sudo-exec` builds a shell string by hand:

```js
wrapped = `sudo -n sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
```

(`src/index.ts:703`, and the same pattern at `src/index.ts:712`.)

Under tmux mode the user's command travels over stdin into `cmd.$T` and is only
ever referenced by path. The `send-keys` payload is a fixed template whose only
variables are the server-generated token and the `mktemp` path. Manual quote
escaping disappears from the tmux path.

The existing `sanitizeCommand` and `sanitizeDescription` guards
(`src/index.ts:111`, `src/index.ts:148`) remain in place unchanged.

## Error handling

| Situation | Behavior |
|---|---|
| Command exceeds `--timeout` (default 60 s) | `tmux send-keys -t <session> C-c`, collect whatever landed, report the timeout. The session stays usable |
| tmux session killed between calls | Recreated on the next command; state lost, a warning is emitted on stderr |
| Workdir removed by tmpwatch | Recreated, `set-environment` updated |
| tmux absent | Blocked mode; every call fails with the install guidance |
| `/tmp` full | `rc` never appears, so the call ends in the timeout path |
| Unknown `jobId` | Error, distinct from "running" |

The timeout path is a behavioral improvement over the persistent-PTY
alternative, where a wedged command poisons the connection for every subsequent
call. Here the blast radius is one tmux window, and a human can `tmux attach` to
recover it by hand.

## Impact on existing code

| File | Change |
|---|---|
| `src/tmux.ts` | New |
| `src/index.ts` | Mode resolution in `connect()`; branch in `exec`/`sudo-exec`; register `job_status`; add `detach` to the `exec` schema; new flags |
| `src/output.ts` | None |
| `docker-compose.yml` | Add tmux to the test fixture |
| `README.md` | New section on persistent sessions; document the flags and the sudo asymmetry |
| `package.json` | 1.5.0 → 2.0.0 |

The `exec` tool description must state that state persists between calls,
otherwise the agent has no way to know it can rely on `cd`. `test/description.test.ts`
asserts on tool descriptions and will need updating.

`execSshCommandWithConnection`, `formatCommandResult`, `parseMaxBytes`, the host
key verification helpers, and the `su -` path are unchanged.

## Testing

Unit, no SSH server required — the new capability, since almost all current
tests need a live host:

- `buildRunScript` quotes the workdir path in every expansion.
- `buildRunScript` output never contains the user's command text.
- The `detach` variant backgrounds the subshell and writes `start.$T`.
- `sudo-exec` without a password builds `sudo -n sh`, not `.`.
- `buildJobStatusScript` emits the `SSH_MCP_JOB` marker before any user output.
- Two calls to `nextToken()` produce different scripts.
- `installHint` maps each package manager to the right command, and degrades
  when none is detected.

Integration, against `docker-compose.yml` with tmux installed via
`DOCKER_MODS=linuxserver/mods:universal-package-install` and
`INSTALL_PACKAGES=tmux`:

- `cd /tmp` then `pwd` returns `/tmp`.
- `export FOO=bar` then `echo $FOO` returns `bar`.
- `echo $$` returns the same PID across calls.
- A command exiting 10 reports exit code 10.
- stderr arrives separated from stdout.
- A 500-character line survives unwrapped.
- A command that times out does not contaminate the next command's output.
- `detach` returns a jobId; `job_status` reports running, then done with the
  correct exit code.
- With tmux removed, the first call fails with the install guidance and nothing
  runs on the remote.

## Accepted trade-offs

1. **Commands serialize.** One remote shell means `parallel` tool calls queue.
   `test/persistent-connection.test.ts:120` covers concurrency and must keep
   passing on correctness; it will be slower. Detached jobs are the escape hatch
   for work that would otherwise block the queue.
2. **State contamination is possible.** `export PATH=/nada` breaks every later
   command. That is the price of persistence. Recovery is
   `tmux kill-session -t ssh-mcp`, and the next command rebuilds it.
3. **Breaking change.** `@iagogfe/ssh-mcp` is published at 1.5.0; existing users
   get different behavior on upgrade, and a host without tmux now fails instead
   of running. Hence 2.0.0.
4. **tmux is required.** Deliberately not a silent fallback: an agent that
   believes state persisted when it did not produces worse failures than an
   explicit error.

## Follow-ups, not in scope

- FIFO-based sudo password delivery, so `sudo-exec` with a password also sees
  the session's working directory.
- `job_list`, for recovering job ids after an MCP server restart.
- Named sessions with an optional `session` parameter, restoring parallelism.
