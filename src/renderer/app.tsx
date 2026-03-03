import { FsNode } from 'fss-lang';
import type { LayeredResolver, ThemeKind } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsChangeType } from '../types';
import { detectLang } from '../langDetect';
import { actionQueue } from './actionQueue';
import { FileList } from './FileList';
import { FileViewer } from './FileViewer';
import { ImageViewer, isImageFile } from './ImageViewer';
import { DirectoryHandle, FileSystemObserver, type FileSystemChangeRecord, type HandleMeta } from './fsa';
import { createPanelResolver, invalidateFssCache, syncLayers } from './fss';
import { basename, dirname, join } from './path';

function buildParentChain(dirPath: string): FsNode | undefined {
  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  ancestors.reverse();

  let node: FsNode | undefined;
  for (const p of ancestors) {
    node = createFsNode({
      name: basename(p) || p,
      type: 'folder',
      path: p,
      parent: node,
    });
  }
  return node;
}

function handleToFsNode(handle: FileSystemHandle & { meta?: HandleMeta }, dirPath: string, parent?: FsNode): FsNode {
  const isDir = handle.kind === 'directory';
  return createFsNode({
    name: handle.name,
    type: isDir ? 'folder' : 'file',
    lang: isDir ? '' : detectLang(handle.name),
    meta: {
      size: handle.meta?.size ?? 0,
      mtimeMs: handle.meta?.mtimeMs ?? 0,
      executable: !isDir && handle.meta != null && (handle.meta.mode & 0o111) !== 0,
      hidden: handle.name.startsWith('.'),
    },
    path: join(dirPath, handle.name),
    parent,
  });
}

interface PanelState {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  error: string | null;
}

const emptyPanel: PanelState = { currentPath: '', parentNode: undefined, entries: [], error: null };

async function findExistingParent(startPath: string): Promise<string> {
  let cur = dirname(startPath);
  while (cur !== '/') {
    if (await window.electron.fsa.exists(cur)) return cur;
    cur = dirname(cur);
  }
  return '/';
}

function getAncestors(dirPath: string): string[] {
  const ancestors: string[] = [];
  let cur = dirPath;
  while (true) {
    ancestors.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return ancestors;
}

function usePanel(theme: ThemeKind) {
  const [state, setState] = useState<PanelState>(emptyPanel);
  const [navigating, setNavigating] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navAbortRef = useRef<AbortController | null>(null);
  const resolverRef = useRef<LayeredResolver | null>(null);
  if (!resolverRef.current) {
    resolverRef.current = createPanelResolver(theme);
  }

  const observerRef = useRef<FileSystemObserver | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string>('');

  useEffect(() => {
    resolverRef.current!.setTheme(theme);
  }, [theme]);

  const setupWatches = useCallback((dirPath: string) => {
    const observer = observerRef.current!;
    observer.disconnect();
    const ancestors = getAncestors(dirPath);
    for (const ancestor of ancestors) {
      observer.observe(new DirectoryHandle(ancestor));
      observer.observe(new DirectoryHandle(join(ancestor, '.faraday')));
    }
  }, []);

  const navigateTo = useCallback(async (path: string) => {
    navAbortRef.current?.abort();
    const abort = new AbortController();
    navAbortRef.current = abort;

    navTimerRef.current = setTimeout(() => setNavigating(true), 300);
    try {
      const work = (async () => {
        currentPathRef.current = path;
        await syncLayers(resolverRef.current!, path);
        if (abort.signal.aborted) return;
        const dirHandle = new DirectoryHandle(path);
        const parent = buildParentChain(path);
        const nodes: FsNode[] = [];
        for await (const [, handle] of dirHandle.entries()) {
          if (abort.signal.aborted) return;
          nodes.push(handleToFsNode(handle, path, parent));
        }
        if (abort.signal.aborted) return;
        setState({ currentPath: path, parentNode: parent, entries: nodes, error: null });
        setupWatches(path);
      })();
      // Suppress unhandled rejection from orphaned work after abort
      work.catch(() => {});
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          abort.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
    } catch (err) {
      if (!abort.signal.aborted) {
        setState((prev) => ({ ...prev, error: `Failed to read directory: ${err}` }));
      }
    } finally {
      clearTimeout(navTimerRef.current!);
      navTimerRef.current = null;
      setNavigating(false);
    }
  }, [setupWatches]);

  const cancelNavigation = useCallback(() => {
    navAbortRef.current?.abort();
    navAbortRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    setNavigating(false);
  }, []);

  // Initialize observer once
  useEffect(() => {
    const handleRecords = (records: FileSystemChangeRecord[]) => {
      const curPath = currentPathRef.current;
      if (!curPath) return;

      let needsRefresh = false;
      let needsFssRefresh = false;
      let navigateUp = false;

      for (const record of records) {
        const rootPath = record.root.path;
        const changedName = record.relativePathComponents[0] ?? null;
        const type: FsChangeType = record.type;

        if (rootPath === curPath) {
          // Current directory changed
          if (type === 'errored') {
            navigateUp = true;
          } else {
            needsRefresh = true;
          }
        } else if (rootPath.endsWith('/.faraday')) {
          // A .faraday directory changed
          if (changedName === 'fs.css') {
            const parentDir = dirname(rootPath);
            invalidateFssCache(parentDir);
            needsFssRefresh = true;
          }
        } else if (curPath.startsWith(rootPath + '/') || curPath === rootPath) {
          // Ancestor directory changed
          if (changedName === '.faraday') {
            invalidateFssCache(rootPath);
            needsFssRefresh = true;
          } else if (changedName) {
            // Check if the changed entry is the next segment of our path
            const relative = curPath.slice(rootPath.length + 1);
            const nextSegment = relative.split('/')[0];
            if (changedName === nextSegment && type === 'disappeared') {
              navigateUp = true;
            }
          }
        }
      }

      if (navigateUp) {
        // Bypass debounce — navigate immediately
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        findExistingParent(curPath).then((parent) => {
          navigateToRef.current(parent);
        });
        return;
      }

      if (needsRefresh || needsFssRefresh) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          navigateToRef.current(currentPathRef.current);
        }, 100);
      }
    };

    observerRef.current = new FileSystemObserver(handleRecords);

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  // Keep a ref to navigateTo so the observer callback always has the latest
  const navigateToRef = useRef(navigateTo);
  navigateToRef.current = navigateTo;

  return { ...state, navigateTo, navigating, cancelNavigation, resolver: resolverRef.current! };
}

