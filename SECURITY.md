# Security Policy

## Supported versions

Only the latest published release of `@iagogfe/ssh-mcp` receives security fixes.

| Version | Supported |
| ------- | --------- |
| 1.5.x   | ✅        |
| < 1.5   | ❌        |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it through GitHub's private vulnerability reporting:
[github.com/iagogfe/ssh-mcp/security/advisories/new](https://github.com/iagogfe/ssh-mcp/security/advisories/new).

Include what you need to reproduce it: the version, the flags or environment variables in
play, and the request or command sequence that triggers it.

Expect an acknowledgement within 7 days. If a fix is warranted, it ships in a patch
release and the advisory is published once it is available.

## Threat model

This server exists to run shell commands on a remote host on behalf of an LLM. The
following are **not** vulnerabilities, because they are the tool doing its job:

- An MCP client can run any command the configured SSH user can run. Restrict what that
  user can do; the server does not sandbox commands.
- `sudo-exec` elevates to root when the host's sudo configuration allows it. Start the
  server with `--disableSudo` if you do not want that tool exposed.
- `--insecureHostKey` disables host key verification. It is an explicit, warned-about
  opt-out, not a default.

The following **are** in scope:

- Leaking a password, key material, or a `SSH_MCP_*` value into stdout, stderr, tool
  results, or the process list.
- Bypassing host key verification when `--insecureHostKey` is not set.
- Command injection through the `description` or `maxBytes` parameters, or any other
  route where a tool argument escapes the intended command boundary.
- Reaching `sudo-exec` when the server was started with `--disableSudo`.
- Anything in the JSON-RPC handling that lets one MCP request affect another.
