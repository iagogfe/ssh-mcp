import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';

const serverPath = join(process.cwd(), 'build', 'index.js');

beforeAll(() => {
  process.env.SSH_MCP_TEST = '1';
});

// Starts the server, sends one JSON-RPC request, returns the response. If the
// server process dies before answering (e.g. a startup validation error),
// rejects rather than waiting out the full timeout.
function rpc(
  method: string,
  params: any,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [serverPath, '--host=127.0.0.1', '--user=test', ...extraArgs], {
      // The parent vitest process runs under SSH_MCP_DISABLE_MAIN=1 (see
      // package.json's `test` script), which would otherwise be inherited and
      // skip the startup validateConfig() call this file exercises.
      env: { ...process.env, SSH_MCP_TEST: '1', SSH_MCP_DISABLE_MAIN: '0', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('timeout'));
    }, 10000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            resolve(msg);
          }
        } catch { /* partial line */ }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      if (settled || code === null || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
  });
}

describe('tool surface', () => {
  it('exposes job_status alongside exec and sudo-exec', async () => {
    const res = await rpc('tools/list', {});
    const names = res.result.tools.map((t: any) => t.name).sort();
    expect(names).toContain('exec');
    expect(names).toContain('sudo-exec');
    expect(names).toContain('job_status');
  }, 20000);

  it('tells the agent that state persists, so it can rely on cd', async () => {
    const res = await rpc('tools/list', {});
    const exec = res.result.tools.find((t: any) => t.name === 'exec');
    expect(exec.description).toMatch(/persist/i);
    expect(exec.description).toMatch(/working directory|cd/i);
  }, 20000);

  it('offers detach on exec', async () => {
    const res = await rpc('tools/list', {});
    const exec = res.result.tools.find((t: any) => t.name === 'exec');
    expect(Object.keys(exec.inputSchema.properties)).toContain('detach');
  }, 20000);

  it('drops job_status when tmux is disabled', async () => {
    const res = await rpc('tools/list', {}, ['--noTmux']);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).not.toContain('job_status');
  }, 20000);

  it('drops job_status when su mode is active', async () => {
    const res = await rpc('tools/list', {}, ['--suPassword=secret']);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).not.toContain('job_status');
  }, 20000);

  // A bare --suPassword flag (no '=value') resolves to null, which does NOT
  // enable su mode per the existing convention at the SUPASSWORD assignment.
  // job_status must stay registered in that case.
  it('keeps job_status when --suPassword is passed bare (null, not active)', async () => {
    const res = await rpc('tools/list', {}, ['--suPassword']);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain('job_status');
  }, 20000);

  it('rejects an invalid tmux session name at startup', async () => {
    await expect(rpc('tools/list', {}, ['--tmuxSession=bad name'])).rejects.toThrow();
  }, 20000);

  // SSH_MCP_TMUX_SESSION is documented as an equal channel to --tmuxSession
  // (see src/index.ts's TMUX_SESSION resolution); an invalid name reaching the
  // server only through the env var must fail at startup too, not silently
  // start clean and only blow up on the first tool call.
  it('rejects an invalid tmux session name supplied only via SSH_MCP_TMUX_SESSION', async () => {
    await expect(
      rpc('tools/list', {}, [], { SSH_MCP_TMUX_SESSION: 'bad name' }),
    ).rejects.toThrow();
  }, 20000);

  // exec's description must not claim persistence in a mode where it is
  // false: --noTmux (stateless mode) has no error to catch an agent that
  // believed cd/export would carry over, unlike blocked mode which fails
  // loudly before running anything.
  it('does not claim persistence in the description under --noTmux', async () => {
    const res = await rpc('tools/list', {}, ['--noTmux']);
    const exec = res.result.tools.find((t: any) => t.name === 'exec');
    expect(exec.description).not.toMatch(/state persists/i);
    expect(exec.description).toMatch(/do not persist|does not persist|not persist between/i);
  }, 20000);

  // detach must be REJECTED in stateless mode, not silently ignored (there is
  // no tmux session to poll a job's progress in). Requires the live SSH
  // fixture (docker compose) since the rejection sits after ensureConnected().
  it('rejects detach against a live server running --noTmux', async () => {
    const res = await rpc(
      'tools/call',
      { name: 'exec', arguments: { command: 'echo hi', detach: true } },
      ['--noTmux', '--insecureHostKey', '--port=2222'],
      { SSH_MCP_PASSWORD: 'secret' },
    );
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toMatch(/detach/i);
  }, 20000);
});