type PanelSide = 'left' | 'right';

export function App() {
  const [theme, setTheme] = useState<ThemeKind>('dark');
  const left = usePanel(theme);
  const right = usePanel(theme);
  const [activePanel, setActivePanel] = useState<PanelSide>('left');
  const [viewerFile, setViewerFile] = useState<{ path: string; name: string; size: number } | null>(null);

  const handleViewFile = useCallback((filePath: string, fileName: string, fileSize: number) => {
    setViewerFile({ path: filePath, name: fileName, size: fileSize });
  }, []);

  useEffect(() => {
    window.electron.theme.get().then((t) => setTheme(t as ThemeKind));
    return window.electron.theme.onChange((t) => setTheme(t as ThemeKind));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    window.electron.utils.getHomePath().then((home) => {
      left.navigateTo(home);
      right.navigateTo(home);
    });
  }, []);

  // Tab switches panels, Escape cancels navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        actionQueue.enqueue(() => setActivePanel((s) => (s === 'left' ? 'right' : 'left')));
      } else if (e.key === 'Escape') {
        left.cancelNavigation();
        right.cancelNavigation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!left.currentPath || !right.currentPath) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      <div className="panels">
        <div className={`panel ${activePanel === 'left' ? 'active' : ''}`} onClick={() => setActivePanel('left')}>
          {left.navigating && <div className="panel-progress" />}
          {left.error && <div className="error">{left.error}</div>}
          <FileList
            currentPath={left.currentPath}
            parentNode={left.parentNode}
            entries={left.entries}
            onNavigate={left.navigateTo}
            onViewFile={handleViewFile}
            active={activePanel === 'left'}
            resolver={left.resolver}
          />
        </div>
        <div className={`panel ${activePanel === 'right' ? 'active' : ''}`} onClick={() => setActivePanel('right')}>
          {right.navigating && <div className="panel-progress" />}
          {right.error && <div className="error">{right.error}</div>}
          <FileList
            currentPath={right.currentPath}
            parentNode={right.parentNode}
            entries={right.entries}
            onNavigate={right.navigateTo}
            onViewFile={handleViewFile}
            active={activePanel === 'right'}
            resolver={right.resolver}
          />
        </div>
      </div>
      {viewerFile && (
        isImageFile(viewerFile.name) ? (
          <ImageViewer
            filePath={viewerFile.path}
            fileName={viewerFile.name}
            fileSize={viewerFile.size}
            onClose={() => setViewerFile(null)}
          />
        ) : (
          <FileViewer
            filePath={viewerFile.path}
            fileName={viewerFile.name}
            fileSize={viewerFile.size}
            onClose={() => setViewerFile(null)}
          />
        )
      )}
    </div>
  );
}
