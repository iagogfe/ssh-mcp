// The process-lifecycle edges and the legacy one-shot exec path -- everything
// in src/index.ts that only runs when the module is imported as a program
// rather than as a library.
//
// serveStdio is faked so importing the module does not try to own this
// process's stdio, which lets the two startup branches (test mode and CLI
// mode) run here instead of only in a spawned server.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

type ExecReply = {
  stdout?: string; stderr?: string; code?: number | null;
  err?: Error; hang?: boolean; noStream?: boolean;
};

const hooks = vi.hoisted(() => ({
  exec: null as null | ((cmd: string, n: number) => ExecReply),
  execCalls: [] as string[],
  connectFail: null as null | string,
  ended: 0,
  served: [] as { factory: () => unknown; opts?: { onerror?: (e: unknown) => void } }[],
  closed: 0,
}));

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events');
  class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    write() { return true; }
    end() {}
  }
  class Client extends EventEmitter {
    _sock = { destroyed: false };
    connect() {
      setTimeout(() => {
        if (hooks.connectFail) this.emit('error', new Error(hooks.connectFail));
        else this.emit('ready');
      }, 0);
    }
    exec(cmd: string, cb: (e: Error | undefined, ch?: any) => void) {
      const reply = hooks.exec ? hooks.exec(cmd, hooks.execCalls.length) : {};
      hooks.execCalls.push(cmd);
      if (reply.err) { cb(reply.err); return; }
      if (reply.noStream) { cb(undefined, undefined); return; }
      const ch = new FakeChannel();
      cb(undefined, ch);
      if (reply.hang) return;
      setTimeout(() => {
        if (reply.stdout) ch.emit('data', Buffer.from(reply.stdout));
        if (reply.stderr) ch.stderr.emit('data', Buffer.from(reply.stderr));
        ch.emit('close', reply.code === undefined ? 0 : reply.code, null);
      }, 0);
    }
    shell(_o: any, cb: any) { cb(new Error('not used here')); }
    end() { hooks.ended += 1; this._sock.destroyed = true; }
  }
  return { Client };
});

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeMcpServer { registerTool() {} }
  return { ...actual, McpServer: FakeMcpServer };
});

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: (factory: any, opts?: any) => {
    hooks.served.push({ factory, opts });
    return { close: async () => { hooks.closed += 1; } };
  },
}));

process.setMaxListeners(50);
vi.setConfig({ testTimeout: 30_000 });

const ENV_KEYS = ['SSH_MCP_DISABLE_MAIN', 'SSH_MCP_TEST', 'SSH_MCP_HOST', 'SSH_MCP_USER', 'SSH_MCP_PASSWORD'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const savedArgv = process.argv;

async function importAs(env: Record<string, string>, argv: string[] = ['node', 'index.js']) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = argv;
  hooks.served.length = 0;
  vi.resetModules();
  return import('../src/index');
}

beforeEach(() => {
  hooks.exec = null; hooks.execCalls.length = 0; hooks.connectFail = null;
  hooks.ended = 0; hooks.closed = 0;
});
afterAll(() => {
  process.argv = savedArgv;
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(savedEnv).filter(([, v]) => v !== undefined)));
});

describe('startup', () => {
  it('serves over stdio in test mode, with an error hook that does not throw', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
    try {
      await importAs({ SSH_MCP_TEST: '1', SSH_MCP_HOST: '10.0.0.9', SSH_MCP_USER: 'deploy' });

      expect(hooks.served).toHaveLength(1);
      // One MCP server per process: the factory is the same instance every call.
      const { factory, opts } = hooks.served[0];
      expect(factory()).toBe(factory());
      // A transport-level error must be logged, never rethrown into the loop.
      expect(() => opts!.onerror!(new Error('protocolo quebrado'))).not.toThrow();
      expect(errors.join('\n')).toContain('protocolo quebrado');
    } finally { spy.mockRestore(); }
  });

  it('starts in CLI mode and shuts down cleanly on a signal', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const before = process.listeners('SIGINT').length;
    try {
      await importAs({ SSH_MCP_HOST: '10.0.0.9', SSH_MCP_USER: 'deploy' },
        ['node', 'index.js', '--host=10.0.0.9', '--user=deploy']);
      expect(hooks.served).toHaveLength(1);

      const added = process.listeners('SIGINT').slice(before);
      expect(added, 'main() nao registrou handler de SIGINT').toHaveLength(1);
      (added[0] as () => void)();

      expect(hooks.closed, 'transporte nao foi fechado').toBe(1);
      expect(exit).toHaveBeenCalledWith(0);
      // Both signals get the same handler.
      for (const h of added) process.removeListener('SIGINT', h as any);
      for (const h of process.listeners('SIGTERM').slice(0, 0)) void h;
    } finally { spy.mockRestore(); exit.mockRestore(); }
  });

  it('refuses to start with neither a host nor an inventory', async () => {
    await expect(importAs({}, ['node', 'index.js']))
      .rejects.toThrow(/Missing target/);
  });
});

