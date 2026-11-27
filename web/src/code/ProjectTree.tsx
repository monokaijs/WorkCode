import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { nameOf, parentOf, type Entry } from '../../../packages/sdk/code-projects';

interface Props {
  entries: Entry[];
  active: string | null;
  onOpen(path: string): void;
  onSelect(path: string): void;
  onMenu(path: string, at: { x: number; y: number }): void;
  onToggle(path: string): void;
  expanded: Set<string>;
  selected: string | null;
}

/** The short badge Code draws for a file type, if it has one. */
export function fileMark(path: string) {
  const extension = nameOf(path).split('.').at(-1)?.toLowerCase();
  if (!extension || !/^(?:[cm]?tsx?|[cm]?jsx?|json)$/.test(extension)) return undefined;
  return extension === 'json' ? '{}' : extension.includes('ts') ? 'TS' : 'JS';
}

/** A small badge for the file type, as Fleet draws it. */
export function FileMark({ path }: { path: string }) {
  const label = fileMark(path);
  if (label) return <span aria-hidden="true" className={`code-file-mark ${label === 'TS' ? 'typed' : label === 'JS' ? 'script' : 'config'}`}>{label}</span>;
  return <File size={14} strokeWidth={1.6} className="code-file-icon" aria-hidden="true" />;
}

/** Where a context menu opens: at the pointer, or under the row for the keyboard. */
export function menuPoint(event: React.MouseEvent<HTMLElement>) {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + 24, y: box.bottom };
}

export default function ProjectTree({ entries, active, onOpen, onSelect, onMenu, onToggle: toggle, expanded, selected }: Props) {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const parent = parentOf(entry.path);
    const group = groups.get(parent);
    if (group) group.push(entry);
    else groups.set(parent, [entry]);
  }
  for (const items of groups.values()) items.sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  const guides = (depth: number) => Array.from({ length: depth }, (_, index) => <span key={index} className="code-indent" aria-hidden="true" />);
  function nodes(parent: string, depth: number) {
    return (groups.get(parent) ?? []).map(entry => {
      const { path, directory } = entry;
      const open = expanded.has(path);
      return <div key={path}>
        <button type="button" title={path} aria-expanded={directory ? open : undefined} aria-current={active === path ? 'page' : undefined}
          className={(selected === null ? active === path : selected === path) ? 'selected' : ''}
          onClick={() => { onSelect(path); if (directory) toggle(path); else onOpen(path); }}
          onContextMenu={event => { event.preventDefault(); onMenu(path, menuPoint(event)); }}>
          {guides(depth)}
          {directory ? <ChevronRight size={13} className={`code-tree-chevron ${open ? 'open' : ''}`} aria-hidden="true" /> : <span className="code-tree-spacer" />}
          {directory ? open ? <FolderOpen size={15} className="code-folder-icon" /> : <Folder size={15} className="code-folder-icon" /> : <FileMark path={path} />}
          <span className="code-tree-label">{nameOf(path)}</span>
        </button>
        {directory && open && nodes(path, depth + 1)}
      </div>;
    });
  }
  return <div className="code-tree" aria-label="Project files">{nodes('', 0)}</div>;
}
