#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Client, ClientChannel } from 'ssh2';
import { z } from 'zod';
import { createHash, createHmac, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  ClientResolutionError,
  loadClientInventory,
  resolveClientHost,
  type InventoryClient,
} from './client-map.js';
import { DestinationManagerCache } from './connection-manager-cache.js';
import { formatCommandResult, parseLimit } from './output.js';
import { TunnelRegistry } from './tunnel.js';
import {
  DEFAULT_TMUX_SESSION,
  assertSessionName,
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

// Example usage: node build/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key --timeout=5000 --disableSudo
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string | null> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const equalIndex = arg.indexOf('=');
      if (equalIndex === -1) {
        // Flag without value
        config[arg.slice(2)] = null;
      } else {
        // Key=value pair
        config[arg.slice(2, equalIndex)] = arg.slice(equalIndex + 1);
      }
    }
  }
  return config;
}
const isTestMode = process.env.SSH_MCP_TEST === '1';
const isCliEnabled = process.env.SSH_MCP_DISABLE_MAIN !== '1';
const argvConfig = (isCliEnabled || isTestMode) ? parseArgv() : {} as Record<string, string>;

// Credential resolution: an explicit CLI flag always takes precedence over the
// environment variable. Passing secrets via env vars keeps them out of the
// process argument list (visible to other local users via `ps`/proc) and out of
// committed MCP client configs. `undefined` means "not provided"; for the su/sudo
// passwords we preserve the existing null/undefined distinction used downstream.
function resolveSecret(flag: string | null | undefined, env: string | undefined): string | null | undefined {
  if (flag !== undefined) return flag;       // flag wins (including bare flag => null)
  if (env !== undefined && env !== '') return env;
  return undefined;
}

export function shouldLoadPrivateKey(
  password: string | undefined,
  keyPath: string | undefined,
): keyPath is string {
  return password === undefined && keyPath !== undefined;
}

const PORT = argvConfig.port ? parseInt(argvConfig.port) : (process.env.SSH_MCP_PORT ? parseInt(process.env.SSH_MCP_PORT) : 22);
// Single-host mode: the server is pinned to one target for its whole lifetime.
// This is the original contract and stays the default, so existing deployments
// that pass --host keep working without knowing an inventory exists.
export const HOST = argvConfig.host ?? process.env.SSH_MCP_HOST;
// Inventory mode: opt-in only. No default path — a relative default would
// resolve against whatever working directory the MCP client happened to spawn
// the process in, which the operator does not control.
export const CLIENT_MAP_PATH = argvConfig.clientMap ?? process.env.SSH_MCP_CLIENT_MAP;
export const USER = argvConfig.user ?? process.env.SSH_MCP_USER;
export const PASSWORD = resolveSecret(argvConfig.password, process.env.SSH_MCP_PASSWORD) ?? undefined;
const SUPASSWORD = resolveSecret(argvConfig.suPassword, process.env.SSH_MCP_SU_PASSWORD);
const SUDOPASSWORD = resolveSecret(argvConfig.sudoPassword, process.env.SSH_MCP_SUDO_PASSWORD);
const DISABLE_SUDO = argvConfig.disableSudo !== undefined;
// Opting out of tunnelling, mirroring --disableSudo: a tunnel is a network
// capability the agent gains, and an operator may want the shell without it.
const DISABLE_TUNNEL = argvConfig.disableTunnel !== undefined;
const KEY = argvConfig.key ?? process.env.SSH_MCP_KEY_PATH;
// --noTmux forces the old stateless per-command exec path even when the host
// has tmux available. --tmuxSession picks which session name to attach/create,
// so multiple independent server instances can share a host without stepping
// on each other's persistent shell.
// Concurrent tool calls each open their own SSH channel, and sshd caps that with
// MaxSessions -- 10 by default, and the excess is refused with a bare
// "Channel open failure". Queueing past a client-side cap costs nothing: in tmux
// mode every command serialises through the one pane anyway, so the extra
// channels would only queue server-side. Default 8 leaves headroom under the
// usual 10 for the elevation shell and an interrupt. Lower it for a host with a
// stricter MaxSessions.
const MAX_CONCURRENT = (() => {
  const raw = argvConfig.maxConcurrent ?? process.env.SSH_MCP_MAX_CONCURRENT;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8;
})();
const NO_TMUX = argvConfig.noTmux !== undefined || process.env.SSH_MCP_NO_TMUX === '1';
const TMUX_SESSION = argvConfig.tmuxSession ?? process.env.SSH_MCP_TMUX_SESSION ?? DEFAULT_TMUX_SESSION;

// Host key verification settings (defends against man-in-the-middle attacks).
// By default the server verifies the host key against the user's known_hosts file
// and refuses to connect if it is not found there. A pinned fingerprint may be
// supplied with --hostFingerprint, and verification can be disabled (with a loud
// warning) using --insecureHostKey for ephemeral/throwaway hosts.
const HOST_FINGERPRINT = argvConfig.hostFingerprint ?? process.env.SSH_MCP_HOST_FINGERPRINT ?? undefined;
const KNOWN_HOSTS_PATH = argvConfig.knownHosts ?? process.env.SSH_MCP_KNOWN_HOSTS ?? join(homedir(), '.ssh', 'known_hosts');
const INSECURE_HOST_KEY = argvConfig.insecureHostKey !== undefined || process.env.SSH_MCP_INSECURE_HOST_KEY === '1';
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000; // 60 seconds default timeout
// Longest accepted command, in characters. 0/none disables. Default 1000.
const MAX_CHARS = parseLimit(argvConfig.maxChars, 1000);

// Output truncation budget (bytes per stream). 0/none disables. Default 8 KB.
const MAX_OUTPUT_BYTES = parseLimit(
  argvConfig.maxOutputBytes ?? process.env.SSH_MCP_MAX_OUTPUT_BYTES,
  8192,
);

// Resolve the effective limit for a single tool call (per-call override wins).
function resolveMaxBytes(callMax: number | undefined): number {
  if (callMax === undefined) return MAX_OUTPUT_BYTES;
  if (callMax <= 0) return 0;
  return callMax;
}

