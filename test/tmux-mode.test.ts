import { describe, it, expect, vi } from 'vitest';
import { SSHConnectionManager } from '../src/index';

const base = { host: '127.0.0.1', port: 22, username: 'test', password: 'test' };

describe('SSHConnectionManager.resolveMode', () => {
  it('picks su mode without probing when suPassword is set', async () => {
    const probe = vi.fn();
    const m = new SSHConnectionManager({ ...base, suPassword: 'x' });
    expect(await m.resolveMode(probe)).toBe('su');
    expect(probe).not.toHaveBeenCalled();
  });

  it('picks stateless mode without probing when noTmux is set', async () => {
    const probe = vi.fn();
    const m = new SSHConnectionManager({ ...base, noTmux: true });
    expect(await m.resolveMode(probe)).toBe('stateless');
    expect(probe).not.toHaveBeenCalled();
  });

  it('prefers su over noTmux', async () => {
    const m = new SSHConnectionManager({ ...base, suPassword: 'x', noTmux: true });
    expect(await m.resolveMode(vi.fn())).toBe('su');
  });

  it('picks tmux mode when the probe finds tmux', async () => {
    const m = new SSHConnectionManager(base);
    expect(await m.resolveMode(async () => 'tmux=tmux 3.4\n')).toBe('tmux');
    expect(m.getProbe()).toEqual({ tmux: 'tmux 3.4', pm: null });
  });

  it('picks blocked mode when the probe does not find tmux', async () => {
    const m = new SSHConnectionManager(base);
    expect(await m.resolveMode(async () => 'tmux=\npm=apk\n')).toBe('blocked');
    expect(m.getProbe()).toEqual({ tmux: null, pm: 'apk' });
  });

  it('probes only once per connection', async () => {
    const probe = vi.fn(async () => 'tmux=tmux 3.4\n');
    const m = new SSHConnectionManager(base);
    await m.resolveMode(probe);
    await m.resolveMode(probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes after resetMode, so a reconnect re-evaluates the host', async () => {
    const probe = vi.fn(async () => 'tmux=tmux 3.4\n');
    const m = new SSHConnectionManager(base);
    await m.resolveMode(probe);
    m.resetMode();
    await m.resolveMode(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('defaults the session name and honours an override', () => {
    expect(new SSHConnectionManager(base).getTmuxSession()).toBe('ssh-mcp');
    expect(new SSHConnectionManager({ ...base, tmuxSession: 'deploy' }).getTmuxSession()).toBe('deploy');
  });
});
