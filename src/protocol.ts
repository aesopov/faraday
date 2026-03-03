// Binary IPC protocol constants and buffer helpers.
// Must stay in sync with native/proto.h.

/* Message types */
export const MSG_AUTH = 0x01;
export const MSG_REQUEST = 0x02;
export const MSG_RESPONSE = 0x82;
export const MSG_ERROR = 0x83;
export const MSG_EVENT = 0x84;

/* Method codes */
export const METHOD_PING = 0x01;
export const METHOD_ENTRIES = 0x02;
export const METHOD_STAT = 0x03;
export const METHOD_EXISTS = 0x04;
export const METHOD_OPEN = 0x05;
export const METHOD_READ = 0x06;
export const METHOD_CLOSE = 0x07;
export const METHOD_WATCH = 0x08;
export const METHOD_UNWATCH = 0x09;

/* Event type codes → FsChangeType strings */
export const EVT_TYPES = ['appeared', 'disappeared', 'modified', 'errored', 'unknown'] as const;

export class BufReader {
  private off = 0;
  constructor(private buf: Buffer) {}

  u8(): number {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  f64(): number {
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }

  str(): string {
    const len = this.u16();
    const s = this.buf.toString('utf-8', this.off, this.off + len);
    this.off += len;
    return s;
  }

  bytes(): Buffer {
    const len = this.u32();
    const b = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return b;
  }
}

export class BufWriter {
  private buf: Buffer;
  private off = 0;

  constructor(size = 256) {
    this.buf = Buffer.alloc(size);
  }

  private ensure(n: number): void {
    if (this.off + n > this.buf.length) {
      const next = Buffer.alloc(Math.max(this.buf.length * 2, this.off + n));
      this.buf.copy(next);
      this.buf = next;
    }
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf.writeUInt8(v, this.off);
    this.off += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.buf.writeUInt16LE(v, this.off);
    this.off += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.buf.writeUInt32LE(v, this.off);
    this.off += 4;
    return this;
  }
  f64(v: number): this {
    this.ensure(8);
    this.buf.writeDoubleLE(v, this.off);
    this.off += 8;
    return this;
  }

  str(s: string): this {
    const data = Buffer.from(s, 'utf-8');
    this.u16(data.length);
    this.ensure(data.length);
    data.copy(this.buf, this.off);
    this.off += data.length;
    return this;
  }

  build(): Buffer {
    return this.buf.subarray(0, this.off);
  }
}
