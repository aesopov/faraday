// WebSocket RPC protocol — JSON-RPC 2.0 over text frames,
// binary frames for large payloads (file reads).

// ── JSON-RPC types ──────────────────────────────────────────────────

export interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

// ── Binary frame format ─────────────────────────────────────────────
//
// For fs.read responses, the server sends binary instead of JSON to
// avoid base64 overhead. Format:
//
//   [requestId : uint32 LE] [payload bytes ...]
//
// The requestId matches the JSON-RPC id of the originating request.
// The client resolves the corresponding pending promise with the
// payload bytes. Read errors are still sent as JSON-RPC error responses.

export const BINARY_HEADER_SIZE = 4;

export function encodeBinaryFrame(requestId: number, data: Buffer | Uint8Array): Buffer {
  const header = Buffer.alloc(BINARY_HEADER_SIZE);
  header.writeUInt32LE(requestId, 0);
  return Buffer.concat([header, data]);
}

export function decodeBinaryFrame(msg: ArrayBuffer): { requestId: number; data: ArrayBuffer } {
  const view = new DataView(msg);
  const requestId = view.getUint32(0, true);
  const data = msg.slice(BINARY_HEADER_SIZE);
  return { requestId, data };
}