function validateConfig(config: Record<string, string | null>) {
  const errors = [];
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  // One of the two modes has to be configured, otherwise every tool call would
  // fail at runtime with no target. Failing at startup names the problem while
  // the operator is still looking at the config.
  const hasHost = !!(config.host ?? process.env.SSH_MCP_HOST);
  const hasClientMap = !!(config.clientMap ?? process.env.SSH_MCP_CLIENT_MAP);
  if (!hasHost && !hasClientMap) {
    errors.push('Missing target: pass --host for a single server, or --clientMap for an inventory');
  }
  // Validates the fully-resolved session name (flag, then SSH_MCP_TMUX_SESSION,
  // then the always-valid default) rather than just the raw CLI flag: an
  // invalid name reaching the server only via the env var would otherwise
  // start clean and fail later, on the first tool call, instead of at startup.
  try { assertSessionName(TMUX_SESSION); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

if (isCliEnabled) {
  validateConfig(argvConfig);
}

// Command sanitization and validation
export function sanitizeCommand(command: string): string {
  if (typeof command !== 'string') {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Command must be a string');
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Command cannot be empty');
  }

  // Length check
  if (MAX_CHARS > 0 && trimmedCommand.length > MAX_CHARS) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Command is too long (max ${MAX_CHARS} characters)`
    );
  }

  return trimmedCommand;
}

function sanitizePassword(password: string | undefined): string | undefined {
  if (typeof password !== 'string') return undefined;
  // minimal check, do not log or modify content
  if (password.length === 0) return undefined;
  return password;
}

// Strip CR/LF from a description before appending it as a shell comment.
// Without this, a newline in the description would end the comment and inject an
// extra command line into the shell.
//
// `#` is deliberately NOT escaped: the text already sits inside a comment, where
// a `#` means nothing, and escaping it was the only reason a backslash ever
// reached the output -- which is what CodeQL's incomplete-sanitization rule
// flagged. A trailing backslash cannot splice the next line either: verified on
// bash, dash and sh that a comment ends at its newline regardless.
export function sanitizeDescription(description: string): string {
  return description.replace(/[\r\n]+/g, ' ').trim();
}

// Build a `printf` invocation that emits a unique sentinel line. The embedded ""
// splits the literal so the sentinel string appears only in the command's OUTPUT,
// never in the PTY's echo of the input. This lets us detect command boundaries in
// a persistent root shell reliably, even when a command's own output contains '#'
// or other prompt-like characters (the previous heuristic broke on such output).
export function sentinelEcho(label: string, token: string, suffix = ''): string {
  return `printf '%s\\n' "SSH_MCP""_${label}_${token}${suffix}"`;
}

// --- Host key verification helpers (defense against MITM) ---

// OpenSSH-style SHA256 fingerprint ("SHA256:<base64 without padding>") of a raw
// host key buffer, matching `ssh-keygen -lf`.
export function sshKeyFingerprintSha256(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

// Whether a raw host key buffer matches an expected fingerprint. Accepts modern
// SHA256 fingerprints ("SHA256:..." or bare base64) and legacy MD5 hex
// fingerprints ("MD5:aa:bb:..." or "aa:bb:...").
// Drops base64 '=' padding. A loop rather than /=+$/: that regex backtracks
// quadratically on a long run of '=', which CodeQL flags as polynomial ReDoS.
// The input here is an operator-supplied --hostFingerprint rather than anything
// an attacker reaches at runtime, so this is cheap insurance, not a live fix.
function stripTrailingPadding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '=') end -= 1;
  return value.slice(0, end);
}

export function matchesFingerprint(key: Buffer, expected: string): boolean {
  const exp = expected.trim();
  const isMd5 = /^MD5:/i.test(exp) || /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(exp);
  if (isMd5) {
    const got = createHash('md5').update(key).digest('hex');
    const want = exp.replace(/^MD5:/i, '').replace(/:/g, '').toLowerCase();
    return got === want;
  }
  const got = stripTrailingPadding(createHash('sha256').update(key).digest('base64'));
  const want = stripTrailingPadding(exp.replace(/^SHA256:/i, ''));
  return got === want;
}

// Whether a host field from a known_hosts line matches one of the candidate
// host identifiers. Supports plain comma-separated patterns and hashed
// (|1|salt|hash) entries.
function knownHostsFieldMatches(hostField: string, candidates: string[]): boolean {
  if (hostField.startsWith('|1|')) {
    const segs = hostField.split('|'); // ['', '1', <b64 salt>, <b64 hash>]
    if (segs.length < 4) return false;
    let salt: Buffer;
    try { salt = Buffer.from(segs[2], 'base64'); } catch { return false; }
    const expectedHash = segs[3];
    return candidates.some((h) => createHmac('sha1', salt).update(h).digest('base64') === expectedHash);
  }
  const patterns = hostField.split(',');
  return patterns.some((p) => candidates.includes(p));
}

// Whether the given known_hosts content contains an entry for this host:port
// whose key exactly matches the presented host key.
export function knownHostsHasKey(content: string, host: string, port: number, key: Buffer): boolean {
  // OpenSSH records non-default ports as "[host]:port"; port 22 is stored bare.
  const candidates = port === 22 ? [host] : [`[${host}]:${port}`];
  const b64key = key.toString('base64');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let parts = line.split(/\s+/);
    if (parts[0].startsWith('@')) parts = parts.slice(1); // @cert-authority / @revoked markers
    if (parts.length < 3) continue;
    const [hostField, , keyData] = parts;
    if (keyData !== b64key) continue;
    if (knownHostsFieldMatches(hostField, candidates)) return true;
  }
  return false;
}

export interface HostKeyVerifyOptions {
  host: string;
  port: number;
  hostFingerprint?: string;
  insecure?: boolean;
}

// Decide whether to accept a presented host key. Pure/synchronous so it can be
// unit tested; the caller is responsible for reading known_hosts from disk.
export function verifyHostKeySync(
  key: Buffer,
  opts: HostKeyVerifyOptions,
  knownHostsContent?: string,
): { ok: boolean; reason: string } {
  if (opts.insecure) {
    return { ok: true, reason: 'host key verification disabled (--insecureHostKey)' };
  }
  if (opts.hostFingerprint) {
    if (matchesFingerprint(key, opts.hostFingerprint)) {
      return { ok: true, reason: 'host key matches pinned fingerprint' };
    }
    return {
      ok: false,
      reason: `host key fingerprint mismatch (presented ${sshKeyFingerprintSha256(key)})`,
    };
  }
  if (knownHostsContent && knownHostsHasKey(knownHostsContent, opts.host, opts.port, key)) {
    return { ok: true, reason: 'host key found in known_hosts' };
  }
  return {
    ok: false,
    reason:
      `host key not found in known_hosts (presented ${sshKeyFingerprintSha256(key)}). ` +
      'Add it to your known_hosts, pin it with --hostFingerprint, or use --insecureHostKey to disable verification.',
  };
}

// SSH Connection Manager to maintain persistent connection
export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  suPassword?: string;
  sudoPassword?: string;  // Password for sudo commands specifically (if different from suPassword)
  hostFingerprint?: string;   // Pinned host key fingerprint (SHA256 or MD5)
  knownHostsPath?: string;    // Path to known_hosts (defaults to ~/.ssh/known_hosts)
  insecureHostKey?: boolean;  // Disable host key verification (vulnerable to MITM)
  maxConcurrent?: number;   // Max SSH channels open at once for this destination
  noTmux?: boolean;           // Force the stateless per-command exec path
  tmuxSession?: string;       // tmux session name (defaults to 'ssh-mcp')
}

