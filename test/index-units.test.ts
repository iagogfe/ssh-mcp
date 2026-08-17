// Unit coverage for the parts of src/index.ts that need no SSH: the connection
// manager's own bookkeeping, and buildConnectConfig's host-key verifier.
//
// Deliberately does NOT cover execSshCommand or escapeCommandForShell: both are
// slated for deletion (no production caller), and covering code on its way out
// is work thrown away.
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SSHConnectionManager, buildConnectConfig, sshKeyFingerprintSha256 } from '../src/index';

const base = { host: '10.0.0.1', port: 22, username: 'deploy' };
let m: SSHConnectionManager | null = null;
afterEach(() => { m?.close(); m = null; });

describe('SSHConnectionManager bookkeeping', () => {
  it('is not connected before connect, and close on a fresh manager is a no-op', () => {
    m = new SSHConnectionManager(base);
    expect(m.isConnected()).toBe(false);
    expect(() => m!.close()).not.toThrow();
    expect(m.isConnected()).toBe(false);
  });

  it('throws a useful error when asked for a connection it never opened', () => {
    m = new SSHConnectionManager(base);
    expect(() => m!.getConnection()).toThrow(/not established/i);
  });

  it('carries the sudo password through its accessor', () => {
    m = new SSHConnectionManager({ ...base, sudoPassword: 'first' });
    expect(m.getSudoPassword()).toBe('first');
    m.setSudoPassword('second');
    expect(m.getSudoPassword()).toBe('second');
    m.setSudoPassword(undefined);
    expect(m.getSudoPassword()).toBeUndefined();
  });

  it('reports the su password only when one was configured', () => {
    expect(new SSHConnectionManager(base).getSuPassword()).toBeUndefined();
    expect(new SSHConnectionManager({ ...base, suPassword: 'r00t' }).getSuPassword()).toBe('r00t');
  });

  it('is not a root shell until elevation actually completed', () => {
    // suPassword alone does not make it root: the shell has to exist.
    m = new SSHConnectionManager({ ...base, suPassword: 'r00t' });
    expect(m.isRootShell()).toBe(false);
  });

  it('issues a distinct token every call, matching the token charset', () => {
    m = new SSHConnectionManager(base);
    const seen = new Set(Array.from({ length: 50 }, () => m!.nextToken()));
    expect(seen.size).toBe(50);
    for (const t of seen) expect(t).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('gives two managers different token namespaces', () => {
    // The workdir outlives a restart, so two instances sharing a session must
    // not hand out the same token and collide on each other's rc/out files.
    const a = new SSHConnectionManager(base);
    const b = new SSHConnectionManager(base);
    expect(a.nextToken()).not.toBe(b.nextToken());
    a.close(); b.close();
  });

  it('defaults the tmux session name and honours an override', () => {
    expect(new SSHConnectionManager(base).getTmuxSession()).toBe('ssh-mcp');
    expect(new SSHConnectionManager({ ...base, tmuxSession: 'deploy' }).getTmuxSession()).toBe('deploy');
  });

  it('has no probe result before one is resolved', () => {
    m = new SSHConnectionManager(base);
    expect(m.getProbe()).toBeNull();
  });
});

describe('buildConnectConfig host key verifier', () => {
  const key = Buffer.from('a-host-key');

  it('accepts a key matching a pinned fingerprint', () => {
    const cfg = buildConnectConfig({ ...base, hostFingerprint: sshKeyFingerprintSha256(key) });
    expect(cfg.hostVerifier(key)).toBe(true);
  });

  it('rejects a key that does not match the pinned fingerprint', () => {
    const cfg = buildConnectConfig({ ...base, hostFingerprint: 'SHA256:AAAAdefinitelynotit' });
    expect(cfg.hostVerifier(key)).toBe(false);
  });

  it('accepts any key when verification is explicitly disabled', () => {
    const cfg = buildConnectConfig({ ...base, insecureHostKey: true });
    expect(cfg.hostVerifier(Buffer.from('anything at all'))).toBe(true);
  });

  it('accepts a key present in known_hosts, and rejects one that is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kh-'));
    const kh = join(dir, 'known_hosts');
    writeFileSync(kh, `10.0.0.1 ssh-ed25519 ${key.toString('base64')}\n`);

    const cfg = buildConnectConfig({ ...base, knownHostsPath: kh });
    expect(cfg.hostVerifier(key)).toBe(true);
    expect(cfg.hostVerifier(Buffer.from('a different key'))).toBe(false);
  });

  it('rejects when known_hosts cannot be read at all', () => {
    const cfg = buildConnectConfig({ ...base, knownHostsPath: '/nonexistent/known_hosts' });
    expect(cfg.hostVerifier(key)).toBe(false);
  });

  it('passes the ssh2 connect fields through untouched', () => {
    const cfg = buildConnectConfig({ ...base, password: 'secret' });
    expect(cfg.host).toBe('10.0.0.1');
    expect(cfg.port).toBe(22);
    expect(cfg.username).toBe('deploy');
    expect(cfg.password).toBe('secret');
  });
});
