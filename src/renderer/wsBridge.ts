// Browser-side ElectronBridge implementation over WebSocket.
// Connects to the faraday headless server and proxies all fsa/utils/theme
// calls through JSON-RPC 2.0, matching the interface that the Electron
// preload script normally exposes via IPC.

import type { ElectronBridge, FsChangeEvent, FsChangeType } from '../types';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const BINARY_HEADER_SIZE = 4; // uint32 LE requestId prefix on binary frames

export async function createWsBridge(wsUrl: string): Promise<ElectronBridge> {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const changeListeners = new Set<(event: FsChangeEvent) => void>();

  const connected = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      handleText(event.data);
    } else {
      handleBinary(event.data as ArrayBuffer);
    }
  });

  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) {
      reject(new Error('WebSocket connection closed'));
    }
    pending.clear();
  });

  function handleText(text: string): void {
    const msg = JSON.parse(text);

    // JSON-RPC notification (e.g. fs.change watch event)
    if (!('id' in msg) && 'method' in msg) {
      if (msg.method === 'fs.change') {
        const event: FsChangeEvent = {
          watchId: msg.params.watchId as string,
          type: msg.params.type as FsChangeType,
          name: (msg.params.name as string) ?? null,
        };
        for (const cb of changeListeners) cb(event);
      }
      return;
    }

    // JSON-RPC response
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);

    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as NodeJS.ErrnoException).code = msg.error.data?.errno;
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  }

  function handleBinary(data: ArrayBuffer): void {
    const view = new DataView(data);
    const requestId = view.getUint32(0, true);
    const payload = data.slice(BINARY_HEADER_SIZE);

    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    p.resolve(payload);
  }

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    await connected;
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not connected'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // Wraps a call to match the { result } | { error } pattern that the
  // Electron IPC handlers return (WithErrorHandling<RawFs>).
  function wrapCall<T>(fn: () => Promise<T>): Promise<{ result: T } | { error: unknown }> {
    return fn().then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
  }

  const bridge: ElectronBridge = {
    fsa: {
      entries: (dirPath: string) => wrapCall(() => rpc('fs.entries', { path: dirPath }) as Promise<never>),
      stat: (filePath: string) => wrapCall(() => rpc('fs.stat', { path: filePath }) as Promise<never>),
      exists: (filePath: string) => wrapCall(() => rpc('fs.exists', { path: filePath }) as Promise<never>),
      open: (filePath: string) => wrapCall(() => rpc('fs.open', { path: filePath }) as Promise<never>),
      read: (fd: number, offset: number, length: number) => wrapCall(() => rpc('fs.read', { handle: fd, offset, length }) as Promise<never>),
      close: (fd: number) => wrapCall(() => rpc('fs.close', { handle: fd }) as Promise<never>),
      watch: (watchId: string, path: string) => wrapCall(() => rpc('fs.watch', { watchId, path }) as Promise<never>),
      unwatch: (watchId: string) => wrapCall(() => rpc('fs.unwatch', { watchId }) as Promise<never>),
      onFsChange: (callback: (event: FsChangeEvent) => void) => {
        changeListeners.add(callback);
        return () => {
          changeListeners.delete(callback);
        };
      },
    },
    utils: {
      getAppPath: () => rpc('utils.getAppPath', {}) as Promise<string>,
      getHomePath: () => rpc('utils.getHomePath', {}) as Promise<string>,
    },
    theme: {
      get: () => Promise.resolve(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      onChange: (callback: (theme: string) => void) => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e: MediaQueryListEvent) => callback(e.matches ? 'dark' : 'light');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
      },
    },
  };

  // Wait for the WebSocket to connect before returning the bridge
  await connected;
  return bridge;
}