// Build the ssh2 connect config, injecting a hostVerifier so we never silently
// accept an unverified host key (ssh2 auto-accepts when no verifier is supplied).
export function buildConnectConfig(sshConfig: SSHConfig): any {
  const cfg: any = { ...sshConfig };
  // SSH-level keepalive. Without it an idle connection is dropped by the
  // server's own ClientAliveInterval (or by a NAT/firewall idle timer) and this
  // side only finds out on the next tool call, which then pays a full handshake
  // before it can run. This server is built to hold connections open across
  // long gaps between calls, so idleness is the normal state, not the exception.
  // 15s * 3 unanswered = ~45s to notice a dead peer.
  cfg.keepaliveInterval = 15000;
  cfg.keepaliveCountMax = 3;
  const { host, port, hostFingerprint, insecureHostKey } = sshConfig;
  const knownHostsPath = sshConfig.knownHostsPath || join(homedir(), '.ssh', 'known_hosts');

  cfg.hostVerifier = (key: Buffer): boolean => {
    let knownHostsContent: string | undefined;
    if (!insecureHostKey && !hostFingerprint) {
      try { knownHostsContent = readFileSync(knownHostsPath, 'utf8'); } catch { /* treat as empty */ }
    }
    const result = verifyHostKeySync(
      key,
      { host, port, hostFingerprint, insecure: insecureHostKey },
      knownHostsContent,
    );
    if (insecureHostKey) {
      console.error(
        'WARNING: SSH host key verification is DISABLED (--insecureHostKey). ' +
        'The connection is vulnerable to man-in-the-middle attacks.',
      );
    } else if (!result.ok) {
      console.error(`SSH host key verification failed: ${result.reason}`);
    }
    return result.ok;
  };
  return cfg;
}

export class SSHConnectionManager {
  private conn: Client | null = null;
  private sshConfig: SSHConfig;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private suShell: any = null;  // Store the elevated shell session
  private suPromise: Promise<void> | null = null;
  private isElevated = false;  // Track if we're in su mode
  private tokenSeq = 0;        // Monotonic counter for unique command sentinels
  // Per-instance random component of nextToken(). The tmux workdir is
  // deliberately persisted in the session's own environment so a jobId
  // survives an MCP server restart -- which means a bare per-instance counter
  // (previously 'k1z', 'k2z', ...) reissues the exact same tokens every
  // restart, and can also collide against a second, concurrently-live
  // instance sharing the same session (e.g. two managers pointed at the same
  // tmuxSession). Either can hand a later command a stale rc/out/err file
  // left by an old, never-collected run under that token.
  private readonly tokenNonce = randomBytes(4).toString('hex');
  // True only while the SSH session is actually usable — from the moment the
  // handshake completes (and su elevation, when configured) until the
  // connection ends. `connect()` assigns `this.conn` synchronously inside its
  // promise executor and ssh2 creates the socket immediately, so a live
  // `conn._sock` says nothing about whether the protocol is ready: a caller
  // trusting it during the handshake window sends CHANNEL_OPEN before KEXINIT
  // and the server drops the connection.
  // Channel budget for this destination. `waiters` are callers parked until a
  // slot frees; the acquire loop re-checks after waking so two of them can never
  // be admitted into the same slot.
  private activeChannelCount = 0;
  private readonly channelWaiters: Array<() => void> = [];
  private isReady = false;
  private tmuxMode: TmuxMode | null = null;
  private modePromise: Promise<TmuxMode> | null = null;
  private probe: TmuxProbe | null = null;

  constructor(config: SSHConfig) {
    this.sshConfig = config;
  }

  // Unique-per-command token used to fence command output in the persistent shell.
  nextToken(): string {
    this.tokenSeq += 1;
    return 'k' + this.tokenNonce + this.tokenSeq.toString(36) + 'z';
  }

  getTmuxSession(): string {
    return this.sshConfig.tmuxSession || DEFAULT_TMUX_SESSION;
  }

  getProbe(): TmuxProbe | null {
    return this.probe;
  }

  // Cleared whenever the connection drops so a reconnect re-evaluates the host.
  resetMode(): void {
    this.tmuxMode = null;
    this.modePromise = null;
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
    // Concurrent callers share the in-flight probe, the same way connect()
    // shares connectionPromise. Without this, N cold callers each open a probe
    // channel on top of their own command channel: 2N channels against sshd's
    // MaxSessions (10 by default), and the excess comes back as
    // "Channel open failure: open failed".
    if (this.modePromise) return this.modePromise;

    this.modePromise = (async () => {
      if (this.sshConfig.suPassword) {
        this.tmuxMode = 'su';
      } else if (this.sshConfig.noTmux) {
        this.tmuxMode = 'stateless';
      } else {
        this.probe = parseProbeOutput(await runProbe(buildProbeScript()));
        this.tmuxMode = this.probe.tmux ? 'tmux' : 'blocked';
      }
      return this.tmuxMode;
    })();

    try {
      return await this.modePromise;
    } finally {
      // Cleared either way: on success tmuxMode is the cache from here on, and
      // on failure the next caller must be free to probe again rather than
      // inherit a rejected promise forever.
      this.modePromise = null;
    }
  }

