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
  loadPlanetfone4Hosts,
  type PlanetfoneClient,
} from './client-map.js';
import { resolveClientForProtocol } from './client-protocol.js';
import { DestinationManagerCache } from './connection-manager-cache.js';
import { formatCommandResult, parseMaxBytes } from './output.js';
import {
  DEFAULT_TMUX_SESSION,
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

export function resolveCredential(
  flag: string | null | undefined,
  legacy: string | undefined,
  official: string | undefined,
): string | null | undefined {
  return resolveSecret(flag, official ?? legacy);
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
export const PASSWORD = resolveCredential(
  argvConfig.password,
  undefined,
  process.env.SSH_MCP_PASSWORD,
) ?? undefined;
const SUPASSWORD = resolveSecret(argvConfig.suPassword, process.env.SSH_MCP_SU_PASSWORD);
const SUDOPASSWORD = resolveSecret(argvConfig.sudoPassword, process.env.SSH_MCP_SUDO_PASSWORD);
const DISABLE_SUDO = argvConfig.disableSudo !== undefined;
const KEY = argvConfig.key ?? process.env.SSH_MCP_KEY_PATH;

// Host key verification settings (defends against man-in-the-middle attacks).
// By default the server verifies the host key against the user's known_hosts file
// and refuses to connect if it is not found there. A pinned fingerprint may be
// supplied with --hostFingerprint, and verification can be disabled (with a loud
// warning) using --insecureHostKey for ephemeral/throwaway hosts.
const HOST_FINGERPRINT = argvConfig.hostFingerprint ?? process.env.SSH_MCP_HOST_FINGERPRINT ?? undefined;
const KNOWN_HOSTS_PATH = argvConfig.knownHosts ?? process.env.SSH_MCP_KNOWN_HOSTS ?? join(homedir(), '.ssh', 'known_hosts');
const INSECURE_HOST_KEY = argvConfig.insecureHostKey !== undefined || process.env.SSH_MCP_INSECURE_HOST_KEY === '1';
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000; // 60 seconds default timeout
// Max characters configuration:
// - Default: 1000 characters
// - When set via --maxChars:
//   * a positive integer enforces that limit
//   * 0 or a negative value disables the limit (no max)
//   * the string "none" (case-insensitive) disables the limit (no max)
const MAX_CHARS_RAW = argvConfig.maxChars;
const MAX_CHARS = (() => {
  if (typeof MAX_CHARS_RAW === 'string') {
    const lowered = MAX_CHARS_RAW.toLowerCase();
    if (lowered === 'none') return Infinity;
    const parsed = parseInt(MAX_CHARS_RAW);
    if (isNaN(parsed)) return 1000;
    if (parsed <= 0) return Infinity;
    return parsed;
  }
  return 1000;
})();

// Output truncation budget (bytes per stream). 0/none disables. Default 8 KB.
const MAX_OUTPUT_BYTES = parseMaxBytes(
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
  if (Number.isFinite(MAX_CHARS) && trimmedCommand.length > (MAX_CHARS as number)) {
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

// Escape command for use in shell contexts (like pkill)
export function escapeCommandForShell(command: string): string {
  // Replace single quotes with escaped single quotes
  return command.replace(/'/g, "'\"'\"'");
}

// Strip CR/LF (and collapse whitespace) from a description before appending it as
// a shell comment. Without this, a newline in the description would terminate the
// comment and inject an extra command line into the shell.
export function sanitizeDescription(description: string): string {
  return description.replace(/[\r\n]+/g, ' ').replace(/#/g, '\\#').trim();
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
export function matchesFingerprint(key: Buffer, expected: string): boolean {
  const exp = expected.trim();
  const isMd5 = /^MD5:/i.test(exp) || /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(exp);
  if (isMd5) {
    const got = createHash('md5').update(key).digest('hex');
    const want = exp.replace(/^MD5:/i, '').replace(/:/g, '').toLowerCase();
    return got === want;
  }
  const got = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  const want = exp.replace(/^SHA256:/i, '').replace(/=+$/, '');
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
  noTmux?: boolean;           // Force the stateless per-command exec path
  tmuxSession?: string;       // tmux session name (defaults to 'ssh-mcp')
}

// Build the ssh2 connect config, injecting a hostVerifier so we never silently
// accept an unverified host key (ssh2 auto-accepts when no verifier is supplied).
export function buildConnectConfig(sshConfig: SSHConfig): any {
  const cfg: any = { ...sshConfig };
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
  private tmuxMode: TmuxMode | null = null;
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

        resolve();
      });

      this.conn.on('error', (err: Error) => {
        clearTimeout(timeoutId);
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.resetMode();
        reject(new ProtocolError(ProtocolErrorCode.InternalError, `SSH connection error: ${err.message}`));
      });

      this.conn.on('end', () => {
        console.error('SSH connection ended');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.resetMode();
      });

      this.conn.on('close', () => {
        console.error('SSH connection closed');
        this.conn = null;
        this.isConnecting = false;
        this.connectionPromise = null;
        this.resetMode();
      });

      this.conn.connect(buildConnectConfig(this.sshConfig));
    });

    return this.connectionPromise;
  }

  isConnected(): boolean {
    return this.conn !== null && (this.conn as any)._sock && !(this.conn as any)._sock.destroyed;
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
    this.resetMode();
  }
}

let configuredClients: PlanetfoneClient[] | null = null;
const connectionManagers = new DestinationManagerCache<SSHConnectionManager>();

function getConfiguredClients(): PlanetfoneClient[] {
  if (!CLIENT_MAP_PATH) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'No client inventory configured; start the server with --clientMap or omit the client parameter to use --host',
    );
  }
  if (!configuredClients) {
    configuredClients = loadPlanetfone4Hosts(CLIENT_MAP_PATH);
  }
  return configuredClients;
}

