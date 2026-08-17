import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SSHConnectionManager, runInTmux, jobStatus, ensureMode, execSshCommandWithConnection } from '../src/index';

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

  it('reports a completed job\'s own stderr without a bogus duplicate exit line', async () => {
    // A nonzero job exit code with real stderr is the case that exposes the
    // bug plainly: the status *script* itself always exits 0, so a job's
    // stderr written to the script's own real stderr stream makes
    // formatCommandResult reformat the script's own exit-0 result (any
    // non-empty stderr triggers that, regardless of exit code) into a bogus
    // "[exit 0]" -- distinct from, and printed before, the job's real
    // "[exit 3]" the outer formatCommandResult call adds afterward. Two
    // different exit lines for one job.
    const start: any = await runInTmux(m, 'echo out1; echo err1 >&2; exit 3', {
      kind: 'exec', detach: true, maxBytes: 0,
    });
    const id = text(start).match(/jobId=([A-Za-z0-9]+)/)?.[1];
    expect(id).toBeTruthy();

    let done: any;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = await jobStatus(m, id!, 0);
      if (!text(done).includes('[running]')) break;
    }
    const t = text(done);
    expect(t).toContain('out1');
    expect(t).toContain('stderr:');
    expect(t).toContain('err1');
    expect(t).toContain('[exit 3]');
    expect((t.match(/\[exit \d+\]/g) || []).length).toBe(1);
  }, 60000);

  it('rejects an unknown jobId', async () => {
    await expect(jobStatus(m, 'nosuchtoken', 0)).rejects.toThrow(/unknown jobId/i);
  }, 30000);

  it('does not let the session shell block on a detached job', async () => {
    await runInTmux(m, 'sleep 30', { kind: 'exec', detach: true, maxBytes: 0 });
    const r = await runInTmux(m, 'echo responsive', { kind: 'exec', maxBytes: 0 });
    expect(text(r)).toContain('responsive');
  }, 30000);

  it('surfaces a failed launch on the detach path instead of a phantom jobId', async () => {
    // Force the *launcher* script itself to fail (not the eventual
    // backgrounded job) by making the session's workdir unwritable, so
    // `cat > "$D/cmd.$T"` genuinely fails under set -eu before tmux
    // send-keys ever runs.
    await runInTmux(m, 'true', { kind: 'exec', maxBytes: 0 }); // ensures $D exists
    const dirRes = await execSshCommandWithConnection(
      m,
      `tmux show-environment -t ${m.getTmuxSession()} SSH_MCP_DIR | sed -n 's/^SSH_MCP_DIR=//p'`,
      undefined,
      0,
    );
    const dir = text(dirRes).trim();
    expect(dir).toMatch(/ssh-mcp\./);

    await execSshCommandWithConnection(m, `chmod 555 '${dir}'`, undefined, 0);
    try {
      const res: any = await runInTmux(m, 'echo should-not-run', {
        kind: 'exec', detach: true, maxBytes: 0,
      });
      expect(res.isError).toBe(true);
      expect(text(res)).not.toContain('[detached]');
    } finally {
      await execSshCommandWithConnection(m, `chmod 700 '${dir}'`, undefined, 0);
    }
  }, 30000);
});

describe('tmux session against a dash-shelled pane (live SSH + tmux)', () => {
  const dashSession = 'ssh-mcp-test-dash';

  it('exit N (mid-script and inside a subshell) stops the sourced command without killing the dash pane', async () => {
    const setup = new SSHConnectionManager(cfg);
    await setup.connect();
    await ensureMode(setup);
    // preamble() only creates a session when one doesn't already exist, so
    // pre-creating this one with dash as its pane command makes runInTmux
    // reuse a REAL dash pane -- the exact shell Critical 1 named (dash
    // rejects `exit(){...}` outright as a special built-in; bash's
    // return-from-function-frame bug is a different failure mode). Alpine's
    // busybox ash (the container's own default /bin/sh) is not a substitute
    // for either.
    await execSshCommandWithConnection(
      setup,
      `tmux kill-session -t ${dashSession} 2>/dev/null; tmux new-session -d -s ${dashSession} dash`,
      undefined,
      0,
    );

    const dm = new SSHConnectionManager({ ...cfg, tmuxSession: dashSession });
    await dm.connect();
    await ensureMode(dm);

    try {
      const mid: any = await runInTmux(dm, 'echo a; exit 3; echo b', { kind: 'exec', maxBytes: 0 });
      expect(mid.isError).toBe(true);
      expect(text(mid)).toContain('a');
      expect(text(mid)).not.toContain('b');
      expect(text(mid)).toContain('[exit 3]');

      const sub: any = await runInTmux(dm, '( exit 5; echo BOOM ); echo AFTER', { kind: 'exec', maxBytes: 0 });
      expect(text(sub)).toContain('AFTER');
      expect(text(sub)).not.toContain('BOOM');

      // the dash pane -- and the tmux session it's the only pane of -- must
      // still be alive and usable after both.
      const after = await runInTmux(dm, 'echo still-alive', { kind: 'exec', maxBytes: 0 });
      expect(text(after)).toContain('still-alive');
    } finally {
      dm.close();
      try {
        await execSshCommandWithConnection(setup, `tmux kill-session -t ${dashSession} 2>/dev/null || true`, undefined, 0);
      } catch { /* ignore */ }
      setup.close();
    }
  }, 30000);
});