  async connect(): Promise<void> {
    if (this.conn && this.isConnected()) {
      return; // Already connected
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise; // Wait for ongoing connection
    }

    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.conn = new Client();

      const timeoutId = setTimeout(() => {
        this.conn?.end();
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.isReady = false;
        this.resetMode();
        reject(new ProtocolError(ProtocolErrorCode.InternalError, 'SSH connection timeout'));
      }, 30000); // 30 seconds connection timeout

      this.conn.on('ready', async () => {
        clearTimeout(timeoutId);
        this.isConnecting = false;

        // In test mode, don't wait for su elevation during connection setup, as it
        // may cause JSON-RPC server initialization to hang. Instead, elevation will
        // be triggered on-demand when a command is executed.
        // In production, elevation during connection is desirable for robustness.
        if (this.sshConfig.suPassword && !process.env.SSH_MCP_TEST) {
          try {
            await this.ensureElevated();
          } catch (err) {
            // Do not reject the connection; just log the error. Subsequent commands
            // will either use the su shell if available or fall back to normal execution.
          }
        }

        this.isReady = true;
        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.isReady = false;
        this.resetMode();
        reject(new ProtocolError(ProtocolErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        console.error('SSH connection ended');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.isReady = false;
        this.resetMode();
      });

      this.conn.on('close', () => {
        console.error('SSH connection closed');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.isReady = false;
        this.resetMode();
      });

      this.conn.connect(buildConnectConfig(this.sshConfig));
    });

    return this.connectionPromise;
  }

  maxConcurrentChannels(): number {
    return this.sshConfig.maxConcurrent ?? MAX_CONCURRENT;
  }

  activeChannels(): number {
    return this.activeChannelCount;
  }

  async acquireChannel(): Promise<void> {
    while (this.activeChannelCount >= this.maxConcurrentChannels()) {
      await new Promise<void>((resolve) => this.channelWaiters.push(resolve));
    }
    this.activeChannelCount += 1;
  }

  releaseChannel(): void {
    if (this.activeChannelCount > 0) this.activeChannelCount -= 1;
    this.channelWaiters.shift()?.();
  }

  isConnected(): boolean {
    return this.isReady && this.conn !== null && (this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
  }

  // Whether commands currently run inside the persistent root shell established by
  // `su -`. Callers must not wrap a command in `sudo` when this is true: the su
  // shell branch of execSshCommandWithConnection has no stdin channel to feed
  // `sudo -S` a password with.
  isRootShell(): boolean {
    return this.isElevated && !!this.suShell;
  }

  getSudoPassword(): string | undefined {
    return this.sshConfig.sudoPassword;
  }

  setSudoPassword(pwd?: string): void {
    this.sshConfig.sudoPassword = pwd;
  }

  getSuPassword(): string | undefined {
    return this.sshConfig.suPassword;
  }

  async setSuPassword(pwd?: string): Promise<void> {
    this.sshConfig.suPassword = pwd;
    if (pwd) {
      try {
        await this.ensureElevated();
      } catch (err) {
        console.error('setSuPassword: failed to elevate to su shell:', err);
      }
    } else {
      // If clearing suPassword, drop any existing suShell
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
    }
  }

  private async ensureElevated(): Promise<void> {
    if (this.isElevated && this.suShell) return;
    if (!this.sshConfig.suPassword) return;

    if (this.suPromise) return this.suPromise;

    this.suPromise = new Promise((resolve, reject) => {
      const conn = this.getConnection();

      // Add a safety timeout so elevation doesn't hang forever
      const timeoutId = setTimeout(() => {
        this.suPromise = null;
        reject(new ProtocolError(ProtocolErrorCode.InternalError, 'su elevation timed out'));
      }, 10000);  // 10 second timeout for elevation

      conn.shell({ term: 'xterm', cols: 80, rows: 24 }, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          clearTimeout(timeoutId);
          this.suPromise = null;
          reject(new ProtocolError(ProtocolErrorCode.InternalError, `Failed to start interactive shell for su: ${err.message}`));
          return;
        }

        let buffer = '';
        let passwordSent = false;
        let probeSent = false;
        const readyToken = this.nextToken();
        const readyMark = `SSH_MCP_READY_${readyToken}`;
        const authFailRe = /authentication failure|incorrect password|su: .*fail/i;
        const cleanup = () => {
          try { stream.removeAllListeners('data'); } catch (e) { /* ignore */ }
        };
        const fail = (msg: string) => {
          clearTimeout(timeoutId);
          cleanup();
          try { stream.end(); } catch (e) { /* ignore */ }
          this.suPromise = null;
          reject(new ProtocolError(ProtocolErrorCode.InternalError, msg));
        };

        const onData = (data: Buffer) => {
          buffer += data.toString();

          // If we haven't sent the password yet, look for the password prompt.
          if (!passwordSent && /password[: ]/i.test(buffer)) {
            passwordSent = true;
            buffer = '';  // reset so stale output can't trigger the checks below
            stream.write(this.sshConfig.suPassword + '\n');
            // Turn off PTY echo so command input isn't mixed into command output,
            // then emit a unique readiness sentinel. If su failed, this runs in the
            // unprivileged shell and would still print READY — so the auth-failure
            // check below (which su prints first) takes precedence.
            stream.write('stty -echo 2>/dev/null\n');
            stream.write(sentinelEcho('READY', readyToken) + '\n');
            probeSent = true;
            return;
          }

          // Detect authentication failure messages before accepting the shell.
          if (passwordSent && authFailRe.test(buffer)) {
            fail('su authentication failed');
            return;
          }

          // Accept the elevated shell only once our readiness sentinel is echoed back.
          if (probeSent && buffer.includes(readyMark)) {
            clearTimeout(timeoutId);
            cleanup();
            this.suShell = stream;
            this.isElevated = true;
            this.suPromise = null;
            resolve();
            return;
          }
        };

        stream.on('data', onData);

        stream.on('close', () => {
          clearTimeout(timeoutId);
          if (!this.isElevated) {
            this.suPromise = null;
            reject(new ProtocolError(ProtocolErrorCode.InternalError, 'su shell closed before elevation completed'));
          }
        });

        // Kick off the su command
        stream.write('su -\n');
      });
    });