// Resolve the target for one tool call. A client name selects from the
// inventory; its absence falls back to the pinned --host. Both modes can be
// configured at once, in which case --host is the default target.
function resolveTargetHost(client: string | undefined): string {
  if (client !== undefined && client !== '') {
    return resolveClientForProtocol(getConfiguredClients(), client).host;
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

const server = new McpServer(
  {
    name: 'SSH MCP Server',
    version: '1.5.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

server.registerTool("exec", { description: "Execute a shell command on the remote SSH server and return the output.", inputSchema: z.object({
        client: z.string().optional().describe('Client name from the configured inventory. Omit when the server is pinned to a single host.'),
        command: z.string().describe("Shell command to execute on the remote SSH server"),
        description: z.string().optional().describe("Optional description of what this command will do"),
        maxBytes: z.number().int().optional().describe("Max output bytes before head+tail truncation; 0 disables. Defaults to server config."),
      }) }, async ({ client, command, description, maxBytes }) => {
        try {
          const { manager } = await getConnectionManager(client, false);
          const sanitizedCommand = sanitizeCommand(command);

          // Ensure connection is active (reconnect if needed)
          await manager.ensureConnected();

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

          // Append description as comment if provided
          const commandWithDescription = description
            ? `${sanitizedCommand} # ${sanitizeDescription(description)}`
            : sanitizedCommand;

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
  server.registerTool("sudo-exec", { description: "Execute a shell command on the remote SSH server using sudo. Will use sudo password if provided, otherwise assumes passwordless sudo.", inputSchema: z.object({
              client: z.string().optional().describe('Client name from the configured inventory. Omit when the server is pinned to a single host.'),
              command: z.string().describe("Shell command to execute with sudo on the remote SSH server"),
              description: z.string().optional().describe("Optional description of what this command will do"),
              maxBytes: z.number().int().optional().describe("Max output bytes before head+tail truncation; 0 disables. Defaults to server config."),
            }) }, async ({ client, command, description, maxBytes }) => {
              try {
                const { manager } = await getConnectionManager(client, true);
                const sanitizedCommand = sanitizeCommand(command);

                await manager.ensureConnected();

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

// New function that uses persistent connection
export async function execSshCommandWithConnection(
  manager: SSHConnectionManager,
  command: string,
  stdin?: string,
  maxBytes: number = 8192,
  timeoutMs: number = DEFAULT_TIMEOUT,
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

// Keep the old function for backward compatibility (used in tests)
export async function execSshCommand(sshConfig: any, command: string, stdin?: string, maxBytes: number = 8192): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;

    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Try to abort the running command before closing connection
        const abortTimeout = setTimeout(() => {
          // If abort command itself times out, force close connection
          conn.end();
        }, 5000); // 5 second timeout for abort command

        conn.exec('timeout 3s pkill -f \'' + escapeCommandForShell(command) + '\' 2>/dev/null || true', (err: Error | undefined, abortStream: ClientChannel | undefined) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });
        reject(new ProtocolError(ProtocolErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);

    conn.on('ready', () => {
      conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new ProtocolError(ProtocolErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }
        // If stdin provided, write it to the stream and end stdin
        if (stdin && stdin.length > 0) {
          try {
            stream.write(stdin);
          } catch (e) {
            // ignore
          }
        }
        try { stream.end(); } catch (e) { /* ignore */ }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number | null, signal: string | null) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            resolve(formatCommandResult({ stdout, stderr, exitCode: code, signal }, maxBytes));
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err: Error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new ProtocolError(ProtocolErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });
    conn.connect(buildConnectConfig(sshConfig));
  });
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
