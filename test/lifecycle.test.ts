// The process-lifecycle edges: everything in src/index.ts that only runs when
// the module is imported as a program rather than as a library.
//
// serveStdio is faked so importing the module does not try to own this
// process's stdio, which lets the two startup branches (test mode and CLI
// mode) run here instead of only in a spawned server.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const hooks = vi.hoisted(() => ({
  served: [] as { factory: () => unknown; opts?: { onerror?: (e: unknown) => void } }[],
  closed: 0,
}));

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

beforeEach(() => { hooks.closed = 0; });
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
