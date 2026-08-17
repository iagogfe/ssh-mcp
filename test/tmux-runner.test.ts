// Unit coverage for ensureMode / runInTmux / jobStatus without an SSH server.
//
// These route through execSshCommandWithConnection, which takes a shared-shell
// fast path when the manager already holds one. Driving that path with a fake
// stream exercises the JavaScript around the transport -- mode resolution,
// detach reply shaping, job-status parsing -- while the shell semantics
// themselves are covered by the live suite.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { SSHConnectionManager, ensureMode, runInTmux, jobStatus } from '../src/index';

class FakeShell extends EventEmitter {
  written: string[] = [];
  write(chunk: string) { this.written.push(chunk); }
  end() {}
}

function shellManager(extra: Record<string, unknown> = {}) {
  const manager = new SSHConnectionManager({
    host: 'db01.internal', port: 22, username: 'deploy', ...extra,
  });
  const shell = new FakeShell();
  (manager as any).conn = new EventEmitter();
  (manager as any).suShell = shell;
  (manager as any).isElevated = true;
  return { manager, shell };
}

// The written sentinel carries an extra pair of quotes so the marker only ever
// appears in the command's OUTPUT, never in the PTY's echo of its input.
function tokenOf(shell: FakeShell): string {
  const m = shell.written.join('').match(/SSH_MCP""_BEGIN_(\w+)/);
  if (!m) throw new Error('nenhum sentinel BEGIN foi escrito: ' + shell.written.join('|'));
  return m[1];
}

function reply(shell: FakeShell, body: string, code = 0) {
  const t = tokenOf(shell);
  shell.emit('data', Buffer.from(`SSH_MCP_BEGIN_${t}\n${body}SSH_MCP_END_${t}:${code}\n`));
}

describe('ensureMode', () => {
  it('resolves su mode without probing the host at all', async () => {
    const { manager, shell } = shellManager({ suPassword: 'r00t' });
    expect(await ensureMode(manager)).toBe('su');
    expect(shell.written, 'su mode nao deve escrever nada no shell').toEqual([]);
  });

  it('resolves stateless mode without probing', async () => {
    const { manager, shell } = shellManager({ noTmux: true });
    expect(await ensureMode(manager)).toBe('stateless');
    expect(shell.written).toEqual([]);
  });

  it('resolves tmux mode from the probe output', async () => {
    const { manager, shell } = shellManager();
    const pending = ensureMode(manager);
    reply(shell, 'tmux=tmux 3.4\n');
    expect(await pending).toBe('tmux');
    expect(manager.getProbe()).toEqual({ tmux: 'tmux 3.4', pm: null });
  });

  it('refuses with install guidance when the host has no tmux', async () => {
    const { manager, shell } = shellManager();
    const pending = ensureMode(manager);
    reply(shell, 'tmux=\npm=apt-get\n');

    await expect(pending).rejects.toThrow(/db01\.internal/);
    // The message has to be actionable: the package manager it detected, and
    // the way out for a host that will never have tmux.
    await expect(ensureMode(manager)).rejects.toThrow(/apt-get install -y tmux/);
    await expect(ensureMode(manager)).rejects.toThrow(/--noTmux/);
  });

  it('caches the verdict, so a blocked host is not re-probed on every call', async () => {
    const { manager, shell } = shellManager();
    const pending = ensureMode(manager);
    reply(shell, 'tmux=\n');
    await expect(pending).rejects.toThrow();

    const writesAfterProbe = shell.written.length;
    await expect(ensureMode(manager)).rejects.toThrow();
    expect(shell.written.length, 'segunda chamada sondou o host de novo').toBe(writesAfterProbe);
  });
});

describe('runInTmux', () => {
  it('returns the command result on the normal path', async () => {
    const { manager, shell } = shellManager();
    const pending = runInTmux(manager, 'echo oi', { kind: 'exec', maxBytes: 0 });
    reply(shell, 'oi\n');
    const res: any = await pending;
    expect(res.content[0].text).toContain('oi');
    expect(res.isError).toBeFalsy();
  });

  it('answers a detached launch with a collectable jobId', async () => {
    const { manager, shell } = shellManager();
    const pending = runInTmux(manager, 'sleep 30', { kind: 'exec', detach: true, maxBytes: 0 });
    reply(shell, '');
    const res: any = await pending;
    expect(res.content[0].text).toMatch(/\[detached\] jobId=[A-Za-z0-9]+/);
    expect(res.content[0].text).toContain('job_status');
  });

  it('surfaces a failed launch instead of a phantom jobId', async () => {
    const { manager, shell } = shellManager();
    const pending = runInTmux(manager, 'sleep 30', { kind: 'exec', detach: true, maxBytes: 0 });
    reply(shell, 'ssh-mcp: unsafe workdir path\n', 78);
    const res: any = await pending;
    expect(res.isError).toBe(true);
    expect(res.content[0].text, 'lancamento falho nao pode virar jobId').not.toContain('[detached]');
  });

  it('sends the sudo variant down the same path', async () => {
    const { manager, shell } = shellManager();
    const pending = runInTmux(manager, 'id -u', { kind: 'sudo', maxBytes: 0 });
    reply(shell, '0\n');
    expect(((await pending).content[0] as any).text).toContain('0');
  });
});

describe('jobStatus', () => {
  it('reports a running job with its elapsed time and partial output', async () => {
    const { manager, shell } = shellManager();
    const pending = jobStatus(manager, 'k1z', 0);
    reply(shell, 'SSH_MCP_JOB running 47\nparcial\n');
    const res: any = await pending;
    expect(res.content[0].text).toContain('[running] 47s');
    expect(res.content[0].text).toContain('parcial');
  });

  it('reports a finished job with the command own exit code', async () => {
    const { manager, shell } = shellManager();
    const pending = jobStatus(manager, 'k1z', 0);
    reply(shell, 'SSH_MCP_JOB done 7\nsaida final\n');
    const res: any = await pending;
    expect(res.content[0].text).toContain('saida final');
    expect(res.content[0].text).toContain('[exit 7]');
    expect(res.isError).toBe(true);
  });

  it('rejects a malformed jobId before it reaches any shell', async () => {
    const { manager, shell } = shellManager();
    await expect(jobStatus(manager, 'a;rm -rf /tmp', 0)).rejects.toThrow(/token/i);
    expect(shell.written, 'jobId invalido nao pode chegar no shell').toEqual([]);
  });

  it('turns an unknown job into a clear error rather than a parse failure', async () => {
    const { manager, shell } = shellManager();
    const pending = jobStatus(manager, 'k9z', 0);
    reply(shell, 'ssh-mcp: unknown jobId k9z\n', 78);
    await expect(pending).rejects.toThrow(/unknown jobId/);
  });
});
