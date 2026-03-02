import net from 'node:net';
import { FsOps } from './fsOps';
import type { FsIpcRequest, FsIpcResponse, FsIpcError, FsIpcEvent, FsIpcAuth } from './types';

export function startFsService(): void {
  const args = process.argv;
  const socketPath = args[args.indexOf('--socket') + 1];
  const token = args[args.indexOf('--token') + 1];

  if (!socketPath || !token) {
    console.error('fsService: missing --socket or --token');
    process.exit(1);
  }

  const ops = new FsOps((event) => {
    if (socket && !socket.destroyed) {
      const msg: FsIpcEvent = { event: 'change', data: event };
      socket.write(JSON.stringify(msg) + '\n');
    }
  });

  let socket: net.Socket;

  socket = net.createConnection(socketPath, () => {
    // Authenticate immediately
    const auth: FsIpcAuth = { auth: token };
    socket.write(JSON.stringify(auth) + '\n');
  });

  let buf = '';
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleRequest(line);
    }
  });

  async function handleRequest(line: string): Promise<void> {
    let req: FsIpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }

    try {
      const result = await ops.dispatch(req.method, req.args);
      if (Buffer.isBuffer(result)) {
        const resp: FsIpcResponse = { id: req.id, result: result.toString('base64'), binary: true };
        socket.write(JSON.stringify(resp) + '\n');
      } else {
        const resp: FsIpcResponse = { id: req.id, result };
        socket.write(JSON.stringify(resp) + '\n');
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      const resp: FsIpcError = { id: req.id, error: { code: e.code ?? 'UNKNOWN', message: e.message } };
      socket.write(JSON.stringify(resp) + '\n');
    }
  }

  socket.on('close', () => {
    ops.closeAll();
    process.exit(0);
  });

  socket.on('error', () => {
    ops.closeAll();
    process.exit(1);
  });
}
