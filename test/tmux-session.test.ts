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

  it('documents a known, accepted limitation: exit inside a command-defined function only returns from that function', async () => {
    // The exit alias (see buildRunScript's comment) only stops the SOURCED
    // SCRIPT when `exit` is called at that script's own top level. A
    // die/fail-style helper the command defines itself calls the aliased
    // exit from inside ITS OWN function call frame, so it returns from that
    // function -- the guard is silently swallowed, execution continues past
    // the call site, and the real exit code (0, from the last command that
    // did run) hides the failure entirely.
    const r: any = await runInTmux(
      m,
      'die() { echo guard >&2; exit 1; }; die; echo REACHED_RM',
      { kind: 'exec', maxBytes: 0 },
    );
    expect(text(r)).toContain('REACHED_RM'); // the guard did not stop execution
    expect(r.isError).toBeFalsy(); // ...and the wrong exit code hides that too
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

  it('shows a running job\'s own stderr, not just its stdout', async () => {
    // Watching a running job's progress is the entire point of polling it --
    // build tools, curl, docker build, apt, all report progress on stderr.
    const start: any = await runInTmux(m, 'echo out1; echo err1 >&2; sleep 3; echo out2', {
      kind: 'exec', detach: true, maxBytes: 0,
    });
    const id = text(start).match(/jobId=([A-Za-z0-9]+)/)?.[1];
    expect(id).toBeTruthy();

    await new Promise((r) => setTimeout(r, 800)); // after out1/err1, well before sleep 3 ends
    const running: any = await jobStatus(m, id!, 0);
    expect(text(running)).toContain('[running]');
    expect(text(running)).toContain('out1');
    expect(text(running)).toContain('stderr:');
    expect(text(running)).toContain('err1');

    // drain it so it doesn't leak into later tests sharing the session
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!text(await jobStatus(m, id!, 0)).includes('[running]')) break;
    }
  }, 30000);

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
    // If dash wasn't actually found, tmux's own remain-on-exit default kills
    // the session the moment the dead pane's shell exits, and preamble()'s
    // create-first bootstrap would then silently recreate it with the
    // container's default shell on the very next call -- the lane would go
    // green having tested bash twice.
    // Assert the pane is genuinely running dash before trusting anything
    // that follows.
    const paneCmd = await execSshCommandWithConnection(
      setup,
      `tmux list-panes -t ${dashSession} -F '#{pane_current_command}'`,
      undefined,
      0,
    );
    expect(text(paneCmd).trim()).toBe('dash');

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

describe('tmux session bootstrap race (live SSH + tmux)', () => {
  // MCP clients issue parallel tool calls, and execSshCommandWithConnection
  // opens an independent channel per call -- so two concurrent execs against
  // a cold destination run preamble()'s session-bootstrap line concurrently.
  // A check-then-act `has-session || new-session` loses this race: both
  // racers see no session, both call new-session, and the loser gets tmux's
  // own "duplicate session" error, which set -eu turns into a hard failure
  // (isError, not a thrown exception -- execSshCommandWithConnection reports
  // a nonzero remote exit as a normal result). A fresh, never-attached
  // session name per run is what makes this genuinely cold; fanning out
  // several racers (not just two) keeps the race from being a coin flip.
  it('lets many concurrent cold-start calls create the same session without one losing to "duplicate session"', async () => {
    const session = 'ssh-mcp-race-' + Math.random().toString(36).slice(2, 8);
    const m = new SSHConnectionManager({ ...cfg, tmuxSession: session });
    await m.connect();
    expect(await ensureMode(m)).toBe('tmux');
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          runInTmux(m, `echo racer-${i}`, { kind: 'exec', maxBytes: 0 })),
      );
      for (const r of results as any[]) {
        expect(r.isError).not.toBe(true);
      }
    } finally {
      try {
        await execSshCommandWithConnection(m, `tmux kill-session -t ${session} 2>/dev/null || true`, undefined, 0);
      } catch { /* ignore */ }
      m.close();
    }
  }, 30000);
});
