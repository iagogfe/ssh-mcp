// The `su -` elevation handshake: the largest piece of src/index.ts that never
// ran under test, because it needs a PTY that answers a password prompt.
//
// A fake ssh2 Client supplies that PTY. The fake reacts to what the code
// WRITES, so the ordering the real handshake depends on is preserved: the
// prompt only appears after `su -`, and the readiness sentinel only echoes
// after the code has actually emitted it. A fake that answered early would
// pass while the real ordering was broken.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSHConnectionManager } from '../src/index';

type ShellScript = (shell: any, chunk: string) => void;

const hooks = vi.hoisted(() => ({
  onShellWrite: null as null | ((shell: any, chunk: string) => void),
  shellErr: null as null | string,
  shells: [] as any[],
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events');
  class FakeShell extends EventEmitter {
    written: string[] = [];
    ended = false;
    write(chunk: any) {
      const s = String(chunk);
      this.written.push(s);
      // Answered on a later microtask, never inside write(). The real PTY
      // cannot reply before the writing tick finishes, and ensureElevated
      // depends on that: it flips `probeSent` on the line AFTER writing the
      // sentinel, so a synchronous echo would arrive too early and be ignored.
      queueMicrotask(() => hooks.onShellWrite?.(this, s));
      return true;
    }
    end() { this.ended = true; }
  }
  class Client extends EventEmitter {
    _sock = { destroyed: false };
    connect() { setTimeout(() => this.emit('ready'), 0); }
    shell(_opts: any, cb: (e: Error | undefined, ch?: any) => void) {
      // Also deferred: ssh2 opens a channel over the wire, so its callback
      // never runs inside the `new Promise` executor that called it.
      setTimeout(() => {
        if (hooks.shellErr) { cb(new Error(hooks.shellErr)); return; }
        const s = new FakeShell();
        hooks.shells.push(s);
        cb(undefined, s);
      }, 0);
    }
    exec(_cmd: string, cb: any) { cb(new Error('not used here')); }
    end() { this._sock.destroyed = true; }
  }
  return { Client };
});

const cfg = { host: '10.0.0.5', port: 22, username: 'deploy', password: 'pw', insecureHostKey: true };

// A connected manager with no elevation attempted yet, so each test drives the
// handshake itself instead of inheriting connect()'s.
async function connected(extra: Record<string, unknown> = {}) {
  const m = new SSHConnectionManager({ ...cfg, ...extra } as any);
  await m.connect();
  return m;
}

function elevate(m: SSHConnectionManager, password = 'r00t'): Promise<void> {
  (m as any).sshConfig.suPassword = password;
  return (m as any).ensureElevated();
}

// The happy path: prompt after `su -`, sentinel echoed back after the code
// emits it.
const succeeds: ShellScript = (shell, chunk) => {
  if (chunk.startsWith('su -')) shell.emit('data', Buffer.from('Password: '));
  else if (chunk.includes('SSH_MCP""_READY_')) {
    const token = chunk.match(/SSH_MCP""_READY_(\w+)/)![1];
    shell.emit('data', Buffer.from(`SSH_MCP_READY_${token}\n`));
  }
};

beforeEach(() => { hooks.onShellWrite = null; hooks.shellErr = null; hooks.shells.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('su elevation', () => {
  it('sends the password only after the prompt, then accepts the shell on its own sentinel', async () => {
    hooks.onShellWrite = succeeds;
    const m = await connected();

    await elevate(m);

    expect(m.isRootShell()).toBe(true);
    const [shell] = hooks.shells;
    expect(shell.written[0]).toBe('su -\n');
    expect(shell.written[1], 'senha enviada antes do prompt').toBe('r00t\n');
    // PTY echo off, or the command's own input would be mixed into its output.
    expect(shell.written[2]).toContain('stty -echo');
    m.close();
  });

  it('does not send the password before a prompt appears', async () => {
    // The shell says nothing at all. Nothing may be written past `su -`.
    hooks.onShellWrite = () => {};
    vi.useFakeTimers();
    const m = new SSHConnectionManager({ ...cfg, host: 'quiet.internal' } as any);
    const conn = m.connect();
    await vi.advanceTimersByTimeAsync(1);
    await conn;

    const pending = elevate(m);
    // Claimed before the clock moves: the 10s timer rejects inside the advance
    // below, and a handler attached afterwards arrives too late -- Node has
    // already flagged the rejection as unhandled.
    const settled = expect(pending).rejects.toThrow(/su elevation timed out/);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(hooks.shells[0].written, 'escreveu antes do prompt').toEqual(['su -\n']);

    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it('rejects when su reports an authentication failure', async () => {
    hooks.onShellWrite = (shell, chunk) => {
      if (chunk.startsWith('su -')) shell.emit('data', Buffer.from('Password: '));
      else if (chunk === 'r00t\n') shell.emit('data', Buffer.from('su: Authentication failure\n'));
    };
    const m = await connected();

    await expect(elevate(m)).rejects.toThrow(/su authentication failed/);
    expect(m.isRootShell(), 'shell falho nao pode virar shell root').toBe(false);
    expect(hooks.shells[0].ended, 'shell falho tem que ser encerrado').toBe(true);
    m.close();
  });

  it('takes the auth failure over the sentinel, even though the failed su still echoes it', async () => {
    // su prints its failure first and drops back to the unprivileged shell,
    // which happily runs the sentinel. Accepting that would hand the caller a
    // NON-root shell it believes is root.
    hooks.onShellWrite = (shell, chunk) => {
      if (chunk.startsWith('su -')) shell.emit('data', Buffer.from('Password: '));
      else if (chunk === 'r00t\n') shell.emit('data', Buffer.from('su: incorrect password\n'));
      else if (chunk.includes('SSH_MCP""_READY_')) {
        const token = chunk.match(/SSH_MCP""_READY_(\w+)/)![1];
        shell.emit('data', Buffer.from(`SSH_MCP_READY_${token}\n`));
      }
    };
    const m = await connected();

    await expect(elevate(m)).rejects.toThrow(/su authentication failed/);
    expect(m.isRootShell()).toBe(false);
    m.close();
  });

  it('reports a shell that cannot be opened at all', async () => {
    const m = await connected();
    hooks.shellErr = 'administratively prohibited';

    await expect(elevate(m)).rejects.toThrow(/Failed to start interactive shell for su/);
    m.close();
  });

  it('reports a shell that closes mid-handshake', async () => {
    hooks.onShellWrite = (shell, chunk) => {
      if (chunk.startsWith('su -')) shell.emit('close');
    };
    const m = await connected();

    await expect(elevate(m)).rejects.toThrow(/su shell closed before elevation completed/);
    m.close();
  });

  it('is idempotent: a second call reuses the shell instead of opening another', async () => {
    hooks.onShellWrite = succeeds;
    const m = await connected();

    await elevate(m);
    await elevate(m);

    expect(hooks.shells).toHaveLength(1);
    m.close();
  });

  it('shares one handshake between concurrent callers', async () => {
    hooks.onShellWrite = succeeds;
    const m = await connected();
    (m as any).sshConfig.suPassword = 'r00t';

    await Promise.all([
      (m as any).ensureElevated(),
      (m as any).ensureElevated(),
      (m as any).ensureElevated(),
    ]);

    expect(hooks.shells, 'cada chamador abriu seu proprio shell').toHaveLength(1);
    m.close();
  });

  it('does nothing when no su password is configured', async () => {
    const m = await connected();
    await expect((m as any).ensureElevated()).resolves.toBeUndefined();
    expect(hooks.shells).toHaveLength(0);
    m.close();
  });

  it('lets a later attempt retry after a failed one', async () => {
    // A rejected in-flight promise must not be cached, or the connection is
    // stuck failing elevation forever.
    hooks.shellErr = 'transient';
    const m = await connected();
    await expect(elevate(m)).rejects.toThrow();

    hooks.shellErr = null;
    hooks.onShellWrite = succeeds;
    await elevate(m);
    expect(m.isRootShell()).toBe(true);
    m.close();
  });
});

describe('elevation through the public surface', () => {
  it('elevates during connect when a su password is configured', async () => {
    hooks.onShellWrite = succeeds;
    const m = new SSHConnectionManager({ ...cfg, suPassword: 'r00t' } as any);

    await m.connect();

    expect(m.isRootShell(), 'connect nao elevou').toBe(true);
    m.close();
  });

  it('still completes the connection when elevation fails', async () => {
    // A host where su is broken must stay usable as the unprivileged user
    // rather than losing the connection entirely.
    hooks.shellErr = 'no pty available';
    const m = new SSHConnectionManager({ ...cfg, suPassword: 'r00t' } as any);

    await expect(m.connect()).resolves.toBeUndefined();
    expect(m.isConnected()).toBe(true);
    expect(m.isRootShell()).toBe(false);
    m.close();
  });

  it('setSuPassword elevates when given a password', async () => {
    hooks.onShellWrite = succeeds;
    const m = await connected();

    await m.setSuPassword('r00t');

    expect(m.isRootShell()).toBe(true);
    expect(m.getSuPassword()).toBe('r00t');
    m.close();
  });

  it('setSuPassword swallows an elevation failure instead of breaking the caller', async () => {
    hooks.shellErr = 'no pty available';
    const m = await connected();

    await expect(m.setSuPassword('r00t')).resolves.toBeUndefined();
    expect(m.isRootShell()).toBe(false);
    m.close();
  });

  it('close ends the elevated shell along with the connection', async () => {
    hooks.onShellWrite = succeeds;
    const m = await connected();
    await elevate(m);

    m.close();

    expect(hooks.shells[0].ended, 'shell root ficou aberto apos close()').toBe(true);
    expect(m.isRootShell()).toBe(false);
    expect(m.isConnected()).toBe(false);
  });
});
