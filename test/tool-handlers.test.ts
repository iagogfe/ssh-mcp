// The tool handlers -- exec, sudo-exec, job_status -- are the server's actual
// contract, and until now they were only ever exercised by spawning the built
// server and talking JSON-RPC to it. That proves the wire format, but a spawned
// process reports no coverage back here, so every decision inside a handler
// (mode routing, sudo wrapping, target resolution, error shaping) went
// unmeasured.
//
// Two fakes make the handlers reachable in-process without an SSH server and
// without touching production code:
//   - ssh2's Client, so connect/exec/shell are scriptable per test;
//   - McpServer, so registerTool hands the handler straight to the test.
// Everything between them is the real src/index.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ExecReply = { stdout?: string; stderr?: string; code?: number | null; err?: Error };

const hooks = vi.hoisted(() => ({
  // Answers each conn.exec(). Receives the command and the 0-based call index.
  exec: null as null | ((cmd: string, n: number) => ExecReply),
  execCalls: [] as { cmd: string; stdin: string }[],
  connectFail: null as null | string,
  tools: new Map<string, { cfg: any; handler: (args: any) => Promise<any> }>(),
  clients: [] as any[],
}));

vi.mock('ssh2', async () => {
  // Imported here, not at the top: vi.mock is hoisted above the import block.
  const { EventEmitter } = await import('events');
  class FakeChannel extends EventEmitter {
    stderr = new EventEmitter();
    stdin = '';
    write(chunk: any) { this.stdin += String(chunk); return true; }
    end() {}
  }
  class Client extends EventEmitter {
    _sock = { destroyed: false };
    connect() {
      hooks.clients.push(this);
      setTimeout(() => {
        if (hooks.connectFail) this.emit('error', new Error(hooks.connectFail));
        else this.emit('ready');
      }, 0);
    }
    exec(cmd: string, cb: (e: Error | undefined, ch?: any) => void) {
      const n = hooks.execCalls.length;
      const reply = hooks.exec ? hooks.exec(cmd, n) : { stdout: '', code: 0 };
      if (reply.err) { cb(reply.err); return; }
      const ch = new FakeChannel();
      cb(undefined, ch);
      // After the caller has attached its listeners, never before.
      setTimeout(() => {
        hooks.execCalls.push({ cmd, stdin: ch.stdin });
        if (reply.stdout) ch.emit('data', Buffer.from(reply.stdout));
        if (reply.stderr) ch.stderr.emit('data', Buffer.from(reply.stderr));
        ch.emit('close', reply.code === undefined ? 0 : reply.code, null);
      }, 0);
    }
    shell(_opts: any, cb: (e: Error | undefined, ch?: any) => void) { cb(undefined, new FakeChannel()); }
    end() { this._sock.destroyed = true; }
  }
  return { Client };
});

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeMcpServer {
    registerTool(name: string, cfg: any, handler: any) { hooks.tools.set(name, { cfg, handler }); }
  }
  return { ...actual, McpServer: FakeMcpServer };
});

// Every knob src/index.ts reads at import time. Listed in full so a variant
// cannot inherit a leftover value from the previous test.
const ENV_KEYS = [
  'SSH_MCP_HOST', 'SSH_MCP_USER', 'SSH_MCP_PASSWORD', 'SSH_MCP_PORT',
  'SSH_MCP_NO_TMUX', 'SSH_MCP_SU_PASSWORD', 'SSH_MCP_SUDO_PASSWORD',
  'SSH_MCP_CLIENT_MAP', 'SSH_MCP_MAX_OUTPUT_BYTES', 'SSH_MCP_INSECURE_HOST_KEY',
  'SSH_MCP_TMUX_SESSION', 'SSH_MCP_KEY_PATH',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const BASE = {
  SSH_MCP_HOST: '10.0.0.9',
  SSH_MCP_USER: 'deploy',
  SSH_MCP_PASSWORD: 'pw',
  SSH_MCP_INSECURE_HOST_KEY: '1',
};

async function loadServer(env: Record<string, string> = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  hooks.tools.clear();
  hooks.execCalls.length = 0;
  hooks.connectFail = null;
  hooks.exec = null;
  vi.resetModules();
  const mod = await import('../src/index');
  return {
    mod,
    tool: (name: string) => {
      const t = hooks.tools.get(name);
      if (!t) throw new Error(`tool ${name} nao foi registrada: ${[...hooks.tools.keys()]}`);
      return t;
    },
    has: (name: string) => hooks.tools.has(name),
  };
}

// src/index.ts registers a process 'exit' hook at import, and this file imports
// it once per variant. Without this the reloads trip Node's leak warning.
process.setMaxListeners(50);

// Each variant re-imports the whole module graph. That is ~30ms warm, but under
// v8 coverage instrumentation on a loaded machine the first one can pass the
// default 5s and abort the run -- observed as an intermittent "Test timed out"
// on whichever test happened to reload first.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => { hooks.exec = null; hooks.execCalls.length = 0; hooks.connectFail = null; });
afterAll(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, Object.fromEntries(Object.entries(savedEnv).filter(([, v]) => v !== undefined)));
});

