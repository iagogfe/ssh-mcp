// Local port forwarding (ssh -L): a listener on THIS machine whose connections
// are carried over the existing SSH connection and opened against a target the
// remote host can reach. The use case is reaching a service that only listens
// on the server's loopback -- a database, a cache, an internal admin UI.
//
// Only -L. Remote forwarding (-R) would expose this machine inside the server's
// network, and dynamic forwarding (-D) would hand the agent an arbitrary egress
// proxy through the server; neither is needed for that use case and both are
// far worse to get wrong.
//
// These channels do not compete with the command channel budget. sshd's
// MaxSessions counts "shell, login or subsystem" channels only (sshd_config(5));
// a forwarded connection is a direct-tcpip channel and is not one of those.
// Verified on a live host before writing this.
import { createServer, type Server, type Socket } from 'net';

// Never 0.0.0.0. Binding all interfaces would republish a service that the
// remote host deliberately keeps on loopback to everyone on this machine's
// network -- the tunnel would become the hole the service was avoiding.
const BIND_ADDRESS = '127.0.0.1';

export interface TunnelInfo {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  openedAt: number;
  activeConnections: number;
}

// The subset of ssh2's Client this module needs, so tests can drive it without
// an SSH server and so nothing here depends on src/index.ts.
export interface ForwardingConnection {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    cb: (err: Error | undefined, stream?: NodeJS.ReadWriteStream & { end?: () => void }) => void,
  ): unknown;
}

interface Entry extends TunnelInfo {
  server: Server;
  sockets: Set<Socket>;
}

export class TunnelRegistry {
  private readonly tunnels = new Map<number, Entry>();

  // Resolves once the listener is actually bound, so the caller is handed a
  // port that already accepts connections rather than one that might still
  // fail to bind.
  async open(
    getConn: () => ForwardingConnection,
    remoteHost: string,
    remotePort: number,
    localPort = 0,
  ): Promise<TunnelInfo> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error(`Invalid remote port ${remotePort}: expected 1-65535`);
    }
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      throw new Error(`Invalid local port ${localPort}: expected 0-65535, or 0 to let the OS choose`);
    }

    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // A local client that hangs up mid-forward must not take the process
      // with it; the same goes for the remote side refusing the connection.
      socket.on('error', () => socket.destroy());

      // Resolved per connection, not captured at open time: the manager
      // reconnects on its own after a drop, and a tunnel holding the old
      // Client would forward into a dead connection for the rest of its life.
      getConn().forwardOut(BIND_ADDRESS, socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
        if (err || !stream) {
          socket.destroy();
          return;
        }
        stream.on('error', () => socket.destroy());
        socket.pipe(stream as NodeJS.WritableStream);
        (stream as NodeJS.ReadableStream).pipe(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(localPort, BIND_ADDRESS, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : localPort;
    if (this.tunnels.has(boundPort)) {
      server.close();
      throw new Error(`A tunnel is already open on local port ${boundPort}`);
    }

    // Past bind, an error on the listener itself is not worth crashing over.
    server.on('error', () => { /* individual connections handle their own */ });

    const entry: Entry = {
      localPort: boundPort,
      remoteHost,
      remotePort,
      openedAt: Date.now(),
      activeConnections: 0,
      server,
      sockets,
    };
    this.tunnels.set(boundPort, entry);
    return this.describe(entry);
  }

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((e) => this.describe(e));
  }

  // Returns false when there was nothing to close, so the caller can say so
  // rather than reporting a success it did not perform.
  close(localPort: number): boolean {
    const entry = this.tunnels.get(localPort);
    if (!entry) return false;
    this.tunnels.delete(localPort);
    // Destroy live connections first: server.close() only stops NEW ones and
    // would otherwise wait for every existing one to end on its own.
    for (const socket of entry.sockets) socket.destroy();
    entry.sockets.clear();
    entry.server.close();
    return true;
  }

  closeAll(): void {
    for (const port of [...this.tunnels.keys()]) this.close(port);
  }

  private describe(entry: Entry): TunnelInfo {
    return {
      localPort: entry.localPort,
      remoteHost: entry.remoteHost,
      remotePort: entry.remotePort,
      openedAt: entry.openedAt,
      activeConnections: entry.sockets.size,
    };
  }
}
