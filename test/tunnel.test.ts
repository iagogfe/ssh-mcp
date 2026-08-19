// Drives real TCP through the registry with a fake SSH connection standing in
// for forwardOut, so the piping, the bind address and the teardown are all
// exercised without an SSH server.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server } from 'net';
import { TunnelRegistry, type ForwardingConnection } from '../src/tunnel';

const registries: TunnelRegistry[] = [];
const servers: Server[] = [];
afterEach(() => {
  while (registries.length) registries.pop()!.closeAll();
  while (servers.length) servers.pop()!.close();
});

function reg(): TunnelRegistry {
  const r = new TunnelRegistry();
  registries.push(r);
  return r;
}

// Stands in for the remote service: whatever it receives, it echoes uppercased,
// so a byte arriving back proves the whole path carried it.
async function echoServer(): Promise<number> {
  const server = createServer((s) => s.on('data', (d) => s.write(d.toString().toUpperCase())));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as any).port;
}

// forwardOut that really connects to the target, so the registry's piping is
// tested end to end rather than against a stub that echoes by itself.
function realConn(): ForwardingConnection {
  return {
    forwardOut(_sIP, _sPort, dstIP, dstPort, cb) {
      const sock = connect(dstPort, dstIP, () => cb(undefined, sock as any));
      sock.on('error', (e) => cb(e));
      return undefined;
    },
  };
}

function failingConn(message: string): ForwardingConnection {
  return { forwardOut(_a, _b, _c, _d, cb) { cb(new Error(message)); return undefined; } };
}

async function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = connect(port, '127.0.0.1', () => c.write(payload));
    c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
    c.on('error', reject);
    setTimeout(() => reject(new Error('sem resposta pelo tunel')), 4000);
  });
}

describe('TunnelRegistry', () => {
  it('carries bytes from a local port to the remote service', async () => {
    const target = await echoServer();
    const r = reg();

    const t = await r.open(() => realConn(), '127.0.0.1', target);

    expect(t.localPort).toBeGreaterThan(0);
    expect(await roundTrip(t.localPort, 'ping')).toBe('PING');
  });

  it('binds loopback only, never every interface', async () => {
    // Binding 0.0.0.0 would republish a service the remote host deliberately
    // keeps on its own loopback to this machine's whole network.
    const target = await echoServer();
    const r = reg();
    const t = await r.open(() => realConn(), '127.0.0.1', target);

    const address = (r as any).tunnels.get(t.localPort).server.address();
    expect(address.address).toBe('127.0.0.1');
  });

  it('lets the OS pick the local port by default, and honours an explicit one', async () => {
    const target = await echoServer();
    const r = reg();

    const auto = await r.open(() => realConn(), '127.0.0.1', target);
    expect(auto.localPort).toBeGreaterThan(0);

    // Reuse a port we know is free: the one just released by a closed tunnel.
    const chosen = auto.localPort;
    r.close(chosen);
    const explicit = await r.open(() => realConn(), '127.0.0.1', target, chosen);
    expect(explicit.localPort).toBe(chosen);
  });

  it('reports what is open, and stops reporting it once closed', async () => {
    const target = await echoServer();
    const r = reg();
    const t = await r.open(() => realConn(), 'db.internal', target);

    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]).toMatchObject({ remoteHost: 'db.internal', remotePort: target });

    expect(r.close(t.localPort)).toBe(true);
    expect(r.list()).toHaveLength(0);
  });

  it('says so instead of claiming success when there is nothing to close', () => {
    expect(reg().close(65000)).toBe(false);
  });

  it('refuses a port that cannot be a port', async () => {
    const r = reg();
    await expect(r.open(() => realConn(), 'h', 0)).rejects.toThrow(/remote port/i);
    await expect(r.open(() => realConn(), 'h', 70000)).rejects.toThrow(/remote port/i);
    await expect(r.open(() => realConn(), 'h', 22, -1)).rejects.toThrow(/local port/i);
  });

  it('drops the local connection when the remote side refuses it', async () => {
    const r = reg();
    const t = await r.open(() => failingConn('open failed'), 'nope.internal', 5432);

    // The listener still accepts -- the failure is per connection. It must
    // close that connection promptly rather than leave the client hanging,
    // so this waits for the close itself instead of for a timeout: a test
    // that passes by running out of patience would pass just as well if the
    // socket were never closed at all.
    const c = connect(t.localPort, '127.0.0.1');
    let gotData = false;
    c.on('data', () => { gotData = true; });
    await new Promise<void>((res, rej) => {
      c.on('close', () => res());
      c.on('error', () => res()); // ECONNRESET is a valid way to be dropped
      setTimeout(() => rej(new Error('conexao ficou pendurada')), 2000);
    });
    expect(gotData, 'nada deve trafegar quando o lado remoto recusa').toBe(false);
    expect(r.list(), 'o tunel nao deve sumir por causa de uma conexao falha').toHaveLength(1);
  });

  it('kills live connections on close instead of waiting them out', async () => {
    const target = await echoServer();
    const r = reg();
    const t = await r.open(() => realConn(), '127.0.0.1', target);

    const held = connect(t.localPort, '127.0.0.1');
    await new Promise<void>((res) => held.on('connect', () => res()));
    const closed = new Promise<void>((res) => held.on('close', () => res()));

    r.close(t.localPort);

    // Without destroying sockets, server.close() waits for this to end on its
    // own and the promise below never settles.
    await closed;
    expect(r.list()).toHaveLength(0);
  });

  it('closeAll leaves nothing behind', async () => {
    const target = await echoServer();
    const r = reg();
    await r.open(() => realConn(), '127.0.0.1', target);
    await r.open(() => realConn(), '127.0.0.1', target);
    expect(r.list()).toHaveLength(2);

    r.closeAll();
    expect(r.list()).toHaveLength(0);
  });

  it('counts the connections currently riding a tunnel', async () => {
    const target = await echoServer();
    const r = reg();
    const t = await r.open(() => realConn(), '127.0.0.1', target);
    expect(r.list()[0].activeConnections).toBe(0);

    const c = connect(t.localPort, '127.0.0.1');
    await new Promise<void>((res) => c.on('connect', () => res()));
    await new Promise((res) => setTimeout(res, 30));
    expect(r.list()[0].activeConnections).toBe(1);
    c.destroy();
  });
});
