import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SSHConnectionManager, runInTmux, jobStatus, ensureMode } from '../src/index';

const host = process.env.SSH_HOST || '127.0.0.1';
const port = Number(process.env.SSH_PORT || 2222);
const username = process.env.SSH_USER || 'test';
const password = process.env.SSH_PASSWORD || 'secret';

const cfg = { host, port, username, password, insecureHostKey: true, tmuxSession: 'ssh-mcp-test' };
const text = (r: any) => r.content[0].text as string;

describe('tmux session (live SSH + tmux)', () => {
  let m: SSHConnectionManager;

  beforeEach(async () => {
    m = new SSHConnectionManager(cfg);
    await m.connect();
    expect(await ensureMode(m)).toBe('tmux');
  });

  afterEach(async () => {
    try {
      await runInTmux(m, 'true', { kind: 'exec', maxBytes: 0 });
    } catch { /* ignore */ }
    m.close();
  });

  it('keeps the working directory between calls', async () => {
    await runInTmux(m, 'cd /tmp', { kind: 'exec', maxBytes: 0 });
    const r = await runInTmux(m, 'pwd', { kind: 'exec', maxBytes: 0 });
    expect(text(r).trim()).toBe('/tmp');
  }, 30000);

  it('keeps exported environment between calls', async () => {
    await runInTmux(m, 'export SSH_MCP_PROBE=bar', { kind: 'exec', maxBytes: 0 });
    const r = await runInTmux(m, 'echo "[$SSH_MCP_PROBE]"', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('[bar]');
  }, 30000);

  it('reuses the same shell process', async () => {
    const a = text(await runInTmux(m, 'echo $$', { kind: 'exec', maxBytes: 0 })).trim();
    const b = text(await runInTmux(m, 'echo $$', { kind: 'exec', maxBytes: 0 })).trim();
    expect(a).toBe(b);
    expect(a).toMatch(/^\d+$/);
  }, 30000);

  it('preserves a two-digit exit code', async () => {
    const r: any = await runInTmux(m, 'exit 10', { kind: 'exec', maxBytes: 0 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('[exit 10]');
  }, 30000);

  it('keeps stderr separate from stdout', async () => {
    const r: any = await runInTmux(m, 'echo out; echo err >&2', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('out');
    expect(text(r)).toContain('stderr:');
    expect(text(r)).toContain('err');
  }, 30000);

  it('does not wrap a long line', async () => {
    const r = await runInTmux(m, 'printf "%0.sx" $(seq 1 500); echo', { kind: 'exec', maxBytes: 0 });
    const line = text(r).split('\n').find((l) => l.startsWith('x'));
    expect(line?.length).toBe(500);
  }, 30000);

  it('a timed-out command does not contaminate the next one', async () => {
    const slow = new SSHConnectionManager(cfg);
    await slow.connect();
    await ensureMode(slow);
    await expect(
      runInTmux(slow, 'sleep 120; echo POISON', { kind: 'exec', maxBytes: 0, timeoutMs: 2000 }),
    ).rejects.toThrow(/timed out/i);

    const r = await runInTmux(slow, 'echo clean', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('clean');
    expect(text(r)).not.toContain('POISON');
    slow.close();
  }, 60000);

  it('runs a detached job and collects it', async () => {
    const start: any = await runInTmux(m, 'sleep 2; echo late; exit 3', {
      kind: 'exec', detach: true, maxBytes: 0,
    });
    const id = text(start).match(/jobId=([A-Za-z0-9]+)/)?.[1];
    expect(id).toBeTruthy();

    const running: any = await jobStatus(m, id!, 0);
    expect(text(running)).toContain('[running]');

    let done: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = await jobStatus(m, id!, 0);
      if (!text(done).includes('[running]')) break;
    }
    expect(text(done)).toContain('late');
    expect(text(done)).toContain('[exit 3]');
  }, 60000);

  it('rejects an unknown jobId', async () => {
    await expect(jobStatus(m, 'nosuchtoken', 0)).rejects.toThrow(/unknown jobId/i);
  }, 30000);

  it('does not let the session shell block on a detached job', async () => {
    await runInTmux(m, 'sleep 30', { kind: 'exec', detach: true, maxBytes: 0 });
    const r = await runInTmux(m, 'echo responsive', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('responsive');
  }, 30000);
});
