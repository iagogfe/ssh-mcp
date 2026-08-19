# SSH MCP Server

[![Release](https://img.shields.io/github/v/release/iagogfe/ssh-mcp)](https://github.com/iagogfe/ssh-mcp/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/iagogfe/ssh-mcp)](./LICENSE)
[![CI](https://github.com/iagogfe/ssh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/iagogfe/ssh-mcp/actions/workflows/ci.yml)
[![Security](https://github.com/iagogfe/ssh-mcp/actions/workflows/security.yml/badge.svg)](https://github.com/iagogfe/ssh-mcp/actions/workflows/security.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**SSH MCP Server** is a local Model Context Protocol (MCP) server that exposes SSH control for Linux and Windows systems, enabling LLMs and other MCP clients to execute shell commands securely via SSH.

This is a fork of [tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp) — see [Credits](#credits).

## Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Installation](#installation)
- [Client Setup](#client-setup)
- [Persistent Sessions](#persistent-sessions)
- [Testing](#testing)
- [Security](#security)
- [Disclaimer](#disclaimer)
- [Credits](#credits)

## Quick Start

- [Install](#installation) SSH MCP Server
- [Configure](#configuration) SSH MCP Server
- [Set up](#client-setup) your MCP Client (e.g. Claude Desktop, Cursor, etc)
- Execute remote shell commands on your Linux or Windows server via natural language

## Features

- MCP-compliant server exposing SSH capabilities
- Two targeting modes: pin one host with `--host`/`--user`, or route by client name with `--clientMap`
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- Built with TypeScript and the official MCP SDK v2 — serves the [2026-07-28 protocol revision](https://modelcontextprotocol.io/specification/2026-07-28) and still accepts 2025-era clients
- **Host key verification on by default** (`known_hosts` or pinned fingerprint)
- **Persistent shell session by default** — `cd`/`export` survive across tool calls, backed by a `tmux` session on the remote host. `--noTmux` restores the old stateless per-command behavior. See [Persistent Sessions](#persistent-sessions).
- **Configurable timeout protection** with automatic process abortion
- **Graceful timeout handling** - attempts to kill hanging processes before closing connections
- **Output truncation** (head+tail per stream) to keep large command output from flooding the model's context

### Tools

By default `exec` and `sudo-exec` run inside a persistent `tmux` session on the remote host, so `cd`/`export` from one call are visible to the next. See [Persistent Sessions](#persistent-sessions) for exactly what does and doesn't persist, and how to opt out with `--noTmux`.

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `client` (optional): Client name from the configured inventory. Omit it when the server is pinned to a single host with `--host`.
    - `command` (required): Shell command to execute on the remote SSH server
    - `description` (optional): Optional description of what this command will do (appended as a comment)
    - `detach` (optional): Run in the background and return a `jobId` immediately instead of waiting; collect the result later with `job_status`. Only available in the persistent tmux session — not with `--suPassword` or `--noTmux`.
    - `maxBytes` (optional): Truncate output to this many bytes. Defaults to the global `--maxOutputBytes` setting. Pass `0` to get full output.
  - **Result format:** On success (exit 0, no stderr) the tool returns the command's stdout only. Otherwise a footer is appended after a `---` separator: `[exit N]` (or `[no exit code]` / `[killed by SIG…]`), followed by stderr when present. The result is marked as an error (`isError`) only when the exit code is non-zero or the process was killed by a signal — stderr alone with exit 0 is shown but is not an error. Large output is truncated in the middle (per stream); pass `maxBytes: 0` (or `--maxOutputBytes=none`) for full output.
  - **Timeout Configuration:**

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `client` (optional): Client name from the configured inventory. Omit it when the server is pinned to a single host with `--host`.
    - `command` (required): Shell command to execute as root using sudo
    - `description` (optional): Optional description of what this command will do (appended as a comment)
    - `maxBytes` (optional): Truncate output to this many bytes. Defaults to the global `--maxOutputBytes` setting. Pass `0` to get full output.
  - **Result format:** On success (exit 0, no stderr) the tool returns the command's stdout only. Otherwise a footer is appended after a `---` separator: `[exit N]` (or `[no exit code]` / `[killed by SIG…]`), followed by stderr when present. The result is marked as an error (`isError`) only when the exit code is non-zero or the process was killed by a signal — stderr alone with exit 0 is shown but is not an error. Large output is truncated in the middle (per stream); pass `maxBytes: 0` (or `--maxOutputBytes=none`) for full output.
  - **Notes:**
    - Requires `SSH_MCP_SUDO_PASSWORD` in the process environment for password-protected sudo
    - Can be disabled by passing the `--disableSudo` flag at startup if sudo access is not needed or not available
    - For persistent root access, set `SSH_MCP_SU_PASSWORD` in the process environment; this establishes a root shell
    - Tool will not be available at all if server is started with `--disableSudo`
  - **Timeout Configuration:**
    - Timeout is configured via command line argument `--timeout` (in milliseconds)
    - Default timeout: 60000ms (1 minute)
    - When a command times out, the server automatically attempts to abort the running process before closing the connection
  - **Max Command Length Configuration:**
    - Max command characters are configured via `--maxChars`
    - Default: `1000`
    - No-limit mode: set `--maxChars=none` or any `<= 0` value (e.g. `--maxChars=0`)

- `job_status`: Check on a background job started with `exec(detach: true)`
  - Only registered when the server is attempting tmux mode (i.e. not `--noTmux` and not `--suPassword`).
  - **Parameters:**
    - `jobId` (required): The `jobId` returned by `exec` with `detach: true`
    - `client` (optional): Client whose session holds the job. Omit it when the server is pinned to a single host.
    - `maxBytes` (optional): Truncate output to this many bytes before head+tail truncation; `0` disables.
  - **Result format:** While the job is still running, returns its elapsed time and a tail of its output so far. Once it has finished, returns the full output and exit code (in the same `[exit N]`/stderr footer format as `exec`) and frees the job's files on the remote host — so a finished job can be collected exactly once; polling it again reports an unknown `jobId`.

## Installation

Requires **Node.js 20 or newer**.

This package is not on npm. Clone and build it, then point your MCP client at
the built entry point:

```bash
git clone https://github.com/iagogfe/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

That produces `build/index.js`, which is what every example below runs with
`node`. Use an absolute path — MCP clients do not necessarily start the server
from the directory you cloned into.

Optionally, `npm link` from the clone puts an `ssh-mcp` command on your `PATH`,
so you can write `ssh-mcp` instead of `node /path/to/ssh-mcp/build/index.js`
everywhere below.

To pick up a new version, pull and rebuild:

```bash
git pull && npm run build
```

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, Claude Desktop to use this MCP Server.

The server runs in one of two modes, and both can be configured at once.

**Single-host mode** (the default) pins the server to one target with `--host` / `SSH_MCP_HOST`. Tools take only `command`; there is no `client` parameter to pass.

**Inventory mode** is opt-in with `--clientMap` / `SSH_MCP_CLIENT_MAP`, pointing at a Markdown inventory. Tools then accept a `client` name, which the server resolves to the first host listed for that client. Matching ignores case, accents, and extra spaces.

With both configured, `--host` is the default target and `client` switches away from it. `--clientMap` has no default path: a relative default would resolve against whatever working directory the MCP client happened to spawn the process in.

**Inventory environment:**

```text
SSH_MCP_USER=<SSH user>
SSH_MCP_PASSWORD=<SSH password>
SSH_MCP_CLIENT_MAP=./config/client-map.md
```

`SSH_MCP_CLIENT_MAP` has no default; without it the server stays in single-host mode. Keep `SSH_MCP_USER` and `SSH_MCP_PASSWORD` only in the MCP process environment; do not place them in command-line arguments, MCP configuration files, Markdown inventories, or logs.

**Optional Parameters:**
- `port`: SSH port (default: 22)
- `password`: SSH password (or use `key` for key-based auth)
- `key`: Path to private SSH key
- `SSH_MCP_SUDO_PASSWORD`: Password for sudo elevation (when executing commands with sudo)
- `SSH_MCP_SU_PASSWORD`: Password for su elevation (when you need a persistent root shell)
- `timeout`: Command execution timeout in milliseconds (default: 60000ms = 1 minute)
- `maxChars`: Maximum allowed characters for the `command` input (default: 1000). Use `none` or `0` to disable the limit.
- `maxOutputBytes`: Truncate command output to this many bytes per stream (head+tail, with a marker). Default: `8192`. Use `none` or `0` to disable.
- `disableSudo`: Flag to disable the `sudo-exec` tool completely. Useful when sudo access is not needed or not available.

**Host Key Verification (defends against man-in-the-middle attacks):**
- `hostFingerprint`: Pin the server's host key fingerprint (e.g. `SHA256:...`, as printed by `ssh-keyscan <host> | ssh-keygen -lf -`). When set, the server connects only if the presented key matches.
- `knownHosts`: Path to a `known_hosts` file used for verification (default: `~/.ssh/known_hosts`).
- `insecureHostKey`: Flag to **disable** host key verification entirely. The connection becomes vulnerable to MITM attacks; only use for throwaway/ephemeral hosts. A warning is printed to stderr when set.

By default the server verifies the host key against your `known_hosts` and **refuses to connect** if the key is unknown. Either add the host to `known_hosts` first (e.g. `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts`), pin it with `--hostFingerprint`, or pass `--insecureHostKey` to opt out.

**Passing secrets via environment variables (recommended):**

To keep credentials out of the process list (`ps`) and out of committed MCP client configs, you can pass secrets through environment variables instead of CLI flags. A CLI flag, when present, always takes precedence over the corresponding variable.

| Variable | Equivalent flag |
|---|---|
| `SSH_MCP_HOST` | `--host` |
| `SSH_MCP_PORT` | `--port` |
| `SSH_MCP_USER` | `--user` |
| `SSH_MCP_PASSWORD` | `--password` |
| `SSH_MCP_KEY_PATH` | `--key` |
| `SSH_MCP_CLIENT_MAP` | `--clientMap` (enables inventory mode) |
| `SSH_MCP_SU_PASSWORD` | `--suPassword` |
| `SSH_MCP_SUDO_PASSWORD` | `--sudoPassword` |
| `SSH_MCP_HOST_FINGERPRINT` | `--hostFingerprint` |
| `SSH_MCP_KNOWN_HOSTS` | `--knownHosts` |
| `SSH_MCP_INSECURE_HOST_KEY=1` | `--insecureHostKey` |
| `SSH_MCP_NO_TMUX=1` | `--noTmux` |
| `SSH_MCP_TMUX_SESSION` | `--tmuxSession` |
| `SSH_MCP_MAX_OUTPUT_BYTES` | `--maxOutputBytes` |
| `SSH_MCP_MAX_CONCURRENT` | `--maxConcurrent` |

`--disableSudo`, `--timeout` and `--maxChars` are flags only; they have no
environment variable.

> ⚠️ **Do not put passwords in a `--scope project` MCP config**, since that writes the secret in plaintext into a `.mcp.json` file that is typically committed to your repository. Prefer SSH keys, environment variables, or `--scope local`/`--scope user`.


Set credentials in the process environment only, never in configuration files. Do not persist them in a shell profile, in `.mcp.json`, in Markdown, or in shared scripts.

Password authentication:

```bash
export SSH_MCP_USER='<SSH user>'
export SSH_MCP_PASSWORD='<SSH password>'
export SSH_MCP_CLIENT_MAP='./config/client-map.md'
node /path/to/ssh-mcp/build/index.js --timeout=30000
```

Key authentication:

```bash
export SSH_MCP_USER='<SSH user>'
export SSH_MCP_CLIENT_MAP='./config/client-map.md'
node /path/to/ssh-mcp/build/index.js --key=/path/to/private/key --timeout=30000
```

Do not set `SSH_MCP_PASSWORD` in the key example: when both a password and a key are configured, the password wins and the key is ignored.

The MCP configuration file should contain only the wrapper command, with no credentials:

```json
{
    "mcpServers": {
        "ssh-mcp": {
            "command": "node",
            "args": ["/path/to/ssh-mcp/build/index.js"]
        }
    }
}
```

Example tool call:

```json
{
  "client": "Client Name",
  "command": "asterisk -rx 'core show version'"
}
```

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp -- node /path/to/ssh-mcp/build/index.js
```

**Installation Examples:**

**With Password Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- node /path/to/ssh-mcp/build/index.js
```

**With SSH Key Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- node /path/to/ssh-mcp/build/index.js --key=/path/to/private/key
```

**With Custom Timeout and No Character Limit:**
```bash
claude mcp add --transport stdio ssh-mcp -- node /path/to/ssh-mcp/build/index.js --timeout=120000 --maxChars=none
```

**With Sudo and Su Support:**
```bash
export SSH_MCP_SUDO_PASSWORD='<sudo password>'
export SSH_MCP_SU_PASSWORD='<root password>'
claude mcp add --transport stdio ssh-mcp -- node /path/to/ssh-mcp/build/index.js
```

`sudo-exec` is exposed by default; there is no variable to turn it on. Pass
`--disableSudo` at startup to hide it. Set only the elevation variable your
flow needs: `SSH_MCP_SUDO_PASSWORD` for password-protected sudo, and
`SSH_MCP_SU_PASSWORD` when the connection should run through a persistent
`su -` root shell. Keep both in the environment of the process that starts
the server.

**Installation Scopes:**

You can specify the scope when adding the server:

- **Local scope** (default): For personal use in the current project
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope local -- node /path/to/ssh-mcp/build/index.js
  ```

- **Project scope**: Share with your team via `.mcp.json` file. ⚠️ This file is usually committed to your repository — **do not embed a password here**. Use an SSH key or the `SSH_MCP_USER`/`SSH_MCP_PASSWORD` process environment instead.
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope project -- node /path/to/ssh-mcp/build/index.js --key=/path/to/private/key
  ```

- **User scope**: Available across all your projects
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope user -- node /path/to/ssh-mcp/build/index.js
  ```


**Verify Installation:**

After adding the server, restart Claude Code and ask it to execute a command:
```
"Can you run 'ls -la' on the remote server?"
```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

## Persistent Sessions

By default, shell state persists between `exec`/`sudo-exec` calls: `cd` changes the working directory and `export`'d variables stay set for later commands against the same destination, so you don't need to chain everything with `&&` or `cd` back into place on every call. Each tool call still opens its own short-lived SSH channel, exactly as before — what changed is that the *shell* those channels talk to now lives in a `tmux` session on the remote host (named `ssh-mcp` by default) instead of being a fresh, throwaway shell every time. The state lives on the remote host, not in the SSH connection.

### tmux is required by default

The server preflights the target host on first use. If `tmux` is missing there, the call fails immediately with an error naming an install command for the detected package manager (`apt-get`, `dnf`, `yum`, `zypper`, `apk`, or `pacman`) rather than silently falling back to per-command execution — so an agent driving the tool can never believe state persisted when it did not.

- `--noTmux` / `SSH_MCP_NO_TMUX=1`: opt out explicitly and restore the pre-2.0 stateless behavior — every call runs in its own shell again; `cd`/`export` do not persist.

### Isolating sessions on a shared host

- `--tmuxSession=<name>` / `SSH_MCP_TMUX_SESSION`: name of the tmux session to attach to or create (default `ssh-mcp`). Set this when two ssh-mcp server instances connect as the same user to the same host, so they get separate shells instead of fighting over one. The name must match `^[A-Za-z0-9_-]+$` (letters, digits, `-`, `_`); an invalid name is rejected at startup, not on the first tool call.

### Mode precedence

The server resolves one mode per connection, in this order:

1. **`--suPassword` / `SSH_MCP_SU_PASSWORD` configured** → `su` mode. This wins outright; the host is not even probed for tmux.
2. **`--noTmux` / `SSH_MCP_NO_TMUX=1`** → stateless mode.
3. Otherwise the host is probed for `tmux`: present → tmux mode; missing → the call fails with the install hint above.

**`su` mode is not the same as stateless.** `--suPassword` opens one long-lived `su -` shell on the connection and runs every `exec`/`sudo-exec` command through it. `cd` and `export` **do** persist there, across calls — just through that shell, not through tmux. Don't lump `su` in with `--noTmux`; only `--noTmux` (or a host with no tmux) is truly stateless.

### `sudo-exec` and session state

`sudo-exec`'s relationship to the session is not symmetric with `exec`'s:

- **tmux mode, passwordless sudo** (no sudo password configured): runs `sudo -n sh` *inside* the tmux session, as a subprocess of the pane's shell. It reads whatever directory a prior `cd` left the session in, but it cannot write back — its own `cd`/`export` die with the subprocess.
- **tmux mode, with a configured sudo password** (`SSH_MCP_SUDO_PASSWORD` / `--sudoPassword`): moves off the session entirely, onto its own separate channel. `sudo -S` needs a private stdin to read the password from, and the shared tmux pane has no per-call stdin to offer. That channel starts from the SSH login directory, not wherever the session's `cd` left off, and nothing it does persists for later calls either.
- **`--noTmux` (stateless mode)**: no session exists at all; every call, `sudo-exec` included, runs in its own throwaway shell.
- **`--suPassword` (su mode)**: has no *tmux* session either, but is not stateless — `sudo-exec` runs the command directly on the same long-lived `su -` shell that `exec` uses, with **no `sudo` wrapper at all** (the shell is already root). `cd`/`export` from that call persist in the su shell for later calls, `exec` or `sudo-exec` alike.

### Background jobs

`exec` accepts `detach: true` (tmux mode only) to start a command in the background and return a `jobId` immediately instead of blocking. Collect it later with `job_status`, which returns the elapsed time and a tail of output while the job is still running, or the full output and exit code once it's done (freeing its files on the remote host at that point). The working directory is stored inside the tmux session's own environment, not in the MCP server process, so a queued or running job survives an MCP server restart. `job_status` is only registered, and `detach` only accepted, when the server is actually attempting tmux mode — neither exists with `--noTmux` or `--suPassword`.

### Commands serialize

A non-detached `exec` call, or a passwordless `sudo-exec` call, sends its command to the tmux pane and waits for it to finish. Because the pane's shell reads and executes one line at a time, two such calls issued in parallel against the same destination queue up on the shared pane and run one after another, not concurrently — a slow command blocks every other synchronous call against that destination until it finishes or times out. `exec(detach: true)` is the escape hatch: a backgrounded command frees the pane immediately, so it doesn't block other calls; poll its result later with `job_status`, which reads the job's result files directly and does not itself wait on the pane.

### Concurrent calls and the channel cap

Serialization above is about the pane. Underneath it, every tool call opens its
own SSH channel, and `sshd` caps those with `MaxSessions` — 10 by default —
refusing the excess with a bare `Channel open failure` that an agent can do
nothing with.

The server holds callers in a client-side queue instead, admitting at most
`--maxConcurrent` (default 8, leaving headroom under the usual 10 for the
elevation shell and an interrupt). Queueing costs nothing here: in tmux mode
the commands would serialize on the pane anyway. A refused open is also
retried, which is safe for that specific error and no other — `sshd` rejects
the session before anything runs, so the command provably never reached the
host and a retry cannot double-execute.

Lower `--maxConcurrent` (or `SSH_MCP_MAX_CONCURRENT`) for a host with a
stricter `MaxSessions`.

### Known limitation: `exit` inside your own function

Commands are sourced into the pane shell (`. '$D/cmd.$T'`, not run as a subprocess) so that `cd`/`export` mutate the persistent shell instead of a throwaway one. To stop a bare top-level `exit` in your command from also killing the whole tmux pane (and wedging the session for every later call), `exit` is aliased to `return` for the duration of the command.

This has one accepted, unfixed residual: if the command **defines its own function** that calls `exit` — a `die`/`fail` helper is the common shape —

```sh
die() { echo "failed" >&2; exit 1; }
die
rm -rf /tmp/x
```

the aliased `return` only returns from *that function's own call frame*, not from the whole sourced script, so execution continues past the call site — and `rm -rf /tmp/x` still runs, on both `dash` and `bash`. Worse, the tool call reports success: the swallowed `exit 1` never reaches the sourced script's own exit code, so the last command that actually ran (`rm -rf /tmp/x`) determines it, and the response comes back with exit 0 and `isError` falsy — nothing distinguishes it from a command whose guard never fired. This is documented, not fixed, in `src/tmux.ts`: fixing it would mean either giving up the sourcing that makes `cd`/`export` persist, or letting `exit` kill the pane shell again, which is worse. The verified workaround is to write the helper with `return` and check it explicitly at the call site:

```sh
die() { echo "failed" >&2; return 1; }
die || exit 1
rm -rf /tmp/x
```

A bare `exit` at the sourced command's own top level (not inside a function you defined) still stops it correctly.

### Recovery

- `tmux attach -r -t ssh-mcp` on the remote host (substitute your `--tmuxSession` name) shows the live session, including any command currently running. Use the read-only `-r` flag: `send-keys` targets the session's current window's active pane, so a writable attach lets a human who switches windows or opens a pager redirect the next `exec`'s payload into it instead of the pane the tool expects.
- A poisoned session — e.g. a command that ran `export PATH=/nada` — is cleared with `tmux kill-session -t ssh-mcp`; the next `exec`/`sudo-exec` call recreates it from scratch.

### Breaking changes in 2.0.0

See [CHANGELOG.md](CHANGELOG.md) for the full release history.

- **tmux is now required by default.** A host without it fails loudly, with an install command, instead of silently running the old stateless per-command behavior. Pass `--noTmux` to opt back into 1.x behavior.
- `exec` gains a `detach` parameter.
- `job_status` is a new tool (tmux mode only).
- The `exec` and `sudo-exec` tool descriptions changed to describe the new session behavior.

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
npm run inspect
```

The test suite needs a throwaway SSH server, which `docker-compose.yml` provides. It also needs `tmux` and `dash` on that server (the tmux-session tests exercise both) — the compose service installs them via `DOCKER_MODS` on first boot, which finishes after the SSH port starts answering, so wait for `tmux -V` to succeed inside the container before running the suite:

```sh
docker compose up -d
until docker compose exec ssh tmux -V >/dev/null 2>&1; do sleep 2; done
SSH_HOST=127.0.0.1 SSH_PORT=2222 SSH_USER=test SSH_PASSWORD=secret npm test
docker compose down
```

## Security

This server executes arbitrary shell commands on a remote host on behalf of an LLM. That is the whole point of it, and it is also its entire risk surface. Before pointing it at anything you care about:

- **Give it its own SSH user** with only the access it needs, not your admin account.
- **Prefer key authentication**, and pass `SSH_MCP_USER`/`SSH_MCP_PASSWORD` through the process environment rather than CLI flags — flags are visible in `ps` output.
- **Leave host key verification on.** `--insecureHostKey` disables the MITM defense and exists only for throwaway hosts.
- **Leave `sudo-exec` off** (`--disableSudo`) unless you need it.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Disclaimer

SSH MCP Server is provided under the [MIT License](./LICENSE). Use at your own risk. This project is not affiliated with or endorsed by any SSH or MCP provider.

## Contributing

We welcome contributions! Please see our [Contributing Guidelines](./CONTRIBUTING.md) for more information.

## Code of Conduct

This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md) to ensure a welcoming environment for everyone.

## Credits

This project is a fork of **[tufantunc/ssh-mcp](https://github.com/tufantunc/ssh-mcp)** by [Tufan Tunç](https://github.com/tufantunc), which is where the SSH MCP server, its tools, and most of this documentation come from. It stays under the same [MIT License](./LICENSE).

This fork adds:

- Migration to the MCP TypeScript SDK v2 and the [2026-07-28 protocol revision](https://modelcontextprotocol.io/specification/2026-07-28)
- Host key verification enabled by default, with `--hostFingerprint` / `--knownHosts` / `--insecureHostKey`
- Optional inventory-based routing through `--clientMap`, with `SSH_MCP_USER`/`SSH_MCP_PASSWORD` credentials from the process environment
- Exit-code-aware tool results and head+tail output truncation (`--maxOutputBytes` / `maxBytes`)
- tmux-backed [persistent shell sessions](#persistent-sessions) with background jobs (`exec(detach: true)` / `job_status`), on by default with `--noTmux` to opt out
