// WebSocket filesystem client — implements RawFs over WebSocket.
//
// Designed for browser (SPA) or Node.js. Uses the native WebSocket API
// (available in browsers and Node.js 22+).

import type { FsaRawEntry, RawFs } from './types';
import type { FsChangeEvent, FsChangeType } from '../types';
import { BINARY_HEADER_SIZE } from './wsProtocol';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export class WsFs implements RawFs {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private connected: Promise<void>;
  private onWatchEvent?: (event: FsChangeEvent) => void;

  constructor(url: string, onWatchEvent?: (event: FsChangeEvent) => void) {
    this.onWatchEvent = onWatchEvent;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';

    this.connected = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        this.handleText(event.data);
      } else {
        this.handleBinary(event.data as ArrayBuffer);
      }
    });

    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('WebSocket connection closed'));
      }
      this.pending.clear();
    });
  }

  get isAlive(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  // ── Message handling ────────────────────────────────────────────

  private handleText(text: string): void {
    const msg = JSON.parse(text);

    // JSON-RPC notification (e.g. fs.change watch event)
    if (!('id' in msg) && 'method' in msg) {
      if (msg.method === 'fs.change') {
        this.onWatchEvent?.({
          watchId: msg.params.watchId as string,
          type: msg.params.type as FsChangeType,
          name: (msg.params.name as string) ?? null,
        });
      }
      return;
    }

    // JSON-RPC response
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as NodeJS.ErrnoException).code = msg.error.data?.errno;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  private handleBinary(data: ArrayBuffer): void {
    const view = new DataView(data);
    const requestId = view.getUint32(0, true);
    const payload = data.slice(BINARY_HEADER_SIZE);

    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(payload);
  }

  // ── RPC call ────────────────────────────────────────────────────

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connected;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // ── RawFs implementation ────────────────────────────────────────

  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    return (await this.rpc('fs.entries', { path: dirPath })) as FsaRawEntry[];
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    return (await this.rpc('fs.stat', { path: filePath })) as { size: number; mtimeMs: number };
  }

  async exists(filePath: string): Promise<boolean> {
    return (await this.rpc('fs.exists', { path: filePath })) as boolean;
  }

  async open(filePath: string): Promise<number> {
    return (await this.rpc('fs.open', { path: filePath })) as number;
  }

  async read(fd: number, offset: number, length: number): Promise<Buffer> {
    const data = await this.rpc('fs.read', { handle: fd, offset, length });
    // Binary frame: data is an ArrayBuffer
    if (data instanceof ArrayBuffer) {
      return Buffer.from(data);
    }
    return data as Buffer;
  }

  async close(fd: number): Promise<void> {
    await this.rpc('fs.close', { handle: fd });
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    return (await this.rpc('fs.watch', { watchId, path: dirPath })) as { ok: boolean };
  }

  async unwatch(watchId: string): Promise<void> {
    await this.rpc('fs.unwatch', { watchId });
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  disconnect(): void {
    this.ws.close();
  }
}
