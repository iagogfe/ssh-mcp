# SSH MCP Server

[![NPM Version](https://img.shields.io/npm/v/@iagogfe/ssh-mcp)](https://www.npmjs.com/package/@iagogfe/ssh-mcp)
[![Node Version](https://img.shields.io/node/v/@iagogfe/ssh-mcp)](https://nodejs.org/)
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
- Execute shell commands on remote Linux and Windows systems
- Secure authentication via password or SSH key
- Built with TypeScript and the official MCP SDK v2 — serves the [2026-07-28 protocol revision](https://modelcontextprotocol.io/specification/2026-07-28) and still accepts 2025-era clients
- **Host key verification on by default** (`known_hosts` or pinned fingerprint)
- **Configurable timeout protection** with automatic process abortion
- **Graceful timeout handling** - attempts to kill hanging processes before closing connections
- **Output truncation** (head+tail per stream) to keep large command output from flooding the model's context

### Tools

- `exec`: Execute a shell command on the remote server
  - **Parameters:**
    - `client` (required): Planetfone client name from the configured inventory
    - `command` (required): Shell command to execute on the remote SSH server
    - `description` (optional): Optional description of what this command will do (appended as a comment)
    - `maxBytes` (optional): Truncate output to this many bytes. Defaults to the global `--maxOutputBytes` setting. Pass `0` to get full output.
  - **Result format:** On success (exit 0, no stderr) the tool returns the command's stdout only. Otherwise a footer is appended after a `---` separator: `[exit N]` (or `[no exit code]` / `[killed by SIG…]`), followed by stderr when present. The result is marked as an error (`isError`) only when the exit code is non-zero or the process was killed by a signal — stderr alone with exit 0 is shown but is not an error. Large output is truncated in the middle (per stream); pass `maxBytes: 0` (or `--maxOutputBytes=none`) for full output.
  - **Timeout Configuration:**

- `sudo-exec`: Execute a shell command with sudo elevation
  - **Parameters:**
    - `client` (required): Planetfone client name from the configured inventory
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

## Installation

Requires **Node.js 20 or newer**.

No install step is needed to use the server — MCP clients run it through `npx` (see [Client Setup](#client-setup)). The Planetfone deployment uses the global wrapper at `ssh-mcp`, which starts without a fixed host and reads clients from `client-map.md`:

```bash
npx -y @iagogfe/ssh-mcp -- --disableSudo
```

To hack on it locally:

```bash
git clone https://github.com/iagogfe/ssh-mcp.git
cd ssh-mcp
npm install
npm run build
```

## Client Setup

You can configure your IDE or LLM like Cursor, Windsurf, Claude Desktop to use this MCP Server.

The `exec` and `sudo-exec` tools require both `client` and `command`. The server resolves `client` in the configured Planetfone 4 inventory and selects the first host listed for that client. Matching ignores case, accents, and extra spaces.

**Planetfone environment:**

```text
SSH_MCP_USER=<SSH user>
SSH_MCP_PASSWORD=<SSH password>
SSH_MCP_CLIENT_MAP=./config/client-map.md
```

`SSH_MCP_CLIENT_MAP` defaults to `./config/client-map.md` when the global wrapper is used. Keep `SSH_MCP_USER` and `SSH_MCP_PASSWORD` only in the MCP process environment; do not place them in command-line arguments, MCP configuration files, Markdown inventories, or logs.

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
| `SSH_MCP_USER` | SSH username used for the resolved client host |
| `SSH_MCP_PASSWORD` | SSH password used for the resolved client host |
| `SSH_MCP_CLIENT_MAP` | Path to the Planetfone client/host inventory |
| `SSH_MCP_PORT` | `--port` |
| `SSH_MCP_PASSWORD` | `--password` (legacy/general configuration) |
| `SSH_MCP_KEY_PATH` | `--key` |
| `SSH_MCP_SU_PASSWORD` | `--suPassword` |
| `SSH_MCP_SUDO_PASSWORD` | `--sudoPassword` |
| `SSH_MCP_HOST_FINGERPRINT` | `--hostFingerprint` |
| `SSH_MCP_KNOWN_HOSTS` | `--knownHosts` |
| `SSH_MCP_INSECURE_HOST_KEY=1` | `--insecureHostKey` |

> ⚠️ **Do not put passwords in a `--scope project` MCP config**, since that writes the secret in plaintext into a `.mcp.json` file that is typically committed to your repository. Prefer SSH keys, environment variables, or `--scope local`/`--scope user`.


Defina as credenciais somente no ambiente do processo, fora de arquivos de configuração. Não persista os valores em shell profile, `.mcp.json`, Markdown ou scripts compartilhados.

Exemplo com autenticação por senha:

```bash
export SSH_MCP_USER='<SSH user>'
export SSH_MCP_PASSWORD='<SSH password>'
export SSH_MCP_CLIENT_MAP='./config/client-map.md'
ssh-mcp --timeout=30000
```

Exemplo com autenticação por chave:

```bash
export SSH_MCP_USER='<SSH user>'
export SSH_MCP_CLIENT_MAP='./config/client-map.md'
ssh-mcp --key=/path/to/private/key --timeout=30000
```

Não defina `SSH_MCP_PASSWORD` no exemplo por chave: quando senha e chave estão configuradas, a senha tem precedência e a chave é ignorada.

O arquivo de configuração MCP deve conter somente o comando do wrapper, sem credenciais:

```json
{
    "mcpServers": {
        "ssh-mcp": {
            "command": "ssh-mcp"
        }
    }
}
```

Example tool call:

```json
{
  "client": "Nome do Cliente",
  "command": "asterisk -rx 'core show version'"
}
```

### Claude Code

You can add this MCP server to Claude Code using the `claude mcp add` command. This is the recommended method for Claude Code.

**Basic Installation:**

```bash
claude mcp add --transport stdio ssh-mcp -- ssh-mcp
```

**Installation Examples:**

**With Password Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- ssh-mcp
```

**With SSH Key Authentication:**
```bash
claude mcp add --transport stdio ssh-mcp -- ssh-mcp --key=/path/to/private/key
```

**With Custom Timeout and No Character Limit:**
```bash
claude mcp add --transport stdio ssh-mcp -- ssh-mcp --timeout=120000 --maxChars=none
```

**With Sudo and Su Support:**
```bash
export SSH_MCP_ENABLE_SUDO=1
export SSH_MCP_SUDO_PASSWORD='<sudo password>'
export SSH_MCP_SU_PASSWORD='<root password>'
claude mcp add --transport stdio ssh-mcp -- ssh-mcp
```

Defina apenas a variável de elevação necessária: `SSH_MCP_SUDO_PASSWORD`
para sudo com senha e `SSH_MCP_SU_PASSWORD` quando o fluxo usar `su`.
Mantenha esses valores somente no ambiente do processo que inicia o MCP.

**Installation Scopes:**

You can specify the scope when adding the server:

- **Local scope** (default): For personal use in the current project
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope local -- ssh-mcp
  ```

- **Project scope**: Share with your team via `.mcp.json` file. ⚠️ This file is usually committed to your repository — **do not embed a password here**. Use an SSH key or the `SSH_MCP_USER`/`SSH_MCP_PASSWORD` process environment instead.
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope project -- ssh-mcp --key=/path/to/private/key
  ```

- **User scope**: Available across all your projects
  ```bash
  claude mcp add --transport stdio ssh-mcp --scope user -- ssh-mcp
  ```


**Verify Installation:**

After adding the server, restart Claude Code and ask Cascade to execute a command:
```
"Can you run 'ls -la' on the remote server?"
```

For more information about MCP in Claude Code, see the [official documentation](https://docs.claude.com/en/docs/claude-code/mcp).

## Testing

You can use the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) for visual debugging of this MCP Server.

```sh
npm run inspect
```

The test suite needs a throwaway SSH server, which `docker-compose.yml` provides:

```sh
docker compose up -d
SSH_HOST=127.0.0.1 SSH_PORT=2222 SSH_USER=test SSH_PASSWORD=secret npm test
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
- Planetfone client routing through `client-map.md`, with `SSH_MCP_USER`/`SSH_MCP_PASSWORD` credentials from the process environment
- Exit-code-aware tool results and head+tail output truncation (`--maxOutputBytes` / `maxBytes`)