    return this.suPromise;
  }

  async ensureConnected(): Promise<void> {
    if (!this.isConnected()) {
      await this.connect();
    }
  }

  getConnection(): Client {
    if (!this.conn) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'SSH connection not established');
    }
    return this.conn;
  }

  close(): void {
    if (this.conn) {
      if (this.suShell) {
        try { this.suShell.end(); } catch (e) { /* ignore */ }
        this.suShell = null;
        this.isElevated = false;
      }
      this.conn.end();
      this.conn = null;
    }
    this.isReady = false;
    this.resetMode();
  }
}

let configuredClients: InventoryClient[] | null = null;
const connectionManagers = new DestinationManagerCache<SSHConnectionManager>();

function getConfiguredClients(): InventoryClient[] {
  if (!CLIENT_MAP_PATH) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'No client inventory configured; start the server with --clientMap or omit the client parameter to use --host',
    );
  }
  if (!configuredClients) {
    configuredClients = loadClientInventory(CLIENT_MAP_PATH);
  }
  return configuredClients;
}

// Resolve the target for one tool call. A client name selects from the
// inventory; its absence falls back to the pinned --host. Both modes can be
// configured at once, in which case --host is the default target.
function resolveTargetHost(client: string | undefined): string {
  if (client !== undefined && client !== '') {
    // client-map.ts stays free of any MCP import, so its own error type is
    // translated here rather than thrown across the protocol boundary raw.
    try {
      return resolveClientHost(getConfiguredClients(), client);
    } catch (err) {
      if (err instanceof ClientResolutionError) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, err.message);
      }
      throw err;
    }
  }
  if (HOST) return HOST;
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    'No target: this server has no --host configured, so a client name is required',
  );
}

async function getConnectionManager(
  client: string | undefined,
  includeSudo: boolean,
): Promise<{ manager: SSHConnectionManager }> {
  const host = resolveTargetHost(client);
  if (!USER) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Missing required username');
  }

  const manager = await connectionManagers.getOrCreateAsync(
    host,
    PORT,
    USER,
    async () => {
      const sshConfig: SSHConfig = {
        host,
        port: PORT,
        username: USER,
        hostFingerprint: HOST_FINGERPRINT,
        knownHostsPath: KNOWN_HOSTS_PATH,
        insecureHostKey: INSECURE_HOST_KEY,
        noTmux: NO_TMUX,
        tmuxSession: TMUX_SESSION,
      };

      if (PASSWORD !== undefined) {
        sshConfig.password = PASSWORD;
      } else if (shouldLoadPrivateKey(PASSWORD, KEY)) {
        const fs = await import('fs/promises');
        sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
      }

      if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
        sshConfig.suPassword = sanitizePassword(SUPASSWORD);
      }
      if (includeSudo && SUDOPASSWORD !== null && SUDOPASSWORD !== undefined) {
        sshConfig.sudoPassword = sanitizePassword(SUDOPASSWORD);
      }

      return new SSHConnectionManager(sshConfig);
    },
  );

  return { manager };
}

function closeAllConnectionManagers(): void {
  connectionManagers.closeAll();
}

// Whether a real, non-null suPassword was supplied. A bare --suPassword flag
// (no '=value') resolves to null and does NOT enable su mode -- see the
// SUPASSWORD assignment above. Declared once, here, and reused by both the
// exec description below and the job_status registration gate further down,
// so the two can't quietly drift apart on what "su mode is active" means.
const SU_ACTIVE = SUPASSWORD !== null && SUPASSWORD !== undefined;
// Whether exec/sudo-exec will actually attempt the persistent tmux session.
// A host that turns out to be missing tmux still fails loudly at call time
// (ensureMode throws, blocked mode never executes anything) -- the case this
// description must not lie about is stateless/su mode, which succeeds while
// silently NOT persisting state.
const TMUX_ATTEMPTED = !NO_TMUX && !SU_ACTIVE;

// Shared schema fragments. `client` only means anything when an inventory is
// configured: on a server pinned to --host, passing it can only ever produce
// "No client inventory configured", so registering it advertises an
// affordance that does not exist and spends the agent's context on it every
// session. Same rule the tool registrations below already follow for
// sudo-exec and job_status, applied to the parameters.
// `client` is always registered, never conditionally: an undeclared key is
// STRIPPED by zod, so the handler would never see it and never refuse it --
// and a `client` silently ignored means the command runs on the pinned host
// instead of the one the caller named. Wrong machine, no error. The loud
// "No client inventory configured" it gets today is worth keeping.
//
// What is conditional is the description: with no inventory configured there
// is nothing to describe, and prose about selecting from an inventory that
// does not exist is context spent teaching a dead end.
const CLIENT_FIELD = {
  client: CLIENT_MAP_PATH
    ? z.string().optional().describe('Client name from the configured inventory. Omit to use the default target.')
    : z.string().optional(),
};
// One definition for the three tools that take it. The old text also promised
// it "defaults to server config", which every optional field does.
const MAXBYTES_FIELD = z.number().int().optional()
  .describe('Output byte budget; the middle is dropped past it. 0 disables.');

