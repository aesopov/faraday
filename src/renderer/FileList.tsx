import { FsNode } from 'fss-lang';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { resolveEntryStyle } from './fss';
import { loadIcons, getCachedIconUrl } from './iconCache';
import { dirname, join } from './path';

const ROW_HEIGHT = 26;

interface FileListProps {
  currentPath: string;
  parentNode?: FsNode;
  entries: FsNode[];
  onNavigate: (path: string) => void;
}

function formatSize(sizeValue: unknown): string {
  let size: number;
  if (typeof sizeValue === 'number') {
    size = sizeValue;
  } else if (typeof sizeValue === 'bigint') {
    size = Number(sizeValue);
  } else {
    return '';
  }
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getIconUrl(iconName: string | null, isDirectory: boolean): string | undefined {
  if (iconName) {
    const url = getCachedIconUrl(iconName);
    if (url) return url;
  }
  return getCachedIconUrl(isDirectory ? 'folder.svg' : 'file.svg');
}

export function FileList({ currentPath, parentNode, entries, onNavigate }: FileListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, setIconsVersion] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevPathRef = useRef(currentPath);

  // Resolve styles and sort using FSS
  const sorted = useMemo(() => {
    const withStyle = entries.map((entry) => {
      entry = { ...entry, parent: parentNode };
      return {
        entry,
        style: resolveEntryStyle(entry),
      };
    });

    withStyle.sort((a, b) => {
      if (a.style.groupFirst !== b.style.groupFirst) {
        return a.style.groupFirst ? -1 : 1;
      }
      if (a.style.sortPriority !== b.style.sortPriority) {
        return b.style.sortPriority - a.style.sortPriority;
      }
      return a.entry.name.localeCompare(b.entry.name);
    });

    return withStyle;
  }, [entries, currentPath]);

  // Prepend ".." unless at root
  const displayEntries = useMemo(() => {
    const result: {
      entry: FsNode;
      style: { color?: string; opacity?: number; icon: string | null };
    }[] = [];
    if (parentNode) {
      const expandedParentNode = { ...parentNode, stateFlags: 1 };
      const parentStyle = resolveEntryStyle(expandedParentNode);
      result.push({ entry: { ...expandedParentNode, name: '..' }, style: parentStyle });
    }
    for (const item of sorted) {
      result.push(item);
    }
    return result;
  }, [sorted, parentNode]);

  // Load icons for visible entries
  const neededIcons = useMemo(() => {
    const names = new Set(['file.svg', 'folder.svg', 'folder-open.svg']);
    for (const { style } of displayEntries) {
      if (style.icon) names.add(style.icon);
    }
    return [...names];
  }, [displayEntries]);

  useEffect(() => {
    let cancelled = false;
    loadIcons(neededIcons).then(() => {
      if (!cancelled) setIconsVersion((n) => n + 1);
    });
    return () => { cancelled = true; };
  }, [neededIcons]);

  const virtualizer = useVirtualizer({
    count: displayEntries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // When path changes, select the child we came from (if navigating up), otherwise reset to 0
  useEffect(() => {
    const prevPath = prevPathRef.current;
    prevPathRef.current = currentPath;

    if (prevPath !== currentPath && prevPath.startsWith(currentPath)) {
      const remainder = prevPath.slice(currentPath.length).replace(/^\//, '');
      const childName = remainder.split('/')[0];
      if (childName) {
        const idx = displayEntries.findIndex((d) => d.entry.name === childName);
        if (idx >= 0) {
          setSelectedIndex(idx);
          return;
        }
      }
    }
    setSelectedIndex(0);
  }, [currentPath, displayEntries]);

  // Scroll selected item into view via virtualizer
  useEffect(() => {
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex, virtualizer]);

  const isRoot = currentPath === '/';

  const navigateToEntry = useCallback((entry: FsNode) => {
    if (entry.name === '..') {
      onNavigate(dirname(currentPath));
    } else if (entry.type === 'folder') {
      onNavigate(join(currentPath, entry.name));
    }
  }, [currentPath, onNavigate]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(displayEntries.length - 1, i + 1));
          break;
        case 'Home':
          e.preventDefault();
          setSelectedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setSelectedIndex(displayEntries.length - 1);
          break;
        case 'PageUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 20));
          break;
        case 'PageDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(displayEntries.length - 1, i + 20));
          break;
        case 'Enter': {
          e.preventDefault();
          const item = displayEntries[selectedIndex];
          if (item) navigateToEntry(item.entry);
          break;
        }
        case 'Backspace':
          e.preventDefault();
          if (!isRoot) {
            onNavigate(dirname(currentPath));
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPath, displayEntries, selectedIndex, isRoot, onNavigate, navigateToEntry]);

  return (
    <div className="file-list">
      <div className="path-bar">{currentPath}</div>
      <div className="entries" ref={scrollRef}>
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const { entry, style } = displayEntries[virtualRow.index];
            const isSelected = virtualRow.index === selectedIndex;
            return (
              <div
                key={entry.name}
                className={`entry ${isSelected ? 'selected' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${virtualRow.start}px)`,
                  opacity: style.opacity,
                }}
                onClick={() => setSelectedIndex(virtualRow.index)}
                onDoubleClick={() => navigateToEntry(entry)}
              >
                <span className="entry-icon">
                  <img src={getIconUrl(style.icon, entry.type === 'folder')} width={16} height={16} alt="" />
                </span>
                <span className="entry-name" style={style.color ? { color: style.color } : undefined}>
                  {entry.name}
                </span>
                {'size' in entry.meta && entry.type === 'file' && <span className="entry-size">{formatSize(entry.meta.size)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