describe('exec tool, stateless mode', () => {
  const stateless = { ...BASE, SSH_MCP_NO_TMUX: '1' };

  it('connects on the first call and returns the command output', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ stdout: 'ok\n' });

    const res = await tool('exec').handler({ command: 'echo ok' });
    expect(res.content[0].text).toContain('ok');
    expect(hooks.execCalls[0].cmd).toBe('echo ok');
  });

  it('reuses the connection instead of opening a second one', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ stdout: 'x\n' });
    const before = hooks.clients.length;

    await tool('exec').handler({ command: 'true' });
    await tool('exec').handler({ command: 'true' });

    expect(hooks.clients.length - before, 'segunda chamada reconectou').toBe(1);
  });

  it('appends the description as a shell comment', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ stdout: '' });

    await tool('exec').handler({ command: 'ls', description: 'listar # coisas\nnova linha' });
    // Newlines would end the comment and turn the rest into a second command.
    expect(hooks.execCalls[0].cmd).toMatch(/^ls # /);
    expect(hooks.execCalls[0].cmd).not.toContain('\n');
  });

  it('surfaces a non-zero exit code as an error result', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ stdout: '', stderr: 'nope\n', code: 3 });

    const res = await tool('exec').handler({ command: 'false' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('[exit 3]');
  });

  it('refuses detach, which has no session to poll later', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ stdout: '' });

    await expect(tool('exec').handler({ command: 'sleep 1', detach: true }))
      .rejects.toThrow(/detach requires tmux mode/);
  });

  it('rejects an empty command before it reaches the host', async () => {
    const { tool } = await loadServer(stateless);
    await expect(tool('exec').handler({ command: '   ' })).rejects.toThrow(/cannot be empty/i);
    expect(hooks.execCalls).toHaveLength(0);
  });

  it('honours a per-call maxBytes over the server default', async () => {
    const { tool } = await loadServer({ ...stateless, SSH_MCP_MAX_OUTPUT_BYTES: '100000' });
    hooks.exec = () => ({ stdout: 'linha\n'.repeat(500) });

    const res = await tool('exec').handler({ command: 'seq', maxBytes: 200 });
    expect(res.content[0].text).toContain('omitted');
  });

  it('wraps a transport failure as an internal error rather than leaking it raw', async () => {
    const { tool } = await loadServer(stateless);
    hooks.exec = () => ({ err: new Error('open failed on channel') });

    await expect(tool('exec').handler({ command: 'true' })).rejects.toThrow(/SSH exec error/);
  });

  it('reports a connection failure with the underlying reason', async () => {
    const { tool } = await loadServer(stateless);
    hooks.connectFail = 'All configured authentication methods failed';

    await expect(tool('exec').handler({ command: 'true' }))
      .rejects.toThrow(/All configured authentication methods failed/);
  });
});

describe('exec tool, tmux mode', () => {
  it('probes once, then runs every later command inside the session', async () => {
    const { tool } = await loadServer(BASE);
    hooks.exec = (_cmd, n) => (n === 0 ? { stdout: '\ntmux=tmux 3.4\npm=apt-get\n' } : { stdout: 'dentro\n' });

    expect((await tool('exec').handler({ command: 'pwd' })).content[0].text).toContain('dentro');
    await tool('exec').handler({ command: 'pwd' });

    // One probe, two commands -- the verdict is cached on the manager.
    expect(hooks.execCalls).toHaveLength(3);
    // The command travels over stdin, never interpolated into the script.
    expect(hooks.execCalls[1].stdin).toContain('pwd');
  });

  it('returns a collectable jobId when the caller detaches', async () => {
    const { tool } = await loadServer(BASE);
    hooks.exec = (_cmd, n) => (n === 0 ? { stdout: '\ntmux=tmux 3.4\n' } : { stdout: '' });

    const res = await tool('exec').handler({ command: 'sleep 60', detach: true });
    expect(res.content[0].text).toMatch(/\[detached\] jobId=/);
  });

  it('refuses to run at all on a host without tmux, and names the install command', async () => {
    const { tool } = await loadServer(BASE);
    hooks.exec = () => ({ stdout: '\ntmux=\npm=yum\n' });

    await expect(tool('exec').handler({ command: 'pwd' })).rejects.toThrow(/yum install -y tmux/);
  });
});

