import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const testServerPath = join(process.cwd(), 'build', 'index.js');
const clientMapPath = join(process.cwd(), 'test', 'fixtures', 'client-map.md');

function callExec(command: string, extraArgs: string[] = []): Promise<any> {
  const args = [testServerPath, '--insecureHostKey', '--port=2222', '--timeout=20000', ...extraArgs];
  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_MCP_TEST: '1',
        SSH_MCP_CLIENT_MAP: clientMapPath,
        SSH_MCP_USER: 'test',
        SSH_MCP_PASSWORD: 'secret',
      },
    });
    let buf = '';
    const init = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '0.1.0' } };
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'exec', arguments: { client: 'Test Client One', command } },
    };
    const to = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 22000);
    child.stdout.on('data', (d) => {
      buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const l of lines) { try { const m = JSON.parse(l);
        if (m.id === 0) child.stdin.write(JSON.stringify(call) + '\n');
        else if (m.id === 1) { clearTimeout(to); resolve(m); child.kill(); }
      } catch (e) { /* ignore */ } }
    });
    child.stderr.on('data', () => {});
    setTimeout(() => child.stdin.write(JSON.stringify(init) + '\n'), 150);
  });
}

describe('maxOutputBytes truncation', () => {
  it('truncates large output by default', async () => {
    const res = await callExec('seq 1 100000');
    const text = res.result.content[0].text as string;
    expect(text).toContain('lines omitted');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(20000);
  }, 30000);

  it('--maxOutputBytes=none disables truncation', async () => {
    const res = await callExec('seq 1 5000', ['--maxOutputBytes=none']);
    const text = res.result.content[0].text as string;
    expect(text).not.toContain('omitted');
    expect(text.trimEnd().endsWith('5000')).toBe(true);
  }, 30000);
});
