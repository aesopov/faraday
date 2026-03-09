// WebSocket filesystem server — JSON-RPC 2.0 + binary frames.
//
// Uses Node.js fs for all operations (no native dependency), so this
// server can run standalone outside of Electron.

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FsaRawEntry } from './types';
import type { FsChangeType } from '../types';

function direntKind(d: import('node:fs').Dirent): import('./types').EntryKind {
  if (d.isDirectory()) return 'directory';
  if (d.isSymbolicLink()) return 'symlink';
  if (d.isBlockDevice()) return 'block_device';
  if (d.isCharacterDevice()) return 'char_device';
  if (d.isFIFO()) return 'named_pipe';
  if (d.isSocket()) return 'socket';
  if (d.isFile()) return 'file';
  return 'unknown';
}
import { encodeBinaryFrame, type RpcRequest } from './wsProtocol';

// ── Per-connection session ──────────────────────────────────────────

class FsSession {
  private nextHandle = 1;
  private files = new Map<number, fsPromises.FileHandle>();
  private watches = new Map<string, fs.FSWatcher>();
  private appPath?: string;

  constructor(private ws: WebSocket, appPath?: string) {
    this.appPath = appPath;
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) {
        this.handleText(data.toString());
      }
      // Client never sends binary frames (only server does for reads)
    });
    ws.on('close', () => this.cleanup());
  }

  private async handleText(text: string): Promise<void> {
    let msg: RpcRequest;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg.id && msg.id !== 0) return;

    try {
      // fs.read sends binary directly — no JSON result
      if (msg.method === 'fs.read') {
        const p = msg.params;
        const data = await this.readFile(p.handle as number, p.offset as number, p.length as number);
        this.ws.send(encodeBinaryFrame(msg.id, data));
        return;
      }

      const result = await this.dispatch(msg);
      this.sendJson({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      this.sendJson({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -1,
          message: e.message,
          data: { errno: e.code ?? 'EIO' },
        },
      });
    }
  }

  private async dispatch(msg: RpcRequest): Promise<unknown> {
    const p = msg.params;
    switch (msg.method) {
      case 'fs.entries':
        return this.entries(p.path as string);
      case 'fs.stat':
        return this.stat(p.path as string);
      case 'fs.exists':
        return this.exists(p.path as string);
      case 'fs.open':
        return this.openFile(p.path as string);
      case 'fs.close':
        return this.closeFile(p.handle as number);
      case 'fs.watch':
        return this.watch(p.watchId as string, p.path as string);
      case 'fs.unwatch':
        return this.unwatch(p.watchId as string);
      case 'utils.getAppPath':
        return this.appPath ?? process.cwd();
      case 'utils.getHomePath':
        return os.homedir();
      default:
        throw Object.assign(new Error(`Unknown method: ${msg.method}`), { code: 'EINVAL' });
    }
  }

  // ── FS operations ───────────────────────────────────────────────

  private async entries(dirPath: string): Promise<FsaRawEntry[]> {
    const dirents = await fsPromises.readdir(dirPath, { withFileTypes: true });
    const result: FsaRawEntry[] = [];
    for (const d of dirents) {
      const fullPath = path.join(dirPath, d.name);
      let size = 0,
        mtimeMs = 0,
        mode = 0,
        nlink = 1;
      try {
        // stat() follows symlinks — target size/mtime/mode
        const st = await fsPromises.stat(fullPath);
        size = st.size;
        mtimeMs = st.mtimeMs;
        mode = st.mode;
      } catch {
        /* skip stat errors */
      }
      try {
        // lstat() doesn't follow — own hard-link count
        const lst = await fsPromises.lstat(fullPath);
        nlink = lst.nlink;
      } catch {
        /* skip */
      }
      let linkTarget: string | undefined;
      if (direntKind(d) === 'symlink') {
        try {
          linkTarget = await fsPromises.readlink(fullPath);
        } catch {
          /* skip */
        }
      }
      result.push({
        name: d.name,
        kind: direntKind(d),
        size,
        mtimeMs,
        mode,
        nlink,
        // Node.js fs doesn't expose Windows hidden attribute; use dot-file convention on all platforms
        hidden: d.name.startsWith('.'),
        linkTarget,
      });
    }
    return result;
  }

  private async stat(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const st = await fsPromises.stat(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs };
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async openFile(filePath: string): Promise<number> {
    const fh = await fsPromises.open(filePath, 'r');
    const handle = this.nextHandle++;
    this.files.set(handle, fh);
    return handle;
  }

  private async readFile(handle: number, offset: number, length: number): Promise<Buffer> {
    const fh = this.files.get(handle);
    if (!fh) throw Object.assign(new Error('Invalid handle'), { code: 'EBADF' });
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  }

  private async closeFile(handle: number): Promise<void> {
    const fh = this.files.get(handle);
    if (fh) {
      await fh.close();
      this.files.delete(handle);
    }
  }

  private watch(watchId: string, dirPath: string): { ok: boolean } {
    try {
      const watcher = fs.watch(dirPath, async (_eventType, filename) => {
        if (!filename) return;
        let type: FsChangeType;
        if (_eventType === 'rename') {
          const exists = await fsPromises.access(path.join(dirPath, filename)).then(
            () => true,
            () => false,
          );
          type = exists ? 'appeared' : 'disappeared';
        } else {
          type = 'modified';
        }
        this.sendNotification('fs.change', { watchId, type, name: filename });
      });
      watcher.on('error', () => {
        this.sendNotification('fs.change', { watchId, type: 'errored', name: null });
      });
      this.watches.set(watchId, watcher);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private unwatch(watchId: string): void {
    const watcher = this.watches.get(watchId);
    if (watcher) {
      watcher.close();
      this.watches.delete(watchId);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private sendJson(msg: object): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.sendJson({ jsonrpc: '2.0', method, params });
  }

  private async cleanup(): Promise<void> {
    for (const fh of this.files.values()) {
      await fh.close().catch(() => {});
    }
    this.files.clear();
    for (const watcher of this.watches.values()) {
      watcher.close();
    }
    this.watches.clear();
  }
}

// ── Server factory ──────────────────────────────────────────────────

export interface FsServerOptions {
  port: number;
  host?: string;
}

export function startFsServer(options: FsServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1' });
  wss.on('connection', (ws) => {
    new FsSession(ws);
  });
  return wss;
}

// ── Headless server (HTTP static + WebSocket FS) ────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface HeadlessServerOptions {
  port: number;
  host?: string;
  staticDir: string;
  appPath: string;
}

export function startHeadlessServer(options: HeadlessServerOptions): void {
  const { port, host = '127.0.0.1', staticDir, appPath } = options;

  const hasStaticFiles = fs.existsSync(path.join(staticDir, 'index.html'));

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    let urlPath = new URL(req.url!, 'http://localhost').pathname;
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(staticDir, urlPath);
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end();
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          fs.readFile(path.join(staticDir, 'index.html'), (err2, html) => {
            if (err2) { res.writeHead(404); res.end('Not found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); }
          });
        } else {
          res.writeHead(500);
          res.end();
        }
        return;
      }
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  const server = createServer((req, res) => {
    if (hasStaticFiles) {
      serveStatic(req, res);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`Faraday WebSocket server running. Connect the web UI to ws://${host}:${port}/ws`);
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => new FsSession(ws, appPath));

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url!, 'http://localhost').pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(port, host, () => {
    console.log(`Faraday headless server listening on http://${host}:${port}`);
    if (hasStaticFiles) {
      console.log(`Serving web UI from ${staticDir}`);
    }
    console.log(`WebSocket endpoint: ws://${host}:${port}/ws`);
  });
}
