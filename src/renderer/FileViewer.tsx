import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DirectoryHandle, FileHandle, FileSystemObserver } from './fsa';
import { basename, dirname } from './path';

const SCAN_CHUNK = 256 * 1024; // 256KB
const PAGE_SIZE = 500;
const MAX_CACHED_PAGES = 5;
const LINE_HEIGHT = 20;
const MAX_LINE_CHARS = 10_000;

interface FileViewerProps {
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
}

async function scanFile(file: File, onProgress: (p: number) => void): Promise<number[]> {
  const size = file.size;
  if (size === 0) return [0];

  const offsets = [0];
  let offset = 0;

  while (offset < size) {
    const chunkLen = Math.min(SCAN_CHUNK, size - offset);
    const buf = await file.slice(offset, offset + chunkLen).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0A) {
        offsets.push(offset + i + 1);
      }
    }
    offset += buf.byteLength;
    onProgress(Math.min(1, offset / size));
  }

  // Remove trailing empty line if file ends with \n
  if (offsets.length > 1 && offsets[offsets.length - 1] === size) {
    offsets.pop();
  }

  return offsets;
}

function isScrolledToBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < LINE_HEIGHT;
}

export function FileViewer({ filePath, fileName, fileSize, onClose }: FileViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<File | null>(null);
  const [lineOffsets, setLineOffsets] = useState<number[] | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [displayedSize, setDisplayedSize] = useState(fileSize);
  const pageCacheRef = useRef(new Map<number, string[]>());
  const loadingPagesRef = useRef(new Set<number>());
  const [loadedPages, setLoadedPages] = useState(0);
  const scanIdRef = useRef(0);
  const tailModeRef = useRef(false);

  // Open dialog on mount
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => {
      dialog.removeEventListener('close', handleClose);
    };
  }, [onClose]);

  // Focus the scroll body once scanning finishes (only on first scan)
  const initialFocusDone = useRef(false);
  useEffect(() => {
    if (lineOffsets && !initialFocusDone.current) {
      initialFocusDone.current = true;
      scrollRef.current?.focus();
    }
  }, [lineOffsets]);

  // Perform a (re)scan — refreshes the File handle, rebuilds offsets, invalidates page cache
  const doScan = useCallback(async (scanId: number) => {
    const handle = new FileHandle(filePath, basename(filePath));
    const file = await handle.getFile();
    if (scanIdRef.current !== scanId) return;
    fileRef.current = file;

    setDisplayedSize(file.size);

    // Capture scroll state before rescan
    const wasAtBottom = scrollRef.current ? isScrolledToBottom(scrollRef.current) : false;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;

    const offsets = await scanFile(file, (p) => {
      if (scanIdRef.current === scanId) setScanProgress(p);
    });
    if (scanIdRef.current !== scanId) return;

    // Invalidate page cache
    pageCacheRef.current.clear();
    loadingPagesRef.current.clear();

    tailModeRef.current = wasAtBottom;
    setLineOffsets(offsets);

    // Restore scroll position or scroll to bottom
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (wasAtBottom) {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTop = scrollTop;
      }
    });
  }, [filePath]);

  // Initial scan
  useEffect(() => {
    const scanId = ++scanIdRef.current;
    doScan(scanId);
    return () => { scanIdRef.current++; };
  }, [doScan]);

  // Watch parent directory for changes to this file
  useEffect(() => {
    const dir = dirname(filePath);
    const name = basename(filePath);
    const debounceRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

    const observer = new FileSystemObserver((records) => {
      const relevant = records.some(
        (r) => r.relativePathComponents[0] === name && (r.type === 'modified' || r.type === 'appeared'),
      );
      if (!relevant) return;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const scanId = ++scanIdRef.current;
        doScan(scanId);
      }, 150);
    });

    observer.observe(new DirectoryHandle(dir));

    return () => {
      observer.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [filePath, doScan]);

  const loadPage = useCallback(async (pageIndex: number) => {
    if (!lineOffsets || !fileRef.current) return;
    if (pageCacheRef.current.has(pageIndex) || loadingPagesRef.current.has(pageIndex)) return;

    loadingPagesRef.current.add(pageIndex);

    const startLine = pageIndex * PAGE_SIZE;
    const endLine = Math.min(startLine + PAGE_SIZE, lineOffsets.length);
    const byteStart = lineOffsets[startLine];
    const byteEnd = endLine < lineOffsets.length ? lineOffsets[endLine] : fileRef.current.size;
    const length = byteEnd - byteStart;

    if (length <= 0) {
      pageCacheRef.current.set(pageIndex, Array(endLine - startLine).fill(''));
      loadingPagesRef.current.delete(pageIndex);
      setLoadedPages((n) => n + 1);
      return;
    }

    const buf = await fileRef.current.slice(byteStart, byteStart + length).arrayBuffer();
    const text = new TextDecoder().decode(buf);
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    pageCacheRef.current.set(pageIndex, lines);
    loadingPagesRef.current.delete(pageIndex);

    // Evict distant pages if cache is too large
    if (pageCacheRef.current.size > MAX_CACHED_PAGES) {
      const keys = [...pageCacheRef.current.keys()];
      keys.sort((a, b) => Math.abs(a - pageIndex) - Math.abs(b - pageIndex));
      while (pageCacheRef.current.size > MAX_CACHED_PAGES) {
        pageCacheRef.current.delete(keys.pop()!);
      }
    }

    setLoadedPages((n) => n + 1);
  }, [lineOffsets]);

  const getLineContent = useCallback((lineIndex: number): string | null => {
    const pageIndex = Math.floor(lineIndex / PAGE_SIZE);
    const page = pageCacheRef.current.get(pageIndex);
    if (!page) {
      loadPage(pageIndex);
      return null;
    }
    const lineInPage = lineIndex - pageIndex * PAGE_SIZE;
    const content = page[lineInPage] ?? '';
    return content.length > MAX_LINE_CHARS ? content.slice(0, MAX_LINE_CHARS) : content;
  }, [loadPage]);

  const lineCount = lineOffsets?.length ?? 0;
  const gutterWidth = lineCount > 0 ? Math.max(4, String(lineCount).length) : 4;

  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  // After virtualizer updates with new line count, scroll to bottom in tail mode
  useEffect(() => {
    if (tailModeRef.current && lineCount > 0) {
      virtualizer.scrollToIndex(lineCount - 1, { align: 'end' });
      tailModeRef.current = false;
    }
  }, [lineCount, virtualizer]);

  void loadedPages;

  return (
    <dialog
      ref={dialogRef}
      className="file-viewer"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="file-viewer-header">
        <span style={{ flex: 1 }}>{fileName}</span>
        <span>{displayedSize > 0 ? formatBytes(displayedSize) : '0 B'}</span>
        {lineOffsets && <span style={{ marginLeft: 12 }}>{lineCount} lines</span>}
      </div>
      {!lineOffsets ? (
        <div className="file-viewer-scanning">
          Scanning… {Math.round(scanProgress * 100)}%
        </div>
      ) : (
        <div className="file-viewer-body" ref={scrollRef} tabIndex={0}>
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((row) => {
              const content = getLineContent(row.index);
              return (
                <div
                  key={row.index}
                  className="file-viewer-line"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: LINE_HEIGHT,
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <span
                    className="file-viewer-gutter"
                    style={{ minWidth: `${gutterWidth + 2}ch` }}
                  >
                    {row.index + 1}
                  </span>
                  <span className="file-viewer-content">
                    {content ?? ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
