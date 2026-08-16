import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

// Very small, focused tests for the sudo-exec MCP tool. This file is intentionally
// small and straightforward (no heavy debug plumbing) — the integration surface
// is: start the MCP server in test mode, send an initialize request, then call
// the sudo-exec tool and assert the returned JSON-RPC response.

const testServerPath = join(process.cwd(), 'build', 'index.js');
const clientMapPath = join(process.cwd(), 'test', 'fixtures', 'client-map.md');
const START_TIMEOUT = 10000;  // 10 seconds for server startup with su elevation

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

function runMcpCommand(
  command: string,
  extraArgs: string[] = [],
  toolName = 'sudo-exec',
  client: string | null = 'Test Client One',
  extraEnv: Record<string, string> = {},
): Promise<any> {
  const args = [
    testServerPath,
    '--insecureHostKey',
    '--port=2222',
    '--timeout=60000',
    ...extraArgs,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('node', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SSH_MCP_TEST: '1',
        SSH_MCP_CLIENT_MAP: clientMapPath,
        SSH_MCP_USER: 'test',
        SSH_MCP_PASSWORD: 'secret',
        ...extraEnv,
      },
    });
    let buffer = '';
    const startup = setTimeout(() => {
      child.kill();
      reject(new Error('Server start timeout'));
    }, START_TIMEOUT);

    const initMsg = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '0.1.0' } };
    const toolArguments: Record<string, string> = { command };
    if (typeof client === 'string') toolArguments.client = client;
    const toolCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: toolArguments } };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 0) {
            child.stdin.write(JSON.stringify(toolCall) + '\n');
          } else if (msg.id === 1) {
            clearTimeout(startup);
            resolve(msg);
            child.kill();
            return;
          }
        } catch (e) {
          // ignore non-json
        }
      }
    });

    child.stderr.on('data', () => { /* ignore */ });
    child.on('error', (err) => { clearTimeout(startup); reject(err); });

    // Give the server a moment to initialize before sending messages
    setTimeout(() => {
      child.stdin.write(JSON.stringify(initMsg) + '\n');
    }, 100);
  });
}

// Helper that runs a command using the server's `--suPassword` option.
// It establishes an elevated su session at connection time so all commands run as root.
function runSuMcpCommand(command: string, suPassword = 'secret', extraArgs: string[] = []): Promise<any> {
  return runMcpCommand(
    command,
    extraArgs,
    'exec',
    'Test Client One',
    { SSH_MCP_SU_PASSWORD: suPassword },
  );
}

const sudoEnvironment = (password: string) => ({ SSH_MCP_SUDO_PASSWORD: password });

describe('sudo-exec tool authentication', () => {
  // Set up the su environment before running tests that need it
  beforeAll(async () => {
    // First make su setuid root
    const suSetup = await runMcpCommand('chmod u+s /bin/su', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(suSetup.error).toBeUndefined();

    // Then set the root password to 'secret'
    const passwdSetup = await runMcpCommand('echo "secret" | passwd --stdin', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(passwdSetup.error).toBeUndefined();
  });

  it('should execute commands with su elevation after sudo setup', async () => {
    // First verify we can use su now by checking if we can become root
    const whoami = await runMcpCommand('whoami && echo "secret" | su -c whoami', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(whoami.error).toBeUndefined();
    const output = (whoami.result?.content?.[0]?.text || '').toLowerCase();
    expect(output).toContain('root');
    
    // Now try creating a root-owned directory
    const mkdir = await runMcpCommand('echo "secret" | su -c "mkdir -p /root/test_dir"', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(mkdir.error).toBeUndefined();
    
    // Verify we can access it
    const ls = await runMcpCommand('ls -la /root/test_dir', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(ls.error).toBeUndefined();
    expect(ls.result?.content?.[0]?.text).toBeTruthy();

    // Clean up
    const cleanup = await runMcpCommand('rm -rf /root/test_dir', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(cleanup.error).toBeUndefined();
  }, 60000); // Increased timeout for su operations

  it('executes su when provided --suPassword', async () => {
    const res = await runSuMcpCommand('whoami', 'secret');
    expect(res.error).toBeUndefined();
    const out = (res.result?.content?.[0]?.text || '').toLowerCase();
    expect(out).toContain('root');
  }, 60000);

  it('fails when sudo requires password but none provided', async () => {
    const res = await runMcpCommand('whoami');
    const text = (res.result?.content?.[0]?.text || '').toLowerCase();
    expect(text).toContain('sudo: a password is required');
  });

  it('reports empty command as invalid', async () => {
    const res = await runMcpCommand('', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    const text = (res.result?.content?.[0]?.text || '').toLowerCase();
    expect(text).toContain('command cannot be empty');
  });

  it('rejects a sudo-exec call without a client before attempting SSH', async () => {
    const res = await runMcpCommand('echo should-not-run', [], 'sudo-exec', null);
    const serialized = JSON.stringify(res);

    expect(res.result?.isError).toBe(true);
    expect(serialized).toMatch(/client/i);
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('rejects wrong sudo password', async () => {
    const res = await runMcpCommand('whoami', [], 'sudo-exec', 'Test Client One', sudoEnvironment('wrongpass'));
    const text = (res.result?.content?.[0]?.text || '').toLowerCase();
    // The sshd/sudo stack may return different messages across platforms; look for common indicator
    expect(text).toMatch(/sorry|incorrect|authentication/);
  });

  it('executes with correct sudo password', async () => {
    const res = await runMcpCommand('id', [], 'sudo-exec', 'Test Client One', sudoEnvironment('secret'));
    expect(res.error).toBeUndefined();
    const out = (res.result?.content?.[0]?.text || '').toLowerCase();
    expect(out).toContain('uid=0');
  });
});
