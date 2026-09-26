// --listen serves several MCP sessions from one process over a Unix socket.
// Each client reaches it through the same stdio shim a harness would use
// (`nc -U`), so this also proves the shim works end to end. No SSH server is
// needed: listing tools never opens a connection.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { mkdtempSync, statSync, existsSync } from 'fs';
import { connect as netConnect } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverPath = join(process.cwd(), 'build', 'index.js');
const children: ChildProcess[] = [];

function startDaemon(sock: string, extra: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverPath, '--host=127.0.0.1', '--user=test', `--listen=${sock}`, ...extra], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // The test runner sets SSH_MCP_DISABLE_MAIN=1, which would make the daemon exit at once.
    env: { ...process.env, SSH_MCP_DISABLE_MAIN: '0' },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr!.on('data', (d) => {
      err += d;
      if (err.includes('SSH MCP Server listening on')) resolve(child);
    });
    child.once('exit', (code) => reject(new Error(`daemon saiu com ${code}: ${err}`)));
  });
}

async function connect(sock: string) {
  const client = new Client({ name: 'listen-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: 'nc', args: ['-N', '-U', sock], stderr: 'ignore' }));
  return client;
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

describe('--listen', () => {
  it('serves two sessions from one process and keeps the socket private', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ssh-mcp-listen-')), 'run');
    const sock = join(dir, 'host.sock');
    await startDaemon(sock);

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(sock).mode & 0o777).toBe(0o600);

    const [a, b] = await Promise.all([connect(sock), connect(sock)]);
    const [ta, tb] = await Promise.all([a.listTools(), b.listTools()]);
    expect(ta.tools.map((t) => t.name)).toContain('exec');
    expect(tb.tools.map((t) => t.name)).toEqual(ta.tools.map((t) => t.name));
    await a.close();
    // One session closing must not take the other down.
    expect((await b.listTools()).tools.length).toBe(ta.tools.length);
    await b.close();
  }, 20000);

  it('refuses a second instance on a live socket, and removes the socket on SIGTERM', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'ssh-mcp-listen-')), 'host.sock');
    const first = await startDaemon(sock);
    await expect(startDaemon(sock)).rejects.toThrow(/already listening/);

    const exited = new Promise((r) => first.once('exit', r));
    first.kill('SIGTERM');
    await exited;
    expect(existsSync(sock)).toBe(false);
  }, 20000);

  // Live: needs the CI sshd (127.0.0.1:2222, test/secret), like the smoke test.
  it('closes a session\'s tunnels when that session disconnects', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'ssh-mcp-listen-')), 'host.sock');
    await startDaemon(sock, [`--port=${process.env.SSH_PORT || 2222}`, '--password=secret', '--insecureHostKey']);
    const a = await connect(sock);
    const res: any = await a.callTool({ name: 'tunnel_open', arguments: { remoteHost: '127.0.0.1', remotePort: 22 } });
    expect(res.isError, res.content?.[0]?.text).toBeFalsy();
    const localPort = Number(res.content[0].text.match(/127\.0\.0\.1:(\d+)/)[1]);
    await a.close();
    await new Promise((r) => setTimeout(r, 300));
    const refused = await new Promise<boolean>((resolve) => {
      const s = netConnect(localPort, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(false); });
      s.once('error', () => resolve(true));
    });
    expect(refused, 'o tunel da sessao fechada continuou aberto').toBe(true);
  }, 20000);
});
