// Tool definitions are sent to the model once per session, per configured
// server. They are pure overhead from the agent's point of view: context spent
// before it has done anything. This user runs four of these servers, so every
// byte here is paid four times.
//
// A ceiling rather than an exact number: prose should stay editable, but a
// description that doubles in size should have to argue for itself.
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const BUDGET = 2600;

async function listTools(extraArgs: string[] = []) {
  const client = new Client({ name: 'budget', version: '1.0.0' }, {});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'build', 'index.js'), ...extraArgs,
           '--host=127.0.0.1', '--port=2222', '--user=test', '--password=secret'],
    env: { ...process.env, SSH_MCP_TEST: '1' } as Record<string, string>,
    stderr: 'ignore',
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
  }
}

describe('context budget', () => {
  it('keeps the whole tool surface under the byte ceiling', async () => {
    const tools = await listTools();
    const size = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    expect(size, `definicoes das tools: ${size}B (teto ${BUDGET}B)`).toBeLessThan(BUDGET);
  }, 30000);

  it('keeps client declared without an inventory, but stops describing it', async () => {
    // Declared, always: zod STRIPS an undeclared key, so removing it would mean
    // the handler never sees `client` and never refuses it -- and a silently
    // ignored `client` runs the command on the pinned host instead of the one
    // the caller named. Wrong machine, no error.
    //
    // Undescribed, though: with no inventory there is nothing to select from,
    // so prose about selecting is context spent teaching a dead end. The
    // handler's "No client inventory configured" says it at the moment it
    // matters.
    const tools = await listTools();
    for (const t of tools) {
      const client = (t.inputSchema as any)?.properties?.client;
      expect(client, `${t.name} perdeu o parametro client`).toBeDefined();
      expect(client.description, `${t.name} descreve client sem inventario`).toBeUndefined();
    }
  }, 30000);

  it('describes it once an inventory is configured', async () => {
    const inventory = join(process.cwd(), 'test', 'fixtures', 'client-map.md');
    const tools = await listTools([`--clientMap=${inventory}`]);
    for (const t of tools) {
      const client = (t.inputSchema as any)?.properties?.client;
      expect(client?.description, `${t.name} nao descreve client com inventario`)
        .toMatch(/inventory/i);
    }
  }, 30000);
});
