import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The server must serve both protocol eras: the 2026-07-28 revision (pinned below)
// and the 2025 `initialize` handshake that existing hosts still speak.
const serverPath = join(process.cwd(), 'build', 'index.js');
const serverArgs = [
  serverPath,
  '--host=127.0.0.1',
  '--port=2222',
  '--user=test',
  '--password=secret',
];

async function connectWith(era: 'modern' | 'legacy') {
  const client = new Client(
    { name: 'era-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    env: { ...process.env, SSH_MCP_TEST: '1' } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);
  return client;
}

describe('protocol era negotiation', () => {
  it('serves the 2026-07-28 revision and lists both tools', async () => {
    const client = await connectWith('modern');
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['exec', 'job_status', 'sudo-exec']);
    } finally {
      await client.close();
    }
  }, 30000);

  it('still serves the 2025-era initialize handshake', async () => {
    const client = await connectWith('legacy');
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('exec');
    } finally {
      await client.close();
    }
  }, 30000);
});
