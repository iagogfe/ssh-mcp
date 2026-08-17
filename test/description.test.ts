import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const testServerPath = join(process.cwd(), 'build', 'index.js');
const clientMapPath = join(process.cwd(), 'test', 'fixtures', 'client-map.md');
const START_TIMEOUT = 10000;

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

interface ToolRequest {
  command: string;
  description?: string;
  client?: string | null;
  toolName?: string;
}

function runMcpCommands(
  requests: ToolRequest[],
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<any[]> {
  const args = [
    testServerPath,
    '--insecureHostKey',
    '--port=2222',
    '--timeout=60000',
    // Isolate this file's default-mode exec calls from every other spawn-based
    // test file's use of the shared 'ssh-mcp' tmux session on the same live
    // fixture; without this, parallel vitest workers race to create/attach the
    // same session (e.g. tmux's own "duplicate session" error).
    '--tmuxSession=ssh-mcp-description',
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
    const responses: any[] = [];
    const startup = setTimeout(() => {
      child.kill();
      reject(new Error('Server start timeout'));
    }, START_TIMEOUT);

    const initMsg = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {}, clientInfo: { name: 't', version: '1' }, protocolVersion: '0.1.0' } };

    const sendRequest = (index: number) => {
      const request = requests[index];
      const toolArguments: Record<string, string> = { command: request.command };
      if (typeof request.client === 'string') toolArguments.client = request.client;
      if (request.description !== undefined) toolArguments.description = request.description;
      const toolCall = {
        jsonrpc: '2.0',
        id: index + 1,
        method: 'tools/call',
        params: { name: request.toolName ?? 'exec', arguments: toolArguments },
      };
      child.stdin.write(JSON.stringify(toolCall) + '\n');
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 0) {
            sendRequest(0);
          } else if (typeof msg.id === 'number' && msg.id > 0) {
            responses.push(msg);
            if (responses.length === requests.length) {
              clearTimeout(startup);
              resolve(responses);
              child.kill();
              return;
            }
            sendRequest(responses.length);
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

async function runMcpCommand(
  command: string,
  description?: string,
  extraArgs: string[] = [],
  toolName = 'exec',
  client: string | null = 'Test Client One',
  extraEnv: Record<string, string> = {},
): Promise<any> {
  const [response] = await runMcpCommands([{ client, command, description, toolName }], extraArgs, extraEnv);
  return response;
}

describe('command description functionality', () => {
  it('should execute commands without description (backward compatibility)', async () => {
    const res = await runMcpCommand('echo "test without description"');
    expect(res.error).toBeUndefined();
    expect(res.result?.content?.[0]?.text).toContain('test without description');
  });

  it('should execute commands with simple description', async () => {
    const res = await runMcpCommand('echo "test with description"', 'This is a test command');
    expect(res.error).toBeUndefined();
    expect(res.result?.content?.[0]?.text).toContain('test with description');
  });

  it('should handle descriptions with special characters', async () => {
    const res = await runMcpCommand('ls -la', 'List all files # detailed format');
    expect(res.error).toBeUndefined();
    // The command should execute successfully even with special characters in description
  });

  it('should work with sudo-exec tool and description', async () => {
    const res = await runMcpCommand(
      'whoami',
      'Check current user identity',
      [],
      'sudo-exec',
      'Test Client One',
      { SSH_MCP_SUDO_PASSWORD: 'secret' },
    );
    expect(res.error).toBeUndefined();
    // Should execute successfully with sudo
  });

  it('should handle empty description parameter', async () => {
    const res = await runMcpCommand('pwd', '');
    expect(res.error).toBeUndefined();
    expect(res.result?.content?.[0]?.text).toBeTruthy();
  });

  it('rejects an exec call without a client before attempting SSH', async () => {
    const res = await runMcpCommand('echo should-not-run', undefined, [], 'exec', null);
    const serialized = JSON.stringify(res);

    expect(res.result?.isError).toBe(true);
    expect(serialized).toMatch(/client/i);
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('returns a client resolution error before attempting SSH for an unknown client', async () => {
    const res = await runMcpCommand('echo should-not-run', undefined, [], 'exec', 'Unknown Client');
    const serialized = JSON.stringify(res);

    expect(serialized).toMatch(/Client not found: Unknown Client/i);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('secret');
  });

  it('routes two clients sequentially in the same MCP process', async () => {
    const responses = await runMcpCommands([
      { client: 'Test Client One', command: 'printf client-one' },
      { client: 'Test Client Two', command: 'printf client-two' },
    ]);

    expect(responses[0].error).toBeUndefined();
    expect(responses[0].result?.content?.[0]?.text).toContain('client-one');
    expect(responses[1].error).toBeUndefined();
    expect(responses[1].result?.content?.[0]?.text).toContain('client-two');
  });
});