describe('escapeCommandForShell', () => {
  it('closes and reopens the quote around each single quote', async () => {
    const { escapeCommandForShell } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    // Wrapped in '...', the result must survive as one shell word.
    expect(escapeCommandForShell(`echo 'oi'`)).toBe(`echo '"'"'oi'"'"'`);
    expect(escapeCommandForShell('echo oi')).toBe('echo oi');
  });
});

describe('execSshCommand (legacy one-shot path)', () => {
  const cfg = { host: '10.0.0.9', port: 22, username: 'deploy', password: 'pw', insecureHostKey: true };

  it('connects, runs, and closes the connection behind it', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    hooks.exec = () => ({ stdout: 'oi\n' });

    const res = await execSshCommand(cfg, 'echo oi');

    expect(res.content[0].text).toContain('oi');
    expect(hooks.ended, 'conexao de uso unico ficou aberta').toBe(1);
  });

  it('feeds stdin and reports a non-zero exit', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    hooks.exec = () => ({ stderr: 'sem permissao\n', code: 1 });

    const res = await execSshCommand(cfg, 'sudo -S true', 'senha\n');
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('sem permissao');
  });

  it('reports an exec failure', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    hooks.exec = () => ({ err: new Error('open failed') });

    await expect(execSshCommand(cfg, 'true')).rejects.toThrow(/SSH exec error: open failed/);
    expect(hooks.ended).toBe(1);
  });

  it('reports a connection failure', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    hooks.connectFail = 'All configured authentication methods failed';

    await expect(execSshCommand(cfg, 'true')).rejects.toThrow(/SSH connection error/);
  });

  it('tries to kill the remote command before giving up on a timeout', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    vi.useFakeTimers();
    try {
      hooks.exec = (_c, n) => (n === 0 ? { hang: true } : {});
      const pending = execSshCommand(cfg, `echo 'oi'`);
      const settled = expect(pending).rejects.toThrow(/timed out after 60000ms/);

      await vi.advanceTimersByTimeAsync(60_000);
      await settled;

      // The abort embeds the command in a single-quoted pkill pattern, so its
      // own quotes have to be escaped or the pattern ends early.
      expect(hooks.execCalls[1]).toContain('pkill -f');
      expect(hooks.execCalls[1]).toContain(`'"'"'oi'"'"'`);

      // The abort's own stream closing is what releases the connection.
      await vi.advanceTimersByTimeAsync(10);
      expect(hooks.ended).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('closes the connection even when the abort itself cannot start', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    vi.useFakeTimers();
    try {
      hooks.exec = (_c, n) => (n === 0 ? { hang: true } : { noStream: true });
      const pending = execSshCommand(cfg, 'sleep 999');
      const settled = expect(pending).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(60_000);
      await settled;

      expect(hooks.ended, 'conexao vazou quando o abort nao abriu canal').toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('force-closes the connection when the abort command hangs too', async () => {
    const { execSshCommand } = await importAs({ SSH_MCP_DISABLE_MAIN: '1' });
    vi.useFakeTimers();
    try {
      hooks.exec = () => ({ hang: true });
      const pending = execSshCommand(cfg, 'sleep 999');
      const settled = expect(pending).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
      expect(hooks.ended, 'fechou antes do prazo do abort').toBe(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(hooks.ended, 'abort travado deixou a conexao aberta').toBe(1);
    } finally { vi.useRealTimers(); }
  });
});
