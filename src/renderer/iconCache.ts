const MAX_SIZE = 200;

// LRU cache using Map insertion order
const cache = new Map<string, string>();
const pending = new Set<string>();
let iconsDir: string | null = null;

async function ensureIconsDir(): Promise<string> {
  if (!iconsDir) {
    const appPath = await window.electron.utils.getAppPath();
    iconsDir = appPath + '/assets/icons';
  }
  return iconsDir;
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
  const toLoad = names.filter((n) => !cache.has(n) && !pending.has(n));
  if (toLoad.length === 0) return;

  await Promise.all(
    toLoad.map(async (name) => {
      pending.add(name);
      try {
        const content = await window.electron.fsa.readFile(`${dir}/${name}`);
        cache.set(name, svgToDataUrl(content));
        evictIfNeeded();
      } catch {
        // Icon file not found — ignore
      } finally {
        pending.delete(name);
      }
    }),
  );
}

export function getCachedIconUrl(name: string): string | undefined {
  const url = cache.get(name);
  if (url !== undefined) {
    touchKey(name);
  }
  return url;
}
