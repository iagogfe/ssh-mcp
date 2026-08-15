import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { SSHConnectionManager, execSshCommandWithConnection } from '../src/index';

// The persistent `su -` shell is hard to exercise against a container (it needs a
// root password), so these drive the shell branch of execSshCommandWithConnection
// with a fake stream. That branch is the one with no stdin channel, which is why
// sudo-exec must not wrap a command in `sudo -S` while it is active.

class FakeShell extends EventEmitter {
  written: string[] = [];
  write(chunk: string) {
    this.written.push(chunk);
  }
  end() {}
}

function elevatedManager() {
  const manager = new SSHConnectionManager({ host: '127.0.0.1', port: 22, username: 'test' });
  const shell = new FakeShell();
  // The real elevation path sets these; reproducing it here keeps the test off the network.
  (manager as any).conn = new EventEmitter();
  (manager as any).suShell = shell;
  (manager as any).isElevated = true;
  return { manager, shell };
}

describe('persistent su shell', () => {
  it('reports being a root shell only once elevation completed', () => {
    const { manager } = elevatedManager();
    expect(manager.isRootShell()).toBe(true);

    const plain = new SSHConnectionManager({ host: '127.0.0.1', port: 22, username: 'test' });
    expect(plain.isRootShell()).toBe(false);
  });

  it('runs the command verbatim and reports the fenced exit code', async () => {
    const { manager, shell } = elevatedManager();
    const pending = execSshCommandWithConnection(manager, 'id -u', undefined, 8192);

    // The command reaches the shell unchanged, between the two sentinels.
    const commandWrite = shell.written.find((w) => w.startsWith('id -u'));
    expect(commandWrite).toBe('id -u\n');

    const token = shell.written[0].match(/SSH_MCP""_BEGIN_(\w+)/)![1];
    shell.emit('data', Buffer.from(`SSH_MCP_BEGIN_${token}\n0\nSSH_MCP_END_${token}:0\n`));

    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.trim()).toBe('0');
  });

  it('reads a multi-digit exit code that arrives split across reads', async () => {
    const { manager, shell } = elevatedManager();
    const pending = execSshCommandWithConnection(manager, 'exit 10', undefined, 8192);

    const token = shell.written[0].match(/SSH_MCP""_BEGIN_(\w+)/)![1];
    // The first chunk ends mid-number: reading it eagerly would report exit 1.
    shell.emit('data', Buffer.from(`SSH_MCP_BEGIN_${token}\nSSH_MCP_END_${token}:1`));
    shell.emit('data', Buffer.from('0\n'));

    const result = await pending;
    expect(result.content[0].text).toContain('[exit 10]');
  });

  it('marks a non-zero fenced exit code as an error', async () => {
    const { manager, shell } = elevatedManager();
    const pending = execSshCommandWithConnection(manager, 'false', undefined, 8192);

    const token = shell.written[0].match(/SSH_MCP""_BEGIN_(\w+)/)![1];
    shell.emit('data', Buffer.from(`SSH_MCP_BEGIN_${token}\nSSH_MCP_END_${token}:1\n`));

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[exit 1]');
  });
});
