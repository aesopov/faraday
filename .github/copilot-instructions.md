# Copilot Instructions

## Build & Run

- **Package manager:** pnpm
- **Dev:** `pnpm dev` (runs `electron-forge start` with Vite HMR)
- **Lint:** `pnpm lint` (ESLint for `.ts` and `.tsx`)
- **Package:** `pnpm package` / `pnpm make`
- **Type-check:** `npx tsc --noEmit`

No test framework is configured.

## Architecture

Faraday is an Electron + React + TypeScript file manager. It uses Electron Forge with Vite for bundling.

### Process Boundaries

- **Main process** (`src/main.ts`): Exposes filesystem operations via IPC handlers prefixed `fsa:` (entries, readFile, stat, readSlice) and utility handlers prefixed `utils:`.
- **Preload** (`src/preload.ts`): Bridges IPC to `window.electron` using `contextBridge`. The shape is defined by the `ElectronBridge` interface in `src/types.ts`.
- **Renderer** (`src/renderer/`): React app mounted on `#app`. All filesystem access goes through `window.electron.fsa.*` — never use Node.js `fs` in the renderer.

### FSA Abstraction Layer

`src/renderer/fsa.ts` implements the Web File System Access API (`FileSystemDirectoryHandle`, `FileSystemFileHandle`) on top of the Electron IPC bridge. `LazyFile` and `LazyBlob` defer reads via `readSlice` IPC calls rather than loading entire files into memory. The filesystem is read-only — write methods throw.

### FSS Styling System

File icons, colors, opacity, and sort order are determined by the `fss-lang` package. `src/renderer/material-icons.fs.css` is a CSS-like stylesheet parsed at runtime by `fss-lang`. The resolver in `src/renderer/fss.ts` maps `FsNode` entries to visual styles. Icon SVGs live in `assets/icons/` and are loaded on demand into an LRU cache (`src/renderer/iconCache.ts`).

### Key Data Flow

1. `App` component calls `DirectoryHandle.entries()` → IPC `fsa:entries` → Node.js `fs.readdir`
2. Raw entries are wrapped into `FsNode` objects (from `fss-lang`) with metadata (size, mtime, permissions, lang detection)
3. `resolveEntryStyle()` applies FSS rules to determine icon, color, opacity, and sort priority
4. `FileList` sorts and virtualizes the entries using `@tanstack/react-virtual`

## Conventions

- **Formatting:** Prettier with single quotes, 160 char line width, trailing commas
- **Path utilities:** Use `src/renderer/path.ts` (`dirname`, `join`, `basename`) in renderer code, not Node.js `path`
- **Language detection:** `src/langDetect.ts` maps file extensions/names to language IDs for FSS styling — add new entries there when supporting new file types
- **Vite config:** Three separate Vite configs exist for main, preload, and renderer processes