describe('job_status tool', () => {
  it('is registered in tmux mode and reports a finished job', async () => {
    const { tool } = await loadServer(BASE);
    hooks.exec = (_cmd, n) => (n === 0
      ? { stdout: '\ntmux=tmux 3.4\n' }
      : { stdout: 'SSH_MCP_JOB done 0\nresultado\n' });

    const res = await tool('job_status').handler({ jobId: 'kdeadbeef1z' });
    expect(res.content[0].text).toContain('resultado');
  });

  it('is not registered when tmux is disabled', async () => {
    const { has } = await loadServer({ ...BASE, SSH_MCP_NO_TMUX: '1' });
    expect(has('job_status'), 'job_status nao pode existir sem sessao tmux').toBe(false);
    expect(has('exec')).toBe(true);
  });
});

describe('sudo-exec tool', () => {
  it('uses passwordless sudo inside the session when no password is configured', async () => {
    const { tool } = await loadServer(BASE);
    hooks.exec = (_cmd, n) => (n === 0 ? { stdout: '\ntmux=tmux 3.4\n' } : { stdout: 'root\n' });

    await tool('sudo-exec').handler({ command: 'whoami' });
    // In-session sudo: the command goes over stdin, and the script itself wraps it.
    expect(hooks.execCalls[1].stdin).toContain('whoami');
  });

  it('takes a password-configured sudo off the session, onto its own channel', async () => {
    const { tool } = await loadServer({ ...BASE, SSH_MCP_SUDO_PASSWORD: 's3cr3t' });
    hooks.exec = (_cmd, n) => (n === 0 ? { stdout: '\ntmux=tmux 3.4\n' } : { stdout: 'root\n' });

    await tool('sudo-exec').handler({ command: 'whoami' });

    const call = hooks.execCalls[1];
    expect(call.cmd).toContain('sudo -p "" -S -k sh -c');
    // The password is fed over stdin, never embedded in the command line where
    // `ps` on the remote host would show it.
    expect(call.stdin).toBe('s3cr3t\n');
    expect(call.cmd).not.toContain('s3cr3t');
  });

  it('uses sudo -n in stateless mode, so a password prompt fails instead of hanging', async () => {
    const { tool } = await loadServer({ ...BASE, SSH_MCP_NO_TMUX: '1' });
    hooks.exec = () => ({ stdout: 'root\n' });

    await tool('sudo-exec').handler({ command: "echo 'ok'" });
    expect(hooks.execCalls[0].cmd).toMatch(/^sudo -n sh -c '/);
    // The inner quote is escaped, not left to close the wrapper early.
    expect(hooks.execCalls[0].cmd).toContain(`'\\''ok'\\''`);
  });

  it('is not registered when sudo is disabled', async () => {
    const saved = process.argv;
    process.argv = ['node', 'index.js', '--disableSudo'];
    process.env.SSH_MCP_TEST = '1';
    try {
      const { has } = await loadServer({ ...BASE, SSH_MCP_NO_TMUX: '1' });
      expect(has('sudo-exec')).toBe(false);
      expect(has('exec')).toBe(true);
    } finally {
      process.argv = saved;
      delete process.env.SSH_MCP_TEST;
    }
  });
});

describe('target resolution', () => {
  it('refuses a call with no --host and no client name', async () => {
    const { tool } = await loadServer({ SSH_MCP_USER: 'deploy', SSH_MCP_CLIENT_MAP: '/dev/null' });
    await expect(tool('exec').handler({ command: 'true' })).rejects.toThrow(/no --host configured/);
  });

  it('refuses a client name when no inventory is configured', async () => {
    const { tool } = await loadServer({ ...BASE, SSH_MCP_NO_TMUX: '1' });
    await expect(tool('exec').handler({ command: 'true', client: 'Alfa' }))
      .rejects.toThrow(/No client inventory configured/);
  });

  it('refuses to connect with no username', async () => {
    const { tool } = await loadServer({ SSH_MCP_HOST: '10.0.0.9', SSH_MCP_NO_TMUX: '1' });
    await expect(tool('exec').handler({ command: 'true' })).rejects.toThrow(/Missing required username/);
  });

  it('routes to the host the inventory maps the client to, and caches the inventory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    const inv = join(dir, 'hosts.md');
    writeFileSync(inv, '### Alfa\n\n- `alfa.internal`\n\n### Beta\n\n- `beta.internal`\n');

    const { tool } = await loadServer({
      SSH_MCP_USER: 'deploy', SSH_MCP_PASSWORD: 'pw', SSH_MCP_NO_TMUX: '1',
      SSH_MCP_INSECURE_HOST_KEY: '1', SSH_MCP_CLIENT_MAP: inv,
    });
    hooks.exec = () => ({ stdout: 'oi\n' });

    await tool('exec').handler({ command: 'hostname', client: 'Alfa' });
    await tool('exec').handler({ command: 'hostname', client: 'Beta' });
    // Distinct destinations get distinct managers, hence distinct connections.
    expect(hooks.clients.slice(-2).length).toBe(2);

    await expect(tool('exec').handler({ command: 'hostname', client: 'Gama' }))
      .rejects.toThrow(/Client not found/i);
  });
});
