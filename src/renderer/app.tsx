import { FsNode } from 'fss-lang';
import { createFsNode } from 'fss-lang/helpers';
import { useCallback, useEffect, useState } from 'react';
import { detectLang } from '../langDetect';
import { FileList } from './FileList';
import { DirectoryHandle, type HandleMeta } from './fsa';
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

export function App() {
  const [currentPath, setCurrentPath] = useState('');
  const [parentNode, setParentNode] = useState<FsNode | undefined>(undefined);
  const [entries, setEntries] = useState<FsNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  const navigateTo = useCallback(async (path: string) => {
    try {
      setError(null);
      const dirHandle = new DirectoryHandle(path);
      const parent = buildParentChain(path);
      const nodes: FsNode[] = [];
      for await (const [, handle] of dirHandle.entries()) {
        nodes.push(handleToFsNode(handle, path, parent));
      }
      setCurrentPath(path);
      setParentNode(parent);
      setEntries(nodes);
    } catch (err) {
      setError(`Failed to read directory: ${err}`);
    }
  }, []);

  useEffect(() => {
    window.electron.utils.getHomePath().then(navigateTo);
  }, [navigateTo]);

  if (!currentPath) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      {error && <div className="error">{error}</div>}
      <FileList currentPath={currentPath} parentNode={parentNode} entries={entries} onNavigate={navigateTo} />
    </div>
  );
}
