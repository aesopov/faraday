import { DirectoryHandle } from './fsa';

const MAX_SIZE = 200;

// LRU cache using Map insertion order
const cache = new Map<string, string>();
const pending = new Map<string, Promise<void>>();
let iconsDirHandle: DirectoryHandle | null = null;

async function ensureIconsDir(): Promise<DirectoryHandle> {
  if (!iconsDirHandle) {
    const appPath = await window.electron.utils.getAppPath();
    iconsDirHandle = new DirectoryHandle(appPath + '/assets/icons');
  }
  return iconsDirHandle;
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function touchKey(key: string): void {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
}

function evictIfNeeded(): void {
  while (cache.size > MAX_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
}

export async function loadIcons(names: string[]): Promise<void> {
  const dir = await ensureIconsDir();
  const promises: Promise<void>[] = [];

  for (const name of names) {
    if (cache.has(name)) continue;

    if (pending.has(name)) {
      promises.push(pending.get(name)!);
      continue;
    }

    const p = (async () => {
      try {
        const handle = await dir.getFileHandle(name);
        const file = await handle.getFile();
        const content = await file.text();
        cache.set(name, svgToDataUrl(content));
        evictIfNeeded();
      } catch {
        // Icon file not found — ignore
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, p);
    promises.push(p);
  }

  await Promise.all(promises);
}

export function getCachedIconUrl(name: string): string | undefined {
  const url = cache.get(name);
  if (url !== undefined) {
    touchKey(name);
  }
  return url;
}
