// Regression coverage for single-host mode: a server started with --host and no
// inventory must serve exec/sudo-exec without a client parameter. This is the
// original contract every pre-existing deployment relies on, and it was briefly
// removed when client routing landed.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const testServerPath = join(process.cwd(), 'build', 'index.js');
const clientMapPath = join(process.cwd(), 'test', 'fixtures', 'client-map.md');
const START_TIMEOUT = 15000;

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

function callExec(
  toolArguments: Record<string, unknown>,
  extraArgs: string[],
  extraEnv: Record<string, string> = {},
): Promise<any> {
  const args = [testServerPath, '--insecureHostKey', '--port=2222', '--timeout=60000', ...extraArgs];

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_MCP_TEST: '1',
        SSH_MCP_USER: 'test',
        SSH_MCP_PASSWORD: 'secret',
        SSH_MCP_HOST: '',
        SSH_MCP_CLIENT_MAP: '',
        ...extraEnv,
      },
    });

    let buffer = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Server start timeout'));
    }, START_TIMEOUT);

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            clearTimeout(timer);
            child.kill();
            resolve(msg);
          }
        } catch { /* partial line */ }
      }
    });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '0.1.0' },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'exec', arguments: toolArguments },
    }) + '\n');
  });
}

const textOf = (res: any) => (res.result?.content?.[0]?.text ?? res.error?.message ?? '').toString();

describe('single-host mode', () => {
  it('executes with --host and no client parameter', async () => {
    const res = await callExec({ command: 'echo single-host-ok' }, ['--host=127.0.0.1']);
    expect(res.error).toBeUndefined();
    expect(textOf(res)).toContain('single-host-ok');
  }, 40000);

  it('reads the host from SSH_MCP_HOST as well', async () => {
    const res = await callExec({ command: 'echo env-host-ok' }, [], { SSH_MCP_HOST: '127.0.0.1' });
    expect(res.error).toBeUndefined();
    expect(textOf(res)).toContain('env-host-ok');
  }, 40000);

  it('lets --host and an inventory coexist, with --host as the default target', async () => {
    const res = await callExec(
      { command: 'echo default-target-ok' },
      ['--host=127.0.0.1', `--clientMap=${clientMapPath}`],
    );
    expect(res.error).toBeUndefined();
    expect(textOf(res)).toContain('default-target-ok');
  }, 40000);

  it('still routes by client when one is given alongside --host', async () => {
    const res = await callExec(
      { command: 'echo routed-ok', client: 'Test Client One' },
      ['--host=127.0.0.1', `--clientMap=${clientMapPath}`],
    );
    expect(res.error).toBeUndefined();
    expect(textOf(res)).toContain('routed-ok');
  }, 40000);

  it('explains itself when a client is requested but no inventory is configured', async () => {
    const res = await callExec(
      { command: 'echo nope', client: 'Test Client One' },
      ['--host=127.0.0.1'],
    );
    expect(textOf(res).toLowerCase()).toContain('no client inventory configured');
  }, 40000);
});