const server = new McpServer(
  {
    name: 'SSH MCP Server',
    version: '2.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.registerTool("exec", { description:
      "Run a shell command on the remote SSH server. " +
      (SU_ACTIVE
        ? "State persists between calls: this connection runs through one long-lived " +
          "`su -` root shell, so cd and export survive -- no chaining with && needed. " +
          "No tmux session here, so detach and job_status do not exist."
        : TMUX_ATTEMPTED
          ? "State persists between calls: cd and export survive, so there is no need " +
            "to chain with && or cd back each time. For long work, pass detach: true " +
            "and poll the jobId with job_status."
          : "Each call runs in its own shell: cd and export do NOT persist. Chain " +
            "related commands with && or ; in one call."),
      inputSchema: z.object({
        ...CLIENT_FIELD,
        command: z.string().describe("Shell command to execute on the remote SSH server"),
        description: z.string().optional().describe("Optional description of what this command will do"),
        detach: z.boolean().optional().describe("Run in the background and return a jobId instead of blocking; collect it with job_status. Only in tmux mode."),
        maxBytes: MAXBYTES_FIELD,
      }) }, async ({ client, command, description, detach, maxBytes }) => {
        try {
          const { manager } = await getConnectionManager(client, false);
          const sanitizedCommand = sanitizeCommand(command);

          // Ensure connection is active (reconnect if needed)
          await manager.ensureConnected();
          const mode = await ensureMode(manager);

          // Append description as comment if provided
          const commandWithDescription = description
            ? `${sanitizedCommand} # ${sanitizeDescription(description)}`
            : sanitizedCommand;

          if (mode === 'tmux') {
            return await runInTmux(manager, commandWithDescription, {
              kind: 'exec',
              detach,
              maxBytes: resolveMaxBytes(maxBytes),
            });
          }

          // detach only makes sense against the persistent tmux session: su and
          // stateless mode have no session to poll a job's progress in later.
          if (detach) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              'detach requires tmux mode; it is unavailable with --suPassword or --noTmux',
            );
          }

          // su and stateless modes keep the pre-tmux behavior verbatim.
          // If a suPassword was provided, explicitly wait for elevation before executing.
          // This is critical: ensureElevated is idempotent and will return immediately if
          // already elevated, so this ensures we have a su shell before we try to use it.
          if (manager.getSuPassword()) {
            try {
              const elevationPromise = (manager as any).ensureElevated();
              // Add a short timeout for elevation to complete
              await Promise.race([
                elevationPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('Elevation timeout')), 5000))
              ]);
            } catch (err) {
              // Log but don't fail; fall back to non-elevated execution if elevation times out
            }
          }

          const result = await execSshCommandWithConnection(manager, commandWithDescription, undefined, resolveMaxBytes(maxBytes));
          return result;
        } catch (err: any) {
          // Wrap unexpected errors
          if (err instanceof ProtocolError) throw err;
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
        }
      });

// Expose sudo-exec tool unless explicitly disabled
if (!DISABLE_SUDO) {
  // Whether a sudo password was configured at startup (bare --sudoPassword
  // resolves to null, same non-active convention as SU_ACTIVE above). This is
  // startup config, not a per-call argument -- the schema has no sudoPassword
  // field -- so it's as safe to bake into the description at registration
  // time as TMUX_ATTEMPTED is.
  const SUDO_PASSWORD_CONFIGURED = SUDOPASSWORD !== null && SUDOPASSWORD !== undefined;
  // sudo-exec's relationship to session state is NOT symmetric with exec's,
  // so this is deliberately not a copy of exec's ternary. Three real cases:
  // - su mode (--suPassword): the connection already runs through a
  //   long-lived `su -` root shell (see manager.isRootShell() below), so
  //   sudo-exec runs the command directly on THAT shell -- no `sudo` wrapper
  //   at all, the configured sudo password (if any) goes unused, and sudoers
  //   policy never comes into play. cd/export DO persist here, same as
  //   exec's, because it is the very same shell.
  // - stateless mode (--noTmux, su NOT active): no session at all, nothing
  //   persists, full stop.
  // - tmux mode:
  //   - passwordless sudo: runs `sudo -n sh` INSIDE the session, so it reads
  //     the session's current directory, but as a subprocess it can never
  //     write it back -- its own cd/export vanish with the call.
  //   - a configured sudo password takes it off the session entirely: sudo -S
  //     needs a private stdin the shared pane can't provide, so that call runs
  //     on its own separate channel starting from the login directory, blind
  //     to any cd a prior exec/sudo-exec call made.
  const sudoExecDescription = SU_ACTIVE
    ? "Run a shell command on the remote SSH server. This connection already runs " +
      "through a long-lived `su -` root shell, so the command runs on that shell with " +
      "NO sudo wrapper: the configured sudo password is unused and sudoers policy " +
      "does not apply. cd/export from this call persist for later calls."
    : !TMUX_ATTEMPTED
      ? "Run a shell command with sudo, using the configured password if present. " +
        "Each call runs in its own shell; nothing persists."
      : SUDO_PASSWORD_CONFIGURED
        ? "Run a shell command with the configured sudo password. This runs OFF " +
          "exec's session (sudo -S needs a private stdin the shared pane cannot give): " +
          "it starts from the login directory, not wherever a prior cd left the " +
          "session, and nothing it does persists."
        : "Run a shell command with passwordless sudo. It reads exec's session, so it " +
          "sees whatever directory a prior cd left it in, but never writes back: its " +
          "own cd/export do not persist.";

  server.registerTool("sudo-exec", { description: sudoExecDescription,
      inputSchema: z.object({
              ...CLIENT_FIELD,
              command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
              description: z.string().optional().describe("Optional description of what this command will do"),
              maxBytes: MAXBYTES_FIELD,
            }) }, async ({ client, command, description, maxBytes }) => {
              try {
                const { manager } = await getConnectionManager(client, true);
                const sanitizedCommand = sanitizeCommand(command);

                await manager.ensureConnected();
                const mode = await ensureMode(manager);

                // If suPassword or sudoPassword were provided on this call but the
                // existing connection manager was created earlier without them,
                // update the manager's values so the subsequent sudo-exec call uses
                // the latest passwords.
                if (SUPASSWORD !== null && SUPASSWORD !== undefined) {
                  await manager.setSuPassword(sanitizePassword(SUPASSWORD));
                }
                if (SUDOPASSWORD !== null && SUDOPASSWORD !== undefined) {
                  manager.setSudoPassword(sanitizePassword(SUDOPASSWORD));
                }

                let wrapped: string;
                const sudoPassword = manager.getSudoPassword();

                // Append description as comment if provided
                const commandWithDescription = description
                  ? `${sanitizedCommand} # ${sanitizeDescription(description)}`
                  : sanitizedCommand;

                // In tmux mode a passwordless sudo runs inside the session, so it
                // inherits the working directory. With a password it cannot: sudo -S
                // needs a private stdin, and the session's stdin is the shared pane.
                if (mode === 'tmux' && !sudoPassword) {
                  return await runInTmux(manager, commandWithDescription, {
                    kind: 'sudo',
                    maxBytes: resolveMaxBytes(maxBytes),
                  });
                }

                // Already root through the persistent `su -` shell: run the command as
                // is. Wrapping it in `sudo -S` there would hang — that shell branch has
                // no stdin channel to feed the password through — and feeding the
                // password into the shell instead would echo it back as a failed command
                // whenever sudo did not ask for one.
                if (manager.isRootShell()) {
                  return await execSshCommandWithConnection(manager, commandWithDescription, undefined, resolveMaxBytes(maxBytes));
                }

                if (!sudoPassword) {
                  // No password provided, use -n to fail if sudo requires a password
                  wrapped = `sudo -n sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
                  return await execSshCommandWithConnection(manager, wrapped, undefined, resolveMaxBytes(maxBytes));
                }

                // Password provided — feed it to `sudo -S` over the channel's stdin instead
                // of embedding it in the command string. Embedding it (e.g. via `printf <pwd> |`)
                // would expose the password in the remote process list (`ps`) and shell history.
                // `-p ""` suppresses the prompt and `-k` ignores any cached credentials so the
                // password is always read from the first line of stdin.
                wrapped = `sudo -p "" -S -k sh -c '${commandWithDescription.replace(/'/g, "'\\''")}'`;
                return await execSshCommandWithConnection(manager, wrapped, sudoPassword + '\n', resolveMaxBytes(maxBytes));
              } catch (err: any) {
                if (err instanceof ProtocolError) throw err;
                throw new ProtocolError(ProtocolErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
              }
            });
}

