// Concurrent tool calls each open their own SSH channel. sshd caps that with
// MaxSessions (10 by default), and the excess is refused with
// "(SSH) Channel open failure: open failed" -- measured on a live host as an
// exact cliff: 10 concurrent calls all succeeded, 11, 12, 20 and 30 each landed
// exactly 10 and failed the rest.
//
// Opening more than the cap buys nothing anyway: in tmux mode every command
// serialises through the one pane, so the extra channels only queue. Holding
// callers in a client-side queue produces the same throughput without the
// failures, and without a cryptic protocol error reaching the agent.
import { describe, it, expect } from 'vitest';
import { SSHConnectionManager, isRetryableChannelError } from '../src/index';

const cfg = { host: '127.0.0.1', port: 22, username: 'test', password: 'test' };

describe('channel concurrency cap', () => {
  it('admits up to the cap without waiting', async () => {
    const m = new SSHConnectionManager({ ...cfg, maxConcurrent: 3 });
    await m.acquireChannel();
    await m.acquireChannel();
    await m.acquireChannel();
    expect(m.activeChannels()).toBe(3);
    m.releaseChannel(); m.releaseChannel(); m.releaseChannel();
    expect(m.activeChannels()).toBe(0);
  });

  it('queues the caller past the cap instead of letting it open a channel', async () => {
    const m = new SSHConnectionManager({ ...cfg, maxConcurrent: 2 });
    await m.acquireChannel();
    await m.acquireChannel();

    let admitted = false;
    const pending = m.acquireChannel().then(() => { admitted = true; });

    await new Promise((r) => setTimeout(r, 20));
    expect(admitted, 'terceiro chamador entrou antes de haver vaga').toBe(false);
    expect(m.activeChannels()).toBe(2);

    m.releaseChannel();
    await pending;
    expect(admitted).toBe(true);
    expect(m.activeChannels()).toBe(2);
  });

  it('never admits more than the cap under a burst', async () => {
    const m = new SSHConnectionManager({ ...cfg, maxConcurrent: 4 });
    let peak = 0;
    await Promise.all(
      Array.from({ length: 25 }, () => (async () => {
        await m.acquireChannel();
        peak = Math.max(peak, m.activeChannels());
        await new Promise((r) => setTimeout(r, 5));
        m.releaseChannel();
      })()),
    );
    expect(peak).toBe(4);
    expect(m.activeChannels()).toBe(0);
  });

  it('releases the slot even when the caller throws', async () => {
    const m = new SSHConnectionManager({ ...cfg, maxConcurrent: 1 });
    await m.acquireChannel();
    try {
      throw new Error('boom');
    } catch {
      m.releaseChannel();
    }
    expect(m.activeChannels()).toBe(0);
    await m.acquireChannel();
    expect(m.activeChannels()).toBe(1);
  });

  it('defaults below the usual sshd MaxSessions of 10', () => {
    const m = new SSHConnectionManager(cfg);
    expect(m.maxConcurrentChannels()).toBeLessThan(10);
    expect(m.maxConcurrentChannels()).toBeGreaterThan(1);
  });
});

describe('channel-open retry', () => {
  // The cap alone did not fully clear the failures on a live host: 20 concurrent
  // calls still lost 2, 50 lost 2, and the loss tracked churn rather than
  // steady-state count. sshd does not free a session slot the instant our side
  // closes the channel, so the next open can still land over MaxSessions.
  //
  // Retrying is safe *specifically* for this error: a failed channel open means
  // the command never reached the host, so re-running it cannot double-execute.
  it('recognises a channel-open failure as retryable', () => {
    expect(isRetryableChannelError(new Error('(SSH) Channel open failure: open failed'))).toBe(true);
    expect(isRetryableChannelError(new Error('Channel open failure: administratively prohibited'))).toBe(true);
  });

  it('does not retry errors that may mean the command already ran', () => {
    expect(isRetryableChannelError(new Error('Command execution timed out after 60000ms'))).toBe(false);
    expect(isRetryableChannelError(new Error('SSH connection error: read ECONNRESET'))).toBe(false);
    expect(isRetryableChannelError(new Error('No response from server'))).toBe(false);
    expect(isRetryableChannelError(undefined)).toBe(false);
  });
});

describe('shared su shell', () => {
  // The su path writes into an already-open stream. Making it wait on a channel
  // slot both wasted budget it never spends and pushed its first write past a
  // microtask, breaking callers that read the stream synchronously.
  it('does not consume a channel slot', async () => {
    const { EventEmitter } = await import('events');
    class FakeShell extends EventEmitter {
      written: string[] = [];
      write(c: string) { this.written.push(c); }
      end() {}
    }
    const m = new SSHConnectionManager({ ...cfg, maxConcurrent: 1 });
    const shell = new FakeShell();
    (m as any).conn = new EventEmitter();
    (m as any).suShell = shell;
    (m as any).isElevated = true;

    const { execSshCommandWithConnection } = await import('../src/index');
    void execSshCommandWithConnection(m, 'id -u', undefined, 8192);

    // Synchronous up to the first write, and no slot taken.
    expect(shell.written.some((w) => w.startsWith('id -u'))).toBe(true);
    expect(m.activeChannels()).toBe(0);
  });
});
