import { FsNode } from 'fss-lang';
import type { LayeredResolver } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectLang } from '../langDetect';
import { FileList } from './FileList';
import { DirectoryHandle, type HandleMeta } from './fsa';
import { createPanelResolver, syncLayers } from './fss';
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

function usePanel() {
  const [state, setState] = useState<PanelState>(emptyPanel);
  const resolverRef = useRef<LayeredResolver>(createPanelResolver());

  const navigateTo = useCallback(async (path: string) => {
    try {
      await syncLayers(resolverRef.current, path);
      const dirHandle = new DirectoryHandle(path);
      const parent = buildParentChain(path);
      const nodes: FsNode[] = [];
      for await (const [, handle] of dirHandle.entries()) {
        nodes.push(handleToFsNode(handle, path, parent));
      }
      setState({ currentPath: path, parentNode: parent, entries: nodes, error: null });
    } catch (err) {
      setState((prev) => ({ ...prev, error: `Failed to read directory: ${err}` }));
    }
  }, []);

  return { ...state, navigateTo, resolver: resolverRef.current };
}

type PanelSide = 'left' | 'right';

export function App() {
  const left = usePanel();
  const right = usePanel();
  const [activePanel, setActivePanel] = useState<PanelSide>('left');

  useEffect(() => {
    window.electron.utils.getHomePath().then((home) => {
      left.navigateTo(home);
      right.navigateTo(home);
    });
  }, []);

  // Tab switches panels
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        setActivePanel((s) => (s === 'left' ? 'right' : 'left'));
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
          {left.error && <div className="error">{left.error}</div>}
          <FileList currentPath={left.currentPath} parentNode={left.parentNode} entries={left.entries} onNavigate={left.navigateTo} active={activePanel === 'left'} resolver={left.resolver} />
        </div>
        <div className={`panel ${activePanel === 'right' ? 'active' : ''}`} onClick={() => setActivePanel('right')}>
          {right.error && <div className="error">{right.error}</div>}
          <FileList currentPath={right.currentPath} parentNode={right.parentNode} entries={right.entries} onNavigate={right.navigateTo} active={activePanel === 'right'} resolver={right.resolver} />
        </div>
      </div>
    </div>
  );
}