// job_status is only meaningful in tmux mode, which is also the only mode
// that can produce a jobId (via exec's detach: true), so the tool is hidden
// entirely when tmux is disabled or su mode is active (see SU_ACTIVE/
// TMUX_ATTEMPTED above, shared with exec's description).
if (TMUX_ATTEMPTED) {
  server.registerTool("job_status", { description:
      "Check a job started by exec(detach: true). While it runs: elapsed time and " +
      "the tail of its output. Once finished: the full output and exit code, and the " +
      "job is cleared, so collect it only once.",
      inputSchema: z.object({
        jobId: z.string().describe("The jobId returned by exec with detach: true"),
        ...CLIENT_FIELD,
        maxBytes: MAXBYTES_FIELD,
      }) }, async ({ jobId, client, maxBytes }) => {
        try {
          const { manager } = await getConnectionManager(client, false);
          await manager.ensureConnected();
          await ensureMode(manager);
          return await jobStatus(manager, jobId, resolveMaxBytes(maxBytes));
        } catch (err: any) {
          if (err instanceof ProtocolError) throw err;
          throw new ProtocolError(ProtocolErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
        }
      });
}

// Local port forwarding. Registered unless --disableTunnel, and in every mode:
// it never touches the session shell, so tmux/su/stateless are all the same to
// it. The listener lives in this process, so tunnels die with the server --
// which is the honest lifetime for something that cannot outlive its socket.
const tunnels = new TunnelRegistry();

if (!DISABLE_TUNNEL) {
  server.registerTool("tunnel_open", { description:
      "Forward a local port to a service the remote host can reach (ssh -L), for something " +
      "bound to the server's own loopback: a database, a cache, an internal UI. Binds " +
      "127.0.0.1 only and returns the port to connect to.",
      inputSchema: z.object({
        ...CLIENT_FIELD,
        remoteHost: z.string().describe("Target as the SERVER resolves it, e.g. localhost"),
        remotePort: z.number().int().describe("Port on remoteHost"),
        localPort: z.number().int().optional().describe("Local port; omit for a free one"),
      }) }, async ({ client, remoteHost, remotePort, localPort }) => {
        try {
          const { manager } = await getConnectionManager(client, false);
          await manager.ensureConnected();
          const info = await tunnels.open(
            () => manager.getConnection() as any,
            remoteHost,
            remotePort,
            localPort,
          );
          return {
            content: [{
              type: 'text' as const,
              text: `127.0.0.1:${info.localPort} -> ${info.remoteHost}:${info.remotePort}\n`
                + `Close it with tunnel_close({ localPort: ${info.localPort} }).`,
            }],
          };
        } catch (err: any) {
          if (err instanceof ProtocolError) throw err;
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Could not open tunnel: ${err?.message || err}`);
        }
      });

  server.registerTool("tunnel_list", { description:
      "List the local port forwards this server currently holds open.",
      inputSchema: z.object({}) }, async () => {
        const open = tunnels.list();
        if (open.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No tunnels open.' }] };
        }
        const lines = open.map((t) =>
          `127.0.0.1:${t.localPort} -> ${t.remoteHost}:${t.remotePort} (${t.activeConnections} active)`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      });

  server.registerTool("tunnel_close", { description:
      "Close a local port forward, dropping any connections still riding it.",
      inputSchema: z.object({
        localPort: z.number().int().describe("The local port reported by tunnel_open"),
      }) }, async ({ localPort }) => {
        const closed = tunnels.close(localPort);
        return {
          content: [{
            type: 'text' as const,
            text: closed ? `Closed the tunnel on 127.0.0.1:${localPort}.` : `No tunnel open on local port ${localPort}.`,
          }],
          ...(closed ? {} : { isError: true }),
        };
      });
}

// New function that uses persistent connection
// A refused channel open is transient and, crucially, means the command never
// reached the host: sshd rejects the session before anything runs, so a retry
// cannot double-execute. Nothing else here earns that guarantee -- a timeout or
// a dropped connection may well have left the command running -- so the match is
// deliberately narrow.
export function isRetryableChannelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /channel open failure/i.test(msg);
}

export async function execSshCommandWithConnection(
  manager: SSHConnectionManager,
  command: string,
  stdin?: string,
  maxBytes: number = 8192,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {

  // Wait for a channel slot before opening one. Without this, a burst of
  // parallel tool calls opens a channel each and sshd refuses everything past
  // MaxSessions with a bare "Channel open failure: open failed" -- an error the
  // agent can do nothing with, for work that would have queued anyway.
  // The persistent `su -` shell opens no channel -- it writes into a stream that
  // already exists -- so it must not consume a slot, and there is nothing here
  // for a retry to fix. Taking the fast path also keeps this function
  // synchronous up to its first write, which callers (and tests) rely on.
  if ((manager as any).suShell) {
    return runOnChannel(manager, command, stdin, maxBytes, timeoutMs);
  }

  // The cap keeps us under MaxSessions in steady state, but sshd does not free a
  // slot the instant our side closes a channel, so a burst can still be refused
  // mid-churn. Measured on a live host: with the cap alone, 20 concurrent calls
  // still lost 2 and 50 lost 2, tracking churn rather than count.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    await manager.acquireChannel();
    try {
      return await runOnChannel(manager, command, stdin, maxBytes, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (!isRetryableChannelError(err)) throw err;
    } finally {
      manager.releaseChannel();
    }
    // Released the slot before backing off, so a waiter can use it meanwhile.
    await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
  }
  throw new ProtocolError(
    ProtocolErrorCode.InternalError,
    `SSH channel refused after 5 attempts (${lastErr instanceof Error ? lastErr.message : String(lastErr)}). `
    + 'The host is at its MaxSessions limit; lower --maxConcurrent to stay under it.',
  );
}

function runOnChannel(
  manager: SSHConnectionManager,
  command: string,
  stdin: string | undefined,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    // Detaches the persistent shell's data listener. Set once that listener is
    // registered; the timeout path must run it too, or a timed-out command leaves
    // its handler buffering every byte the shell emits for the rest of the session.
    let detachShellListener: (() => void) | null = null;

    const conn = manager.getConnection();
    const shell = (manager as any).suShell;

    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        detachShellListener?.();
        reject(new ProtocolError(ProtocolErrorCode.InternalError, `Command execution timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Persistent su shell: fence the command and capture its exit code.
    if (shell) {
      let buffer = '';
      const token = manager.nextToken();
      // Plain string search rather than a RegExp built from the token: the exit
      // code must be read only once its line is complete. A `:(\d+)` match fires
      // on the first digit that arrives, so an exit code of 10 split across two
      // reads would be reported as 1.
      const beginMark = `SSH_MCP_BEGIN_${token}`;
      const endMark = `SSH_MCP_END_${token}:`;

      const dataHandler = (data: Buffer) => {
        buffer += data.toString();
        const endIdx = buffer.indexOf(endMark);
        if (endIdx === -1) return;

        const digits = buffer.slice(endIdx + endMark.length);
        const eol = digits.search(/[\r\n]/);
        if (eol === -1) return; // exit code still arriving
        const exitCode = parseInt(digits.slice(0, eol), 10);
        if (Number.isNaN(exitCode)) return;

        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutId);
        shell.removeListener('data', dataHandler);

        // Output starts after the BEGIN sentinel's own line.
        const beginIdx = buffer.indexOf(beginMark);
        let start = 0;
        if (beginIdx !== -1) {
          const nl = buffer.indexOf('\n', beginIdx);
          start = nl === -1 ? beginIdx + beginMark.length : nl + 1;
        }
        let output = buffer.slice(start, endIdx);
        output = output.replace(/\r/g, '').replace(/\n+$/, '');
        const text = output + (output ? '\n' : '');
        resolve(formatCommandResult({ stdout: text, stderr: '', exitCode }, maxBytes));
      };

      shell.on('data', dataHandler);
      detachShellListener = () => shell.removeListener('data', dataHandler);
      shell.write(sentinelEcho('BEGIN', token) + '\n');
      shell.write(command + '\n');
      shell.write('__rc=$?; ' + sentinelEcho('END', token, ':$__rc') + '\n');
      return;
    }

    // Normal exec: collect stdout/stderr and the exit code/signal from close.
    conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
      if (err) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          reject(new ProtocolError(ProtocolErrorCode.InternalError, `SSH exec error: ${err.message}`));
        }
        return;
      }

      let stdout = '';
      let stderr = '';

      if (stdin && stdin.length > 0) {
        try { stream.write(stdin); } catch (e) { console.error('Error writing to stdin:', e); }
      }
      try { stream.end(); } catch (e) { /* ignore */ }

      stream.on('data', (data: Buffer) => { stdout += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      stream.on('close', (code: number | null, signal: string | null) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutId);
          resolve(formatCommandResult({ stdout, stderr, exitCode: code, signal }, maxBytes));
        }
      });
    });
  });
}

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
    // A failed launch (unsafe workdir, tmux missing, cat > cmd.$T failing) is
    // not a job: report it now, rather than a phantom jobId whose only trace
    // is job_status later saying "unknown jobId".
    if (opts.detach && !res.isError) {
      return {
        content: [{ type: 'text', text: `[detached] jobId=${token} — collect with job_status("${token}")` }],
      };
    }
    return res;
  } catch (err: any) {
    // A wedged command would otherwise keep the session busy for every later
    // call. Ctrl-C frees it; failure to send is not worth masking the timeout.
    //
    // Skipped entirely for a detached launch: its script never polls, so
    // there's no orphaned poller to rescue with the synthetic marker -- it
    // would only risk reporting a job that's actually still running as done.
    // And Ctrl-C would hit whatever the pane happens to be running right now,
    // which for a backgrounded launch is somebody else's command, not this
    // one.
    if (!opts.detach && /timed out/i.test(err?.message || '')) {
      try {
        await execSshCommandWithConnection(manager, buildInterruptScript(session, token), undefined, 0, 5000);
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
    status = parseJobStatus(combined, jobId);
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
    const lines = [head, status.stdout];
    if (status.stderr) lines.push('stderr:', status.stderr);
    return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
  }
  return formatCommandResult(
    { stdout: status.stdout, stderr: status.stderr, exitCode: status.exitCode },
    maxBytes,
  );
}

// stdio serves exactly one MCP server per process; SSH destinations are managed
// independently by the per-host connection cache above.
const serverFactory = () => server;

async function main() {
  const handle = serveStdio(serverFactory);
  console.error("SSH MCP Server running on stdio");

  // Handle graceful shutdown
  const cleanup = () => {
    console.error("Shutting down SSH MCP Server...");
    void handle.close();
    tunnels.closeAll();
    closeAllConnectionManagers();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

process.on('exit', closeAllConnectionManagers);

// Initialize server in test mode for automated tests
if (isTestMode) {
  serveStdio(serverFactory, {
    onerror: (error) => console.error("Server error:", error),
  });
}
// Start server in CLI mode
else if (isCliEnabled) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    closeAllConnectionManagers();
    process.exit(1);
  });
}

export { parseArgv, validateConfig };
