import type net from 'node:net';
import type { FsChangeEvent, FsChangeType } from '../types';
import {
  MSG_RESPONSE,
  MSG_ERROR,
  MSG_EVENT,
  MSG_REQUEST,
  METHOD_ENTRIES,
  METHOD_STAT,
  METHOD_EXISTS,
  METHOD_OPEN,
  METHOD_READ,
  METHOD_CLOSE,
  METHOD_WATCH,
  METHOD_UNWATCH,
  EVT_TYPES,
  BufReader,
  BufWriter,
} from '../protocol';
import type { EntryKind, FsaRawEntry, RawFs } from './types';

type Pending = { resolve: (payload: Buffer) => void; reject: (e: Error) => void };

export class FsProxy implements RawFs {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);

  constructor(
    private socket: net.Socket,
    private onWatchEvent: (event: FsChangeEvent) => void,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.processMessages();
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

  private processMessages(): void {
    while (this.buf.length >= 4) {
      const msgLen = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + msgLen) break;
      const msg = this.buf.subarray(4, 4 + msgLen);
      this.buf = this.buf.subarray(4 + msgLen);
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Buffer): void {
    const type = msg[0];
    const payload = msg.subarray(1);

    if (type === MSG_EVENT) {
      const r = new BufReader(payload);
      const watchId = r.str();
      const typeCode = r.u8();
      const hasName = r.u8();
      const name = hasName ? r.str() : null;
      this.onWatchEvent({ watchId, type: (EVT_TYPES[typeCode] ?? 'unknown') as FsChangeType, name });
      return;
    }

    if (type === MSG_RESPONSE) {
      const id = payload.readUInt32LE(0);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      p.resolve(payload.subarray(4));
      return;
    }

    if (type === MSG_ERROR) {
      const id = payload.readUInt32LE(0);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const r = new BufReader(payload.subarray(4));
      const code = r.str();
      const message = r.str();
      const err = new Error(message);
      (err as NodeJS.ErrnoException).code = code;
      p.reject(err);
    }
  }

  private send(method: number, args: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.socket.destroyed) {
        reject(new Error('Elevated FS service is not connected'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      // Message payload: [MSG_REQUEST][id:4][method:1][args...]
      const header = Buffer.alloc(1 + 4 + 1);
      header[0] = MSG_REQUEST;
      header.writeUInt32LE(id, 1);
      header[5] = method;
      const body = Buffer.concat([header, args]);

      // Wire: [len:4][body...]
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32LE(body.length);
      this.socket.write(Buffer.concat([lenBuf, body]));
    });
  }

  async entries(dirPath: string): Promise<FsaRawEntry[]> {
    const payload = await this.send(METHOD_ENTRIES, new BufWriter().str(dirPath).build());
    const r = new BufReader(payload);
    const count = r.u32();
    // Must stay in sync with kindCode() in zig/src/main.zig
    const KIND_MAP: EntryKind[] = ['unknown', 'file', 'directory', 'symlink', 'block_device', 'char_device', 'named_pipe', 'socket', 'whiteout'];
    const entries = [];
    for (let i = 0; i < count; i++) {
      const name = r.str();
      const kind = KIND_MAP[r.u8()] ?? 'unknown';
      const size = r.f64();
      const mtimeMs = r.f64();
      const mode = r.u32();
      const nlink = r.u32();
      const hidden = r.u8() !== 0;
      const hasLink = r.u8() !== 0;
      const linkTarget = hasLink ? r.str() : undefined;
      entries.push({ name, kind, size, mtimeMs, mode, nlink, hidden, linkTarget });
    }
    return entries;
  }

  async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const payload = await this.send(METHOD_STAT, new BufWriter().str(filePath).build());
    const r = new BufReader(payload);
    return { size: r.f64(), mtimeMs: r.f64() };
  }

  async exists(filePath: string): Promise<boolean> {
    const payload = await this.send(METHOD_EXISTS, new BufWriter().str(filePath).build());
    const r = new BufReader(payload);
    return r.u8() !== 0;
  }

  async open(filePath: string): Promise<string> {
    const payload = await this.send(METHOD_OPEN, new BufWriter().str(filePath).build());
    const r = new BufReader(payload);
    return `proxy:${r.str()}`;
  }

  async read(fdId: string, offset: number, length: number): Promise<Buffer> {
    const remoteFdId = fdId.replace(/^proxy:/, '');
    const payload = await this.send(METHOD_READ, new BufWriter().str(remoteFdId).f64(offset).f64(length).build());
    const r = new BufReader(payload);
    return r.bytes();
  }

  async close(fdId: string): Promise<void> {
    const remoteFdId = fdId.replace(/^proxy:/, '');
    await this.send(METHOD_CLOSE, new BufWriter().str(remoteFdId).build());
  }

  async watch(watchId: string, dirPath: string): Promise<{ ok: boolean }> {
    const payload = await this.send(METHOD_WATCH, new BufWriter().str(watchId).str(dirPath).build());
    const r = new BufReader(payload);
    return { ok: r.u8() !== 0 };
  }

  async unwatch(watchId: string): Promise<void> {
    await this.send(METHOD_UNWATCH, new BufWriter().str(watchId).build());
  }

  destroy(): void {
    this.socket.destroy();
  }
}
