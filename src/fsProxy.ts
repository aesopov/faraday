import type net from 'node:net';
import type { FsChangeEvent, FsIpcRequest, FsIpcResponse, FsIpcError, FsIpcEvent } from './types';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class FsProxy {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buf = '';

  constructor(
    private socket: net.Socket,
    private onWatchEvent: (event: FsChangeEvent) => void,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        this.handleMessage(line);
      }
    });

    socket.on('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('Elevated FS service disconnected'));
      }
      this.pending.clear();
    });
  }

  get isAlive(): boolean {
    return !this.socket.destroyed;
  }

  private handleMessage(line: string): void {
    let msg: FsIpcResponse | FsIpcError | FsIpcEvent;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Watcher event (no id)
    if ('event' in msg) {
      this.onWatchEvent((msg as FsIpcEvent).data);
      return;
    }

    const id = (msg as FsIpcResponse | FsIpcError).id;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);

    if ('error' in msg) {
      const err = new Error((msg as FsIpcError).error.message);
      (err as NodeJS.ErrnoException).code = (msg as FsIpcError).error.code;
      p.reject(err);
    } else {
      let result = (msg as FsIpcResponse).result;
      // Decode base64 binary responses back to Buffer
      if ((msg as FsIpcResponse).binary && typeof result === 'string') {
        result = Buffer.from(result, 'base64');
      }
      p.resolve(result);
    }
  }

  private send(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('Elevated FS service is not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const req: FsIpcRequest = { id, method, args };
      this.socket.write(JSON.stringify(req) + '\n');
    });
  }

  async entries(dirPath: string): Promise<unknown> {
    return this.send('entries', [dirPath]);
  }

  async readFile(filePath: string): Promise<unknown> {
    return this.send('readFile', [filePath]);
  }

  async stat(filePath: string): Promise<unknown> {
    return this.send('stat', [filePath]);
  }

  async exists(filePath: string): Promise<unknown> {
    return this.send('exists', [filePath]);
  }

  async open(filePath: string): Promise<string> {
    const fdId = await this.send('open', [filePath]) as string;
    return `proxy:${fdId}`;
  }

  async read(fdId: string, offset: number, length: number): Promise<Buffer> {
    const remoteFdId = fdId.replace(/^proxy:/, '');
    return this.send('read', [remoteFdId, offset, length]) as Promise<Buffer>;
  }

  async close(fdId: string): Promise<void> {
    const remoteFdId = fdId.replace(/^proxy:/, '');
    await this.send('close', [remoteFdId]);
  }

  async watch(watchId: string, dirPath: string): Promise<unknown> {
    return this.send('watch', [watchId, dirPath]);
  }

  async unwatch(watchId: string): Promise<void> {
    await this.send('unwatch', [watchId]);
  }

  destroy(): void {
    this.socket.destroy();
  }
}
