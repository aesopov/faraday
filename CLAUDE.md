# Faraday

Dual-pane file manager built with Electron + React + Rust.

## Tech Stack

- **Renderer**: React 19, TypeScript 5.9, Vite 7
- **Main process**: Electron 40, Node.js
- **Native layer**: Rust (napi-rs N-API addon for in-process bindings + standalone `frdye` elevated helper)
- **Styling**: FSS (filesystem stylesheets) via `fss-lang` — custom CSS-like language for styling file listings
- **Build**: Electron Forge, pnpm
- **Targets**: macOS, Linux, Windows

## Project Structure

```
src/
  main.ts              # Electron main process entry
  preload.ts           # Preload script (IPC bridge)
  protocol.ts          # Binary IPC protocol (BufReader/BufWriter)
  types.ts             # Shared types (ElectronBridge, FsChangeEvent)
  langDetect.ts        # File language detection
  fs/
    types.ts           # RawFs interface, FsaRawEntry
    native.ts          # Rust napi-rs addon bindings
    elevate.ts         # Spawns privileged frdye helper
    fsProxy.ts         # IPC client for frdye (binary protocol over unix socket)
    ipcHandlers.ts     # Electron IPC handler registration
    wsServer.ts        # WebSocket FS server (standalone mode)
    wsClient.ts        # WebSocket FS client
    wsProtocol.ts      # JSON-RPC + binary frame protocol for WS
  renderer/
    app.tsx            # Root component — dual-pane layout
    renderer.ts        # Renderer entry point
    fsa.ts             # File System Access API shim
    fss.ts             # FSS resolver (layered .faraday/fs.css)
    FileList/          # File list components (virtual scrolling)
    FileViewer.tsx     # Text file viewer
    ImageViewer.tsx    # Image viewer
    ModalDialog.tsx    # Error/confirmation dialogs
    path.ts            # Cross-platform path utilities
rust/
  Cargo.toml           # Workspace manifest
  faraday-core/        # Pure Rust core: ops, proto, watch, error
  faraday-napi/        # napi-rs N-API addon
  frdye/               # Elevated FS helper binary
```

## Architecture

### Filesystem Access Layers

The app accesses the filesystem through multiple backends, all conforming to `RawFs`:

1. **Native (napi-rs)** — Rust compiled as a native Node addon via napi-rs. Used for direct in-process FS operations. Primary backend.
2. **Elevated helper (frdye)** — Standalone Rust binary spawned with elevated privileges. Communicates over unix domain sockets (macOS/Linux) or named pipes (Windows) using a custom binary protocol.
3. **WebSocket** — JSON-RPC 2.0 over WebSocket with binary frames for file data. Used for standalone/remote filesystem access.

### Binary IPC Protocol

Custom length-prefixed binary protocol between TypeScript and Rust (`src/protocol.ts` ↔ `rust/faraday-core/src/proto.rs`):
- Wire format: `[u32 LE payload length][payload]`
- Types: u8, u16 LE, u32 LE, f64 LE, length-prefixed strings (u16 len + UTF-8), length-prefixed bytes (u32 len + data)
- Message types: AUTH (0x01), REQUEST (0x02), RESPONSE (0x82), ERROR (0x83), EVENT (0x84)
- Methods: ping, entries, stat, exists, open, read, close, watch, unwatch

### FSS (Filesystem Stylesheets)

Files are styled using `fss-lang` — a CSS-like language that matches filesystem entries by name, type, and metadata. Stylesheets cascade from `.faraday/fs.css` files found in ancestor directories. The built-in base layer provides Material Icons mappings.

## Commands

```bash
pnpm dev              # Start dev server (electron-forge + vite)
pnpm lint             # ESLint
pnpm build:rust       # Build Rust native addon + frdye (release)
pnpm build:rust:dev   # Build Rust (debug, faster)
pnpm build:native     # Alias for build:rust
pnpm package          # Build native + package Electron app
pnpm make             # Create platform installers
```

## Key Conventions

- Binary protocol changes must stay in sync between `src/protocol.ts` and `rust/faraday-core/src/proto.rs`
- All integers are little-endian in the wire protocol
- File watcher events are delivered via napi-rs ThreadsafeFunction callbacks from the `notify` crate
- The renderer uses a virtual scrolling approach for file lists
- FSS cache is invalidated when `.faraday/fs.css` changes are detected via watch events
