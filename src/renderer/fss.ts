import { CachedResolver, FsNode, parseStylesheet } from 'fss-lang';
import type { ResolvedEntryStyle } from '../types';
// eslint-disable-next-line import/no-unresolved
import fssSource from './material-icons.fs.css?raw';

const sheet = parseStylesheet(fssSource);
const resolver = new CachedResolver(sheet, 'dark');

export { resolver };

function parseIconName(icon: string | undefined): string | null {
  if (!icon) return null;
  const match = /^url\(([^)]+)\)$/.exec(String(icon));
  return match ? match[1] : null;
}

export function resolveEntryStyle(node: FsNode): ResolvedEntryStyle {
  const style = resolver.resolveStyle(node);
  const sorting = resolver.resolveSorting(node);

  return {
    color: style.color != null ? String(style.color) : undefined,
    opacity: style.opacity != null ? Number(style.opacity) : undefined,
    icon: parseIconName(style.icon as string | undefined),
    sortPriority: typeof sorting.priority === 'number' ? sorting.priority : 0,
    groupFirst: sorting['group-first'] === true,
  };
}
