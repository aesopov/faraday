# Faraday

Dual-pane file manager built with Electron + React + Zig.

## Tech Stack

- **Renderer**: React 19, TypeScript 5.9, Vite 7
- **Main process**: Electron 40, Node.js
- **Native layer**: Zig (compiled via node-zigar for in-process bindings + standalone `frdye` elevated helper)
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
    native.ts          # node-zigar bindings (in-process Zig)
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
zig/
  build.zig            # Zig build for frdye executable
  src/
    main.zig           # frdye — elevated FS helper (unix socket server)
    proto.zig          # Binary protocol (mirrors src/protocol.ts)
    ops.zig            # FS operations (entries, stat, read, watch)
    fs_zigar.zig       # In-process Zig module exposed via node-zigar
    fsevents.zig       # macOS FSEvents watcher
    watch.zig          # Cross-platform watch abstraction
```

## Architecture

### Filesystem Access Layers

The app accesses the filesystem through multiple backends, all conforming to `RawFs`:

1. **Native (node-zigar)** — Zig compiled as a native Node addon via zigar. Used for direct in-process FS operations. Primary backend.
2. **Elevated helper (frdye)** — Standalone Zig binary spawned with elevated privileges. Communicates over unix domain sockets (macOS/Linux) or named pipes (Windows) using a custom binary protocol.
3. **WebSocket** — JSON-RPC 2.0 over WebSocket with binary frames for file data. Used for standalone/remote filesystem access.

### Binary IPC Protocol

Custom length-prefixed binary protocol between TypeScript and Zig (`src/protocol.ts` ↔ `zig/src/proto.zig`):
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
pnpm build:zigar      # Build Zig native module (node-zigar)
pnpm build:frdye      # Build elevated helper binary
pnpm build:native     # Build both Zig artifacts
pnpm package          # Build native + package Electron app
pnpm make             # Create platform installers
```

## Key Conventions

- Binary protocol changes must stay in sync between `src/protocol.ts` and `zig/src/proto.zig`
- All integers are little-endian in the wire protocol
- File watcher events are polled every 50ms from Zig's in-memory event queue
- The renderer uses a virtual scrolling approach for file lists
- FSS cache is invalidated when `.faraday/fs.css` changes are detected via watch events
