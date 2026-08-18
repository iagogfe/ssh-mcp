# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-08-18

First release of `@iagogfe/ssh-mcp`. The major version reflects the break from
the 1.x line this project forked from: commands now run inside a persistent
remote session by default, and a host without `tmux` is refused instead of
silently falling back.

### Added

- **Persistent shell sessions.** `exec` and `sudo-exec` run inside a `tmux`
  session on the remote host, so `cd` and `export` from one call are visible to
  the next. The session survives an MCP server restart, and its working
  directory is recovered from the session's own environment.
- **Background jobs.** `exec(detach: true)` returns a `jobId` immediately
  instead of blocking; `job_status` reports elapsed time and a tail of the
  output while the job runs, then the full output and exit code once it
  finishes. A finished job is collected exactly once.
- **`job_status` tool**, registered only in tmux mode — the only mode that can
  produce a `jobId`.
- **Client inventory routing.** `--clientMap` points at a Markdown inventory of
  client names and hosts; tools take an optional `client` parameter that selects
  the target. Ambiguous and unknown names fail with suggestions.
- **Host key verification, on by default.** Verified against `known_hosts`, or
  pinned with `--hostFingerprint`. `--insecureHostKey` opts out with a warning.
- **Output truncation.** `--maxOutputBytes` and a per-call `maxBytes` keep large
  output from flooding the model's context: the middle of a stream is dropped,
  never a multi-byte character, and the marker reports how much was omitted.
- **Concurrency cap.** `--maxConcurrent` (default 8) queues callers client-side
  instead of letting `sshd` refuse them past `MaxSessions` with a bare
  `Channel open failure`. A refused channel open is retried, which is safe for
  that error specifically: `sshd` rejects the session before the command runs.
- **`--noTmux`** restores the 1.x stateless per-command behaviour, and
  **`--tmuxSession`** lets independent servers share a host without colliding.
- **MCP SDK v2**, serving the 2026-07-28 protocol revision while still
  accepting 2025-era clients.
- **Security pipeline**: Gitleaks, osv-scanner, Semgrep, CodeQL and OpenSSF
  Scorecard, with every action pinned by commit SHA.

### Changed

- **`tmux` is required by default.** A host without it fails loudly, naming the
  install command for the package manager it detected, instead of silently
  running stateless. `--noTmux` opts out.
- Tool descriptions are mode-aware: what they claim about state persistence
  matches what the configured mode actually does. In `su` mode `sudo-exec` runs
  on the root shell with no `sudo` wrapper at all, and says so.
- Per-session tool definitions are 25% smaller, so less of the agent's context
  is spent describing the server before it does anything.

### Fixed

- A detached launch handed out its `jobId` before the job was collectable, so an
  immediate `job_status` could report a live job as unknown.
- A completed background job's shell notice could leak into an unrelated
  command's stderr.
- Concurrent callers arriving on a cold connection opened a channel before the
  handshake finished, and the server dropped the connection.
- A command's own `exit` no longer tears down the tmux session, and a timed-out
  command no longer leaves a poller running on the remote host forever.
- An undefined exit code is reported as an abnormal exit rather than as the
  literal `[exit undefined]`, and is marked as an error.
- Session workdirs left behind by dead sessions are reclaimed.

### Security

- Passwords can be supplied through the environment instead of CLI flags,
  keeping them out of the remote process list and out of committed MCP configs.
- `sudo -S` reads the password from stdin rather than from the command string,
  so it never appears in `ps` or shell history on the remote host.
- Background-job stderr markers are scoped to a per-job random token, so a job's
  own output cannot forge the delimiter.

[2.0.0]: https://github.com/iagogfe/ssh-mcp/releases/tag/v2.0.0
