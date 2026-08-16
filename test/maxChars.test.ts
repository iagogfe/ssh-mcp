import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const testServerPath = join(process.cwd(), 'build', 'index.js');
const clientMapPath = join(process.cwd(), 'test', 'fixtures', 'client-map.md');

interface JsonRpcResponse {
  id: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

function responseText(response: JsonRpcResponse): string {
  return response.error?.message
    ?? response.result?.content?.map((item) => item.text ?? '').join('\n')
    ?? '';
}

function callExec(command: string, extraArgs: string[] = []): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      'node',
      [
        testServerPath,
        '--insecureHostKey',
        '--port=2222',
        '--timeout=1500',
        ...extraArgs,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SSH_MCP_TEST: '1',
          SSH_MCP_CLIENT_MAP: clientMapPath,
          SSH_MCP_USER: 'test',
          SSH_MCP_PASSWORD: 'test-only-password',
        },
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`MCP response timeout. stderr: ${stderr}`));
    }, 5000);

    const finish = (error?: Error, response?: JsonRpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(response as JsonRpcResponse);
    };

    const initialize = {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        capabilities: {},
        clientInfo: { name: 'max-chars-test', version: '1' },
        protocolVersion: '0.1.0',
      },
    };
    const toolCall = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'exec',
        arguments: { client: 'Test Client One', command },
      },
    };

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id === 0) {
          child.stdin.write(`${JSON.stringify(toolCall)}\n`);
        } else if (message.id === 1) {
          finish(undefined, message);
        }
      }
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled) finish(new Error(`MCP exited before responding (${code}). stderr: ${stderr}`));
    });

    child.stdin.write(`${JSON.stringify(initialize)}\n`);
  });
}

describe('maxChars CLI configuration', () => {
  it('rejects commands over the default limit before connecting', async () => {
    const response = await callExec(`echo ${'x'.repeat(1000)}`);
    const text = responseText(response);

    expect(text).toContain('Command is too long (max 1000 characters)');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('respects a custom positive limit before connecting', async () => {
    const response = await callExec(`echo ${'x'.repeat(50)}`, ['--maxChars=50']);
    const text = responseText(response);

    expect(text).toContain('Command is too long (max 50 characters)');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it.each(['none', '0'])(
    'does not reject a long command by length when maxChars=%s',
    async (limit) => {
      const response = await callExec(`echo ${'x'.repeat(10000)}`, [`--maxChars=${limit}`]);

      expect(responseText(response)).not.toContain('Command is too long');
    },
  );

  it('falls back to the default limit for an invalid value', async () => {
    const response = await callExec(`echo ${'x'.repeat(1000)}`, ['--maxChars=invalid']);

    expect(responseText(response)).toContain('Command is too long (max 1000 characters)');
  });
});
