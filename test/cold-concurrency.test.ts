// Concurrent callers must not execute on a connection whose SSH handshake is
// still in flight.
//
// `connect()` assigns `this.conn = new Client()` synchronously inside its
// promise executor, and `.connect()` creates the socket immediately. A second
// caller arriving in that window used to find a non-null `conn` with a live
// `_sock` and conclude the connection was usable, so it skipped `connect()`
// entirely and called `conn.exec()` mid-handshake. ssh2 then sent CHANNEL_OPEN
// before KEXINIT and the server dropped the connection — observed as
// "Bad packet length" or ECONNRESET, with every concurrent call failing.
import { describe, it, expect, afterEach } from 'vitest';
import { SSHConnectionManager, execSshCommandWithConnection } from '../src/index';

const host = process.env.SSH_HOST || '127.0.0.1';
const port = Number(process.env.SSH_PORT || 2222);
const username = process.env.SSH_USER || 'test';
const password = process.env.SSH_PASSWORD || 'secret';

const cfg = { host, port, username, password, insecureHostKey: true, noTmux: true };

let manager: SSHConnectionManager | null = null;

afterEach(() => {
  manager?.close();
  manager = null;
});

describe('cold-connection concurrency', () => {
  it('reports a handshaking connection as not yet connected', async () => {
    manager = new SSHConnectionManager(cfg);
    const pending = manager.connect();

    // Same tick as connect(): conn and its socket already exist, but the SSH
    // session is not usable yet. Anything that trusts isConnected() here would
    // exec on a half-open protocol stream.
    expect(manager.isConnected()).toBe(false);

    await pending;
    expect(manager.isConnected()).toBe(true);
  }, 30000);

  it('serves concurrent callers that all arrive on a cold connection', async () => {
    manager = new SSHConnectionManager(cfg);
    const m = manager;

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        await m.ensureConnected();
        return execSshCommandWithConnection(m, `echo concorrente-${n}`);
      }),
    );

    results.forEach((r: any, i) => {
      expect(r.isError, `chamada ${i + 1} falhou: ${r.content[0]?.text}`).not.toBe(true);
      expect(r.content[0].text).toContain(`concorrente-${i + 1}`);
    });
    expect(m.isConnected()).toBe(true);
  }, 60000);

  // Each probe costs its own SSH channel. Without in-flight de-duplication, N
  // concurrent cold callers open N probe channels *plus* N command channels,
  // which crosses sshd's MaxSessions (10 by default) at modest concurrency and
  // gets the excess refused with "Channel open failure: open failed".
  it('probes the host once for concurrent cold callers', async () => {
    manager = new SSHConnectionManager({ ...cfg, noTmux: false });
    const m = manager;
    await m.connect();

    let probes = 0;
    const runProbe = async () => {
      probes += 1;
      await new Promise((r) => setTimeout(r, 50));
      return 'tmux=tmux 3.4\n';
    };

    const modes = await Promise.all([1, 2, 3, 4, 5, 6].map(() => m.resolveMode(runProbe)));

    expect(probes).toBe(1);
    modes.forEach((mode) => expect(mode).toBe('tmux'));
  }, 30000);

  it('opens exactly one connection for concurrent cold callers', async () => {
    manager = new SSHConnectionManager(cfg);
    const m = manager;

    await Promise.all([1, 2, 3].map(() => m.ensureConnected()));

    const pid = async () =>
      ((await execSshCommandWithConnection(m, 'echo $PPID')).content[0] as any).text.trim();
    // Same sshd session process for every caller means they share one connection.
    expect(await pid()).toBe(await pid());
  }, 60000);
});
