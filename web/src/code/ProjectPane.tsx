import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, ChevronsDownUp, CircleX, Command, FilePlus2, FolderOpen, FolderPlus, ListTree, PanelBottom, PanelLeft, PanelRight, RefreshCw, Search, Server, SquareTerminal, Trash2, TriangleAlert, X } from 'lucide-react';
import CodeDialog from './CodeDialog';
import ProjectEditor, { editorText, type EditorHandle } from './ProjectEditor';
import CodeMenu, { type MenuItem } from './CodeMenu';
import ProjectTree, { FileMark, menuPoint } from './ProjectTree';
import type { LanguageService } from './language';
import type { LanguageAction, LanguageActions, Location, OutlineItem, Problem } from './languageTypes';
import { checkPath, isNative, nameOf, openProjectShell, parentOf, projects, sourceFile, type Project } from '../../../packages/sdk/code-projects';
import { dirty, useProjectFiles, type Buffer } from './useProjectFiles';
import { errorMessage } from '../workspace';

import { WorkbenchLayout } from './WorkbenchLayout';
import { codeApp, useDirtyState } from './appContext';
import ProjectTerminal from './ProjectTerminal';
type Panel = 'Problems' | 'References' | 'Terminal';
type Picker = 'Quick Open' | 'Command Palette';
type View = 'Explorer' | 'Search';
/** Quick Open, as in VS Code: '>' searches actions and ':' jumps to a line. The scopes stay visible for touch. */
const scopes: { picker: Picker; label: string; shortcut: string; placeholder: string }[] = [
  { picker: 'Quick Open', label: 'Files', shortcut: '⌘P', placeholder: 'Go to file · > for actions · : for line' },
  { picker: 'Command Palette', label: 'Actions', shortcut: '⇧⌘P', placeholder: 'Type the name of an action' },
];
interface Match { path: string; line: number; column: number; before: string; match: string; after: string }
/** Finds text in the project, case-insensitively, a line at a time. */
function findText(files: Map<string, string>, query: string, limit: number) {
  const matches: Match[] = [];
  if (!query) return matches;
  const needle = query.toLowerCase();
  search: for (const [path, text] of files) {
    const lines = text.split(/\r\n?|\n/);
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const start = Math.max(0, at - 24);
      matches.push({ path, line: i + 1, column: at + 1, before: (start ? '…' : '') + lines[i].slice(start, at).trimStart(),
        match: lines[i].slice(at, at + needle.length), after: lines[i].slice(at + needle.length, at + needle.length + 160) });
      if (matches.length >= limit) break search;
    }
  }
  return matches;
}
/** Groups items by file, keeping the order files first appear in. */
function byFile<T extends { path: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.path);
    if (group) group.push(item); else groups.set(item.path, [item]);
  }
  return Array.from(groups);
}
const languageOf = (path: string) => sourceFile(path) ? /\.[cm]?tsx?$/i.test(path) ? 'TypeScript' : 'JavaScript' : /\.json$/i.test(path) ? 'JSON' : 'Plain Text';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Quotes a value for the Linux shell. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const outlineLetter: Record<string, string> = {
  class: 'c', interface: 'i', type: 't', enum: 'e', function: 'f', method: 'm', constructor: 'm', getter: 'm', setter: 'm',
  property: 'p', const: 'v', let: 'v', var: 'v', module: 'n', alias: 'v',
};
type Sizes = { explorer?: number; tools?: number; panel?: number };
const sizesKey = 'code.layout.sizes';
function savedSizes(): Sizes {
  try { return JSON.parse(localStorage.getItem(sizesKey) ?? '{}') ?? {}; } catch { return {}; }
}
interface Form {
  title: string; label: string; value: string; submit: string;
  action(value: string): Promise<void>;
}
interface Props {
  project: Project;
  target?: { path: string; serial: number };
  copied?: { path: string; serial: number };
  onHome(): void;
  report(error: unknown): void;
  register(flush: (() => Promise<boolean>) | null, refresh?: () => Promise<void>): void;
  /** Remote SSH actions, where the host app can connect (VS Code's Remote-SSH). */
  remote?: { connect(): void; openFolder(host: { id: string; name: string }): void };
}

const emptyProblems: Problem[] = [];

export default function ProjectPane({ project, target, copied, onHome, report, register, remote }: Props) {
  const files = useProjectFiles(project, report);
  const { session, entries, buffers, index } = files;
  const [tree, setTree] = useState(() => window.innerWidth >= 640);
  const [view, setView] = useState<View>('Explorer');
  const [searchText, setSearchText] = useState('');
  const [rootOpen, setRootOpen] = useState(true);
  const searchInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const shell = useRef<ReturnType<typeof openProjectShell> | null>(null);
  const [shellConnected, setShellConnected] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [tools, setTools] = useState(() => window.innerWidth >= 1024);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [input, setInput] = useState('');
  const [choice, setChoice] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [comparison, setComparison] = useState<Buffer | null>(null);
  const [confirmReload, setConfirmReload] = useState<Buffer | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [references, setReferences] = useState<Location[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [remoteMenu, setRemoteMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sizes, setSizes] = useState(savedSizes);
  const sizingChanged = useRef(false);
  const handles = useRef(new Map<string, EditorHandle>()).current;
  const cursors = useRef(new Map<string, { line: number; column: number }>()).current;
  const language = useRef<Promise<LanguageService>>(undefined);
  const mounted = useRef(true);
  const lastSnapshot = useRef<{ generation: number; promise: Promise<void> }>(undefined);
  const location = useRef<Location>(undefined);
  const live = useRef({ ...files, session });
  live.current = { ...files, session };
  const active = session.active ? buffers.get(session.active) : undefined;
  /** Diagnostics run once the project has JavaScript or TypeScript. */
  const sources = entries.filter(entry => !entry.directory && sourceFile(entry.path)).length + session.tabs.filter(sourceFile).length;
  /** Linux and SSH projects have a real shell in the bottom panel. */
  const hasTerminal = isNative && Boolean(project.ssh || project.linux);
  /** An SSH project's id starts with its saved connection; `host` names it. */
  const host = project.host ?? 'SSH';
  const hostLocation = { id: project.id.split('/')[0], name: host };

  useEffect(() => {
    register(() => live.current.flush(), () => live.current.refresh(true));
    return () => register(null);
  }, [register]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void shell.current?.close().catch(() => {});
      shell.current = null;
      void language.current?.then(service => service.dispose(), () => {});
      language.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (files.ready && target?.path) void files.open(target.path);
  }, [target?.serial, files.ready]);
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 639px)');
    const wide = window.matchMedia('(min-width: 1024px)');
    const change = (event: MediaQueryListEvent) => setTree(!event.matches);
    const toolsChange = (event: MediaQueryListEvent) => setTools(event.matches);
    compact.addEventListener('change', change);
    wide.addEventListener('change', toolsChange);
    return () => { compact.removeEventListener('change', change); wide.removeEventListener('change', toolsChange); };
  }, []);
  useEffect(() => {
    if (files.ready && copied?.path) { void files.refresh(true); void files.open(copied.path); }
  }, [copied?.serial, files.ready]);
  useEffect(() => {
    if (!session.active) return;
    setCursor(cursors.get(session.active) ?? { line: 1, column: 1 });
    if (location.current?.path === session.active) {
      const { line, column } = location.current;
      handles.get(session.active)?.reveal(line, column);
      location.current = undefined;
    }
  }, [session.active, files.generation]);

  // Reveal the active file in the tree.
  useEffect(() => {
    const path = session.active;
    if (!path || !path.includes('/')) return;
    setExpanded(previous => {
      const next = new Set(previous);
      for (let folder = parentOf(path); folder; folder = parentOf(folder)) next.add(folder);
      return next.size === previous.size ? previous : next;
    });
  }, [session.active]);
  // Files the terminal creates show up quickly while it is open.
  useEffect(() => {
    if (!shellConnected) return;
    const timer = window.setInterval(() => { if (!document.hidden) void files.refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [shellConnected]);
  useEffect(() => {
    let active = true;
    void codeApp.preferences.get<Sizes>(sizesKey).then(saved => {
      if (active && !sizingChanged.current && saved) setSizes(saved);
    }).catch(report);
    return () => { active = false; };
  }, [report]);
  useEffect(() => {
    if (!sizingChanged.current) return;
    const timer = window.setTimeout(() => { void codeApp.preferences.set(sizesKey, sizes).catch(report); }, 150);
    return () => window.clearTimeout(timer);
  }, [sizes, report]);

  async function query<K extends LanguageAction>(action: K, payload: LanguageActions[K][0]) {
    language.current ??= import('./language').then(({ LanguageService }) => new LanguageService());
    const service = await language.current;
    if (!mounted.current) throw new Error('The project was closed.');
    if (lastSnapshot.current?.generation !== live.current.generation) {
      const snapshot = Object.create(null) as Record<string, string>;
      for (const [path, file] of index) if (sourceFile(path) || path === 'tsconfig.json') snapshot[path] = editorText(file.text);
      for (const [path, buffer] of buffers) if (sourceFile(path) || path === 'tsconfig.json') snapshot[path] = buffer.text;
      const promise = service.request('sync', { files: snapshot });
      lastSnapshot.current = { generation: live.current.generation, promise };
    }
    await lastSnapshot.current.promise;
    return service.request(action, payload);
  }

  useEffect(() => {
    if (!files.ready || files.indexing || !sources) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void query('problems', {}).then(result => { if (current) setProblems(result); })
        .catch(error => { if (current) report(error); });
    }, 280);
    return () => { current = false; window.clearTimeout(timer); };
  }, [files.generation, files.ready, files.indexing, sources]);

  const outlinePath = tools && active && sourceFile(active.path) ? active.path : null;
  useEffect(() => {
    if (!outlinePath || !files.ready) { setOutline([]); return; }
    let current = true;
    const timer = window.setTimeout(() => {
      void query('outline', { path: outlinePath }).then(result => { if (current) setOutline(result); }).catch(() => { if (current) setOutline([]); });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [outlinePath, files.generation, files.ready]);

  /** Shows a side bar view, or hides the side bar when its view is already showing. */
  function showView(next: View, toggle = false) {
    if (toggle && tree && view === next) { setTree(false); return; }
    setView(next);
    setTree(true);
    if (next === 'Search') requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
  }
  const openFile = (path: string) => {
    if (window.innerWidth < 640) setTree(false);
    void files.open(path);
  };
  function reveal(at: Location) {
    if (window.innerWidth < 640) { setTree(false); setPanel(null); }
    if (live.current.session.active === at.path && handles.has(at.path)) {
      handles.get(at.path)?.reveal(at.line, at.column);
    } else {
      location.current = at;
      void files.open(at.path).then(buffer => { if (!buffer && location.current === at) location.current = undefined; });
    }
  }

  async function symbol(action: 'definition' | 'references' | 'rename', position?: number) {
    if (!active || !sourceFile(active.path)) return;
    if (files.indexing) { report('Wait for Code to finish indexing the project.'); return; }
    const path = active.path;
    const offset = position ?? handles.get(path)?.position() ?? 0;
    try {
      if (action === 'rename') {
        const { edits, message } = await query('rename', { path, position: offset });
        if (!edits.length) { report(message ?? 'No project symbol found at the cursor.'); return; }
        const originals = new Map<string, string>();
        for (const edit of edits) originals.set(edit.path, buffers.get(edit.path)?.text ?? editorText(index.get(edit.path)?.text ?? ''));
        const current = active.text.slice(0, offset).match(/[\p{L}\p{N}_$]+$/u)?.[0] ?? '';
        const following = active.text.slice(offset).match(/^[\p{L}\p{N}_$]+/u)?.[0] ?? '';
        showForm({
          title: 'Rename Symbol', label: `New name · ${edits.length} occurrence${edits.length === 1 ? '' : 's'} in ${originals.size} file${originals.size === 1 ? '' : 's'}`,
          value: current + following, submit: 'Rename',
          action: async name => {
            if (!/^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u.test(name)) throw new Error('Enter a valid JavaScript identifier.');
            const changed = await Promise.all(Array.from(originals, async ([file, original]) => {
              const buffer = await files.open(file, false);
              if (!buffer || buffer.text !== original || buffer.disk !== undefined) throw new Error(`${file} changed. Try Rename Symbol again.`);
              const locations = edits.filter(edit => edit.path === file).sort((a, b) => b.start - a.start);
              const text = locations.reduce((value, item) =>
                value.slice(0, item.start) + (item.prefix ?? '') + name + (item.suffix ?? '') + value.slice(item.start + item.length), original);
              return { buffer, original, text };
            }));
            if (changed.some(({ buffer, original }) => buffer.text !== original || buffer.disk !== undefined)) throw new Error('A file changed. Try Rename Symbol again.');
            for (const { buffer, text } of changed) {
              const handle = handles.get(buffer.path);
              if (handle) handle.replace(text);
              else files.change(buffer, text);
            }
          },
        });
      } else {
        const matches = await query(action, { path, position: offset });
        if (!matches.length) { report('No project location found for this symbol.'); return; }
        if (action === 'definition' && matches.length === 1) reveal(matches[0]);
        else { setReferences(matches); setPanel('References'); }
      }
    } catch (error) { report(error); }
  }

  /** The panel opens on the terminal where there is one, as in VS Code. */
  function togglePanel() {
    if (panel) setPanel(null);
    else if (hasTerminal) openTerminal();
    else setPanel('Problems');
  }
  function openTerminal() {
    shell.current ??= openProjectShell(project);
    setShellConnected(true);
    setPanel('Terminal');
  }
  /** Types a command into the project's shell and shows it. */
  function runInTerminal(commandLine: string) {
    openTerminal();
    void shell.current!.input(commandLine + '\r').catch(report);
  }

  function showPicker(mode: Picker) { setInput(''); setChoice(0); setPicker(mode); }
  function showForm(value: Form) { setFormError(''); setForm(value); }
  function newEntry(folder: boolean, base?: string) {
    const selectedEntry = entries.find(item => item.path === selected);
    const parent = base ?? (selectedEntry?.directory ? selectedEntry.path : parentOf(selected ?? ''));
    showForm({
      title: folder ? 'New Folder' : 'New File', label: 'Project-relative path',
      value: parent ? parent + '/' : '', submit: 'Create', action: async path => {
        path = checkPath(path);
        if (folder) await projects.mkdir(project, path);
        else {
          await projects.write(project, path, '', null);
          openFile(path);
        }
        await files.refresh();
      },
    });
  }
  function moveEntry(target?: string) {
    const path = target ?? (selected || session.active);
    if (!path) return;
    showForm({ title: 'Rename or Move', label: 'New project-relative path', value: path, submit: 'Move',
      action: destination => files.move(path, checkPath(destination)).then(() => { setSelected(destination); }) });
  }
  async function deleteEntry(path: string) {
    try {
      await files.remove(path);
      if (selected === path || selected?.startsWith(path + '/')) setSelected(null);
    } catch (error) { report(error); }
  }
  /** The actions for a tree row. The empty path is the project folder. */
  function entryMenu(path: string) {
    const item = entries.find(value => value.path === path);
    const folder = !path || item?.directory;
    const actions: MenuItem[] = [];
    if (!folder) actions.push({ label: 'Open', action: () => openFile(path) });
    if (folder) actions.push({ label: 'New File…', action: () => newEntry(false, path) },
      { label: 'New Folder…', action: () => newEntry(true, path) });
    if (path) actions.push({ label: 'Rename or Move…', action: () => moveEntry(path) });
    if (hasTerminal && project.linux && folder) actions.push({ label: 'Open in Terminal',
      action: () => runInTerminal(`cd ${shellQuote(path ? `${project.linux}/${path}` : project.linux!)}`) });
    if (!path) actions.push({ label: 'Collapse All', separator: true, action: () => setExpanded(new Set()) },
      { label: 'Refresh', action: () => void files.refresh(true) });
    if (path) actions.push({ label: 'Delete…', destructive: true, separator: true, action: () => setConfirmDelete(path) });
    return actions;
  }
  const deleteNote = (path: string) => `${entries.find(item => item.path === path)?.directory ? 'This folder and everything in it' : 'This file'} ${
    project.id.startsWith('home') ? 'will move to the Trash.' : 'will be deleted. You can’t undo this.'}`;

  function saveCopy(buffer: Buffer) {
    const name = nameOf(buffer.path);
    const extension = name.lastIndexOf('.');
    const copy = extension > 0 ? name.slice(0, extension) + '.copy' + name.slice(extension) : name + '.copy';
    showForm({ title: 'Save a Copy', label: 'Project-relative path', value: [parentOf(buffer.path), copy].filter(Boolean).join('/'), submit: 'Save Copy',
      action: async path => {
        await projects.write(project, checkPath(path), buffer.text, null);
        files.acceptDisk(buffer);
        await files.refresh();
        await files.open(path);
      } });
  }

  const remoteItems: MenuItem[] = [
    ...(remote ? [{ label: `Open Folder on ${host}…`, action: () => remote.openFolder(hostLocation) }] : []),
    ...(hasTerminal ? [{ label: 'Open Terminal', action: openTerminal }] : []),
    ...(remote ? [{ label: 'Connect to Another Host…', separator: true, action: remote.connect }] : []),
    { label: 'Close Remote Connection', separator: !remote, action: onHome },
  ];
  const commands = [
    { label: 'Go to File', shortcut: '⌘P', action: () => showPicker('Quick Open') },
    { label: 'Search in Project', shortcut: '⇧⌘F', action: () => showView('Search') },
    { label: 'Show Explorer', shortcut: '⇧⌘E', action: () => showView('Explorer') },
    { label: 'Go to Line', action: () => { showPicker('Quick Open'); setInput(':'); } },
    { label: 'New File', action: () => newEntry(false) },
    { label: 'New Folder', action: () => newEntry(true) },
    { label: 'Rename or Move File', action: () => moveEntry() },
    { label: 'Delete File…', action: () => { const path = selected || session.active; if (path) setConfirmDelete(path); } },
    { label: 'Go to Definition', shortcut: 'F12', action: () => void symbol('definition') },
    { label: 'Find References', shortcut: '⇧F12', action: () => void symbol('references') },
    { label: 'Rename Symbol', shortcut: 'F2', action: () => void symbol('rename') },
    { label: 'Save All', shortcut: '⌘S', action: () => void files.flush() },
    { label: 'Show Problems', action: () => setPanel('Problems') },
    ...(hasTerminal ? [{ label: 'Open Terminal', shortcut: '⌃`', action: openTerminal }] : []),
    { label: 'Toggle Primary Side Bar', shortcut: '⌘B', action: () => setTree(value => !value) },
    { label: 'Toggle Panel', shortcut: '⌘J', action: togglePanel },
    { label: 'Toggle Structure', shortcut: '⌥⌘B', action: () => setTools(value => !value) },
    { label: 'Refresh Project', action: () => void files.refresh(true) },
    ...(remote ? [{ label: 'Remote-SSH: Connect to Host…', action: remote.connect }] : []),
    ...(remote && project.ssh ? [{ label: `Remote-SSH: Open Folder on ${host}…`, action: () => remote.openFolder(hostLocation) }] : []),
    ...(project.ssh ? [{ label: 'Remote-SSH: Close Remote Connection', action: onHome }] : []),
    { label: 'Projects', action: onHome },
  ];
  const keyAction = useRef<(event: KeyboardEvent) => void>(() => {});
  keyAction.current = event => {
    if (form || picker || comparison || confirmReload || menu || remoteMenu) return;
    // xterm sends Ctrl-letter chords to the PTY, including Ctrl-J for a newline.
    const inTerminal = event.target instanceof Element && event.target.closest('.code-terminal') !== null;
    const modifier = event.metaKey || (event.ctrlKey && !inTerminal);
    const key = event.key.toLowerCase();
    let action: (() => void) | undefined;
    if (modifier && (key === 'p' || key === 'k')) action = () => showPicker(event.shiftKey ? 'Command Palette' : 'Quick Open');
    else if (modifier && event.shiftKey && key === 'f') action = () => showView('Search');
    else if (modifier && event.shiftKey && key === 'e') action = () => showView('Explorer');
    else if (modifier && event.altKey && event.code === 'KeyB') action = () => setTools(value => !value);
    else if (modifier && !event.shiftKey && key === 'b') action = () => setTree(value => !value);
    else if (modifier && !event.shiftKey && key === 'j') action = togglePanel;
    else if (event.ctrlKey && event.key === '`' && hasTerminal) action = () => panel === 'Terminal' ? setPanel(null) : openTerminal();
    else if (key === 'f12') action = () => void symbol(event.shiftKey ? 'references' : 'definition');
    else if (key === 'f2') action = () => void symbol('rename');
    if (action) { event.preventDefault(); event.stopImmediatePropagation(); action(); }
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => keyAction.current(event);
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, []);

  // One Go to popup. In the file scope, '>' searches actions and ':' jumps to a line.
  const prefix = picker === 'Quick Open' ? input.match(/^\s*([>:])/)?.[1] : undefined;
  const mode: Picker | 'Line' = prefix === '>' ? 'Command Palette' : prefix === ':' ? 'Line' : picker ?? 'Quick Open';
  const queryText = (prefix ? input.trim().slice(1) : input).trim().toLowerCase();
  let choices: { label: string; detail?: string; path?: string; action(): void }[] = [];
  if (mode === 'Quick Open') {
    const rank = (path: string) => {
      const lower = path.toLowerCase();
      if (nameOf(lower).startsWith(queryText)) return nameOf(lower).length - queryText.length;
      if (lower.includes(queryText)) return 100 + lower.indexOf(queryText);
      let position = 0;
      for (const ch of queryText) {
        position = lower.indexOf(ch, position);
        if (position < 0) return Infinity;
        position++;
      }
      return position + 1000;
    };
    choices = entries.filter(item => !item.directory).map(item => ({ ...item, rank: rank(item.path) }))
      .filter(item => Number.isFinite(item.rank)).sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path)).slice(0, 150)
      .map(item => ({ label: nameOf(item.path), detail: parentOf(item.path), path: item.path, action: () => openFile(item.path) }));
  } else if (mode === 'Command Palette') {
    choices = commands.filter(item => item.label.toLowerCase().includes(queryText)).map(item => ({ ...item, detail: item.shortcut }));
  } else if (mode === 'Line') {
    const [line, column] = queryText.split(/[:,]/).map(Number);
    if (active && line > 0) choices = [{ label: `Go to line ${line}${column > 0 ? `, column ${column}` : ''}`, detail: nameOf(active.path),
      action: () => reveal({ path: active.path, line, column: column > 0 ? column : 1 }) }];
  }
  const searching = tree && view === 'Search' && searchText.trim() !== '';
  // The file maps change in place; the generation counts their changes.
  const found = useMemo(() => {
    if (!searching) return [];
    const snapshot = new Map(Array.from(index, ([path, file]) => [path, file.text]));
    for (const buffer of buffers.values()) snapshot.set(buffer.path, buffer.text);
    return findText(snapshot, searchText.trim(), 500);
  }, [searching, searchText, files.generation]);
  const choose = (index: number) => { const item = choices[index]; if (item) { setPicker(null); item.action(); } };
  const emptyChoices = mode === 'Line' ? (active ? 'Type a line number.' : 'Open a file first.')
    : files.indexing ? 'Indexing project…' : 'Nothing found.';
  const errorCount = problems.filter(item => item.severity === 'error').length;
  const warningCount = problems.length - errorCount;
  const fileProblems = active ? problems.filter(item => item.path === active.path) : emptyProblems;
  const unresolved = Array.from(buffers.values()).find(item => item.disk !== undefined || item.error);
  const unsaved = Array.from(buffers.values()).some(dirty);
  useDirtyState(unsaved || Boolean(files.saving));
  const status = files.saving ? 'Saving…' : unresolved ? 'Save needs attention' :
    unsaved ? 'Unsaved changes' : 'Saved';
  const panels: Panel[] = ['Problems', ...(hasTerminal ? ['Terminal' as const] : []), ...(references.length ? ['References' as const] : [])];
  const button = (label: string, icon: React.ReactNode, action: () => void, disabled = false) =>
    <button type="button" className="code-icon" title={label} aria-label={label} disabled={disabled} onClick={action}>{icon}</button>;
  const editors = <div className="code-buffer-area">
            {!active && <div className="code-editor-empty">
              {files.ready ? <dl className="code-shortcuts">
                {([['Go to File', '⌘P', () => showPicker('Quick Open')], ['Search in Project', '⇧⌘F', () => showView('Search')],
                  ['Actions', '⇧⌘P', () => showPicker('Command Palette')],
                  ...(hasTerminal ? [['Terminal', '⌃`', openTerminal]] : [])] as [string, string, () => void][]).map(([label, keys, action]) =>
                  <button key={label} onClick={action}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></button>)}
              </dl> : <h2>Opening project…</h2>}
            </div>}
            {session.tabs.map(path => {
              const buffer = buffers.get(path);
              if (!buffer) return null;
              return <div className="code-buffer" hidden={path !== session.active} role="tabpanel" key={path}>
                <ProjectEditor path={path} text={buffer.text} problems={path === session.active ? fileProblems : emptyProblems}
                  onChange={text => files.change(buffer, text)}
                  register={handle => { if (handle) handles.set(path, handle); else handles.delete(path); }}
                  onCursor={(line, column) => { const value = { line, column }; cursors.set(path, value); if (live.current.session.active === path) setCursor(value); }}
                  query={query} goToDefinition={position => void symbol('definition', position)} />
              </div>;
            })}
          </div>;
  async function submitForm() {
    if (!form || formBusy) return;
    setFormBusy(true); setFormError('');
    try { await form.action(form.value.trim()); setForm(null); }
    catch (error) { setFormError(errorMessage(error)); }
    finally { setFormBusy(false); }
  }
  const toggleFolder = (path: string) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const scope = scopes.find(item => item.picker === picker);
  /** Drags the edge of a panel. `sign` is +1 when dragging right or down grows it. */
  const splitter = (key: keyof Sizes, axis: 'x' | 'y', sign: 1 | -1, measure: () => number | undefined) =>
    <div className={`code-splitter ${axis} ${key}`} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={`Resize ${key}`}
      onDoubleClick={() => { sizingChanged.current = true; setSizes(({ [key]: _, ...rest }) => rest); }}
      onPointerDown={event => {
        sizingChanged.current = true;
        const start = axis === 'x' ? event.clientX : event.clientY;
        const initial = sizes[key] ?? measure() ?? 240;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => {
          const delta = ((axis === 'x' ? next.clientX : next.clientY) - start) * sign;
          setSizes(previous => ({ ...previous, [key]: Math.round(Math.min(Math.max(initial + delta, key === 'panel' ? 72 : 170), key === 'panel' ? window.innerHeight - 220 : window.innerWidth * 0.45)) }));
        };
        const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
      }} />;
  const sizeStyle = {
    ...(sizes.explorer ? { '--code-explorer-width': `${sizes.explorer}px` } : {}),
    ...(sizes.tools ? { '--code-tools-width': `${sizes.tools}px` } : {}),
    ...(sizes.panel ? { '--code-panel-height': `${sizes.panel}px` } : {}),
  } as React.CSSProperties;
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeRemoteMenu = useCallback(() => setRemoteMenu(null), []);
  const severity = (level: Problem['severity']) => level === 'error'
    ? <CircleX size={13} className="error" aria-label="Error" /> : <TriangleAlert size={13} className="warning" aria-label="Warning" />;
  /** A file heading in grouped results, as in VS Code's Problems and Search views. */
  const fileHeading = (path: string, count: number) => <div className="code-result-file" title={path}>
    <FileMark path={path} /><span>{nameOf(path)}</span><small>{parentOf(path)}</small><span className="code-count">{count}</span>
  </div>;
  const explorerView = <>
    <button type="button" className={`code-project-root ${selected === '' ? 'selected' : ''}`} title={project.name} aria-expanded={rootOpen}
      onClick={() => { setSelected(''); setRootOpen(!rootOpen); }}
      onContextMenu={event => { event.preventDefault(); setSelected(''); setMenu({ path: '', ...menuPoint(event) }); }}>
      <ChevronRight size={13} className={`code-tree-chevron ${rootOpen ? 'open' : ''}`} aria-hidden="true" />
      {project.ssh ? <Server size={14} className="code-folder-icon" /> : <FolderOpen size={14} className="code-folder-icon" />}<span>{project.name}</span></button>
    {rootOpen && files.ready && <ProjectTree entries={entries} active={session.active} selected={selected} expanded={expanded} onToggle={toggleFolder}
      onSelect={setSelected} onOpen={openFile} onMenu={(path, at) => { setSelected(path); setMenu({ path, ...at }); }} />}
    {rootOpen && files.ready && !entries.length && <p className="code-panel-empty">{files.indexing ? 'Loading files…' : 'This folder is empty.'}</p>}
  </>;
  const searchGroups = byFile(found);
  const searchView = <>
    <div className="code-search-field">
      <Search size={14} aria-hidden="true" />
      <input ref={searchInput} type="search" aria-label="Search" placeholder="Search in project" value={searchText}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={event => setSearchText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && found[0]) reveal(found[0]); }} />
      {searchText && button('Clear Search', <X size={13} />, () => { setSearchText(''); searchInput.current?.focus(); })}
    </div>
    {searching && <p className="code-search-summary" role="status">{found.length
      ? `${found.length >= 500 ? '500+' : found.length} result${found.length === 1 ? '' : 's'} in ${plural(searchGroups.length, 'file')}` : files.indexing ? 'Indexing project…' : 'No results found.'}</p>}
    <div className="code-results" aria-label="Search results">
      {searchGroups.map(([path, matches]) => <div key={path}>
        {fileHeading(path, matches.length)}
        {matches.map(item => <button key={`${item.line}:${item.column}`} type="button" className="code-result-line"
          aria-label={`${item.before}${item.match}${item.after} ${item.path}:${item.line}`} onClick={() => reveal(item)}>
          <span>{item.before}<mark>{item.match}</mark>{item.after}</span><small>{item.line}</small></button>)}
      </div>)}
    </div>
  </>;
  const problemGroups = byFile(problems);
  const fileErrors = fileProblems.filter(item => item.severity === 'error').length;
  const fileWarnings = fileProblems.length - fileErrors;
  const inspection = fileProblems.length ? [fileErrors && plural(fileErrors, 'error'), fileWarnings && plural(fileWarnings, 'warning')].filter(Boolean).join(', ') : 'No problems';
  return <WorkbenchLayout style={sizeStyle} tree={tree} tools={tools} panel={Boolean(panel)} terminal={hasTerminal}
    commands={{
      project: { onClick: onHome, content: <>
        <span className={`code-switcher-mark ${project.ssh ? 'remote' : ''}`} aria-hidden="true">{project.ssh ? <Server size={12} /> : project.name.slice(0, 1).toUpperCase()}</span>
        <span className="code-project-name">{project.name}</span>
        {project.ssh && <span className="code-switcher-host">{host}</span>}<ChevronDown size={13} /></> },
      tree: { content: <PanelLeft size={16} />, pressed: tree, onClick: () => setTree(!tree) },
      panel: { content: <PanelBottom size={16} />, pressed: !!panel, onClick: togglePanel },
      tools: { content: <PanelRight size={16} />, pressed: tools, onClick: () => setTools(!tools) },
      search: { content: <><Search size={14} /><span>Go to file</span><kbd>⌘P</kbd></>, onClick: () => showPicker('Quick Open') },
      terminal: { content: <SquareTerminal size={16} />, pressed: panel === 'Terminal', onClick: () => panel === 'Terminal' ? setPanel(null) : openTerminal() },
      actions: { content: <Command size={16} />, onClick: () => showPicker('Command Palette') },
    }}
    explorer={<aside className="code-explorer island" aria-label={view}>
        <div className="code-explorer-header">
          <div className="code-island-tabs" role="tablist" aria-label="Side panel">
            {(['Explorer', 'Search'] as View[]).map(name => <button key={name} role="tab" aria-selected={view === name} className="code-island-tab"
              title={name === 'Explorer' ? 'Files (⇧⌘E)' : 'Search (⇧⌘F)'} onClick={() => showView(name)}>{name === 'Explorer' ? 'Files' : 'Search'}</button>)}
          </div>
          <span className="code-toolbar-fill" />
          {view === 'Explorer' && <>
            {button('New File', <FilePlus2 size={15} />, () => newEntry(false))}
            {button('New Folder', <FolderPlus size={15} />, () => newEntry(true))}
            {button('Collapse All', <ChevronsDownUp size={14} />, () => setExpanded(new Set()), !expanded.size)}
            {button('Refresh Project', <RefreshCw size={13} />, () => void files.refresh(true))}
          </>}
        </div>
        {view === 'Explorer' ? explorerView : searchView}
      </aside>}
    explorerDivider={splitter('explorer', 'x', 1, () => document.querySelector<HTMLElement>('.code-explorer')?.offsetWidth)}
    editor={<main className="code-editor-area island">
          {session.tabs.length > 0 && <div className="code-tabs" role="tablist" aria-label="Open editors">
            {session.tabs.map(path => {
              const buffer = buffers.get(path)!;
              return <div key={path} className={`code-tab ${session.active === path ? 'active' : ''} ${buffer && dirty(buffer) ? 'dirty' : ''}`}>
                <button role="tab" aria-selected={session.active === path} title={path} onClick={() => openFile(path)}
                  onAuxClick={event => { if (event.button === 1) void files.close(path); }}>
                  <FileMark path={path} /><span>{nameOf(path)}</span>
                </button>
                {buffer && dirty(buffer) && <i className="code-dirty" aria-label="Unsaved" />}
                {button(`Close ${nameOf(path)}`, <X size={13} />, () => void files.close(path))}
              </div>;
            })}
          </div>}
          {active && <div className="code-breadcrumb-bar">
            <nav className="code-breadcrumb" aria-label="File path" title={active.path}>{active.path.split('/').map((part, index, parts) =>
              <span key={index} className={index === parts.length - 1 ? 'current' : ''}>
                {index > 0 && <ChevronRight size={12} className="code-breadcrumb-separator" aria-hidden="true" />}
                {index === parts.length - 1 && <FileMark path={active.path} />}{part}</span>)}</nav>
            <span className="code-toolbar-fill" />
            <button type="button" className={`code-inspection ${fileProblems.length ? '' : 'clean'}`} aria-label={`Problems: ${inspection}`} title={inspection} onClick={() => setPanel('Problems')}>
              {fileErrors > 0 && <span className="error"><CircleX size={13} />{fileErrors}</span>}
              {fileWarnings > 0 && <span className="warning"><TriangleAlert size={12} />{fileWarnings}</span>}
              {!fileProblems.length && <Check size={14} />}
            </button>
          </div>}
          {active && active.disk !== undefined && <div className="code-conflict" role="alert">
            <AlertCircle size={14} /><span>{active.disk ? 'This file changed on disk.' : 'This file was removed or moved.'}</span>
            <button onClick={() => setComparison(active)}>Compare</button>
            <button onClick={() => setConfirmReload(active)}>Reload</button>
            <button onClick={() => saveCopy(active)}>Save a Copy</button>
          </div>}
          {active?.error && <div className="code-conflict" role="alert"><AlertCircle size={14} /><span>{active.error}</span><button onClick={() => void files.flush()}>Retry</button><button onClick={() => saveCopy(active)}>Save a Copy</button></div>}
          {editors}
        </main>}
    panelDivider={splitter('panel', 'y', -1, () => document.querySelector<HTMLElement>('.code-tool-panel')?.offsetHeight)}
    bottom={<section className="code-tool-panel island" aria-label={panel ?? undefined} hidden={!panel}>
        <div className="code-panel-header">
          <div className="code-island-tabs" role="tablist" aria-label="Panel tools">{panels.map(name =>
            <button key={name} role="tab" aria-selected={panel === name} className="code-island-tab" onClick={() => name === 'Terminal' ? openTerminal() : setPanel(name)}>
              {name === 'Terminal' ? <SquareTerminal size={13} /> : name === 'Problems' ? <AlertCircle size={13} /> : <ListTree size={13} />}
              {name === 'Terminal' && project.ssh ? `Terminal · ${host}` : name}
              {name === 'Problems' && problems.length > 0 && <span className="code-count">{problems.length}</span>}
            </button>)}
          </div>
          <span className="code-toolbar-fill" />
          {panel === 'Terminal' && button('Kill terminal', <Trash2 size={14} />, () => { void shell.current?.close().catch(report); shell.current = null; setShellConnected(false); setPanel(null); })}
          {button('Close panel', <X size={15} />, () => setPanel(null))}
        </div>
        {shell.current && <ProjectTerminal shell={shell.current} visible={panel === 'Terminal'} report={report} />}
        <div className="code-panel-content" hidden={panel === 'Terminal'}>
          {panel === 'Problems' && (problems.length ? problemGroups.map(([path, items]) => <div key={path}>
            {fileHeading(path, items.length)}
            {items.map((problem, index) => <button className="code-location" key={index} onClick={() => reveal(problem)}>
              {severity(problem.severity)}<span>{problem.message}</span><small>{problem.line}:{problem.column}</small></button>)}
          </div>) : <span className="code-panel-empty">{files.indexing ? 'Indexing project…' : 'No problems found.'}</span>)}
          {panel === 'References' && byFile(references).map(([path, items]) => <div key={path}>
            {fileHeading(path, items.length)}
            {items.map((item, index) => <button className="code-location" key={index} onClick={() => reveal(item)}>
              <span>{path}:{item.line}:{item.column}</span></button>)}
          </div>)}
        </div>
      </section>}
    toolsDivider={splitter('tools', 'x', -1, () => document.querySelector<HTMLElement>('.code-tools')?.offsetWidth)}
    structure={<aside className="code-tools island" aria-label="Structure">
        <div className="code-panel-header">
          <div className="code-island-tabs" role="tablist" aria-label="Structure"><button role="tab" aria-selected="true" className="code-island-tab"><ListTree size={13} />Structure</button></div>
          <span className="code-toolbar-fill" />
          {button('Close structure', <X size={15} />, () => setTools(false))}
        </div>
        <div className="code-tree code-outline" aria-label="File structure">
          {!active ? <p className="code-panel-empty">Open a file to see its structure.</p>
            : !sourceFile(active.path) ? <p className="code-panel-empty">Structure is available for JavaScript and TypeScript files.</p>
            : !outline.length ? <p className="code-panel-empty">{files.indexing ? 'Indexing…' : 'No declarations in this file.'}</p>
            : outline.map((item, i) => <button key={`${i}:${item.name}`} type="button" title={`${item.kind} ${item.name}`}
              className={item.line <= cursor.line && (outline[i + 1]?.line ?? Infinity) > cursor.line ? 'selected' : ''} onClick={() => reveal(item)}>
              {Array.from({ length: item.depth }, (_, depth) => <span key={depth} className="code-indent" aria-hidden="true" />)}
              <span className={`code-outline-kind ${outlineLetter[item.kind] ?? 'other'}`} aria-hidden="true">{(outlineLetter[item.kind] ?? '•').toUpperCase()}</span>
              <span className="code-tree-label">{item.name}</span><small>{item.line}</small></button>)}
        </div>
      </aside>}
    status={<footer className="code-statusbar">
      {project.ssh && <button className="code-remote" aria-label={`Remote: ${host}`} title="Remote connection"
        onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setRemoteMenu({ x: box.left, y: box.top }); }}>
        <Server size={12} />SSH · {host}</button>}
      <span className={`code-save-state ${unresolved ? 'warn' : ''}`}>{unresolved ? <button className="warn" onClick={() => openFile(unresolved.path)}>{status}</button> : status}</span>
      <span className="code-toolbar-fill" />
      <button aria-pressed={panel === 'Problems'} aria-label={`${plural(errorCount, 'error')}${warningCount ? ` · ${plural(warningCount, 'warning')}` : ''}`}
        className={errorCount ? 'error' : ''} onClick={() => setPanel(panel === 'Problems' ? null : 'Problems')}>
        <CircleX size={12} />{errorCount}<TriangleAlert size={12} />{warningCount}</button>
      {active && <><span>Ln {cursor.line}, Col {cursor.column}</span><span>{languageOf(active.path)}</span></>}
    </footer>}>
    {picker && scope && <CodeDialog title={picker} popup close={() => setPicker(null)}>
      <div className="code-goto-scopes" role="tablist" aria-label="Go to">
        {scopes.map(item => <button key={item.picker} role="tab" aria-selected={item.picker === picker}
          onClick={() => { setPicker(item.picker); setChoice(0); }}>{item.label}<kbd>{item.shortcut}</kbd></button>)}
      </div>
      <div className="code-goto-field">
        {mode === 'Command Palette' ? <Command size={15} /> : <Search size={15} />}
        <input className="code-input" aria-label={picker} placeholder={scope.placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          value={input} onChange={event => { setInput(event.target.value); setChoice(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.max(0, Math.min(choices.length - 1, choice + (event.key === 'ArrowDown' ? 1 : -1)));
              setChoice(next); document.getElementById(`code-choice-${next}`)?.scrollIntoView({ block: 'nearest' });
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              const at = scopes.findIndex(item => item.picker === picker);
              setPicker(scopes[(at + (event.shiftKey ? scopes.length - 1 : 1)) % scopes.length].picker); setChoice(0);
            }
            if (event.key === 'Enter') { event.preventDefault(); choose(choice); }
          }} />
      </div>
      <div className="code-picker-results">
        {choices.map((item, index) => <button key={index} id={`code-choice-${index}`} className={index === choice ? 'selected' : ''} onClick={() => choose(index)} onPointerMove={() => setChoice(index)}>
          {item.path ? <FileMark path={item.path} /> : mode === 'Command Palette' ? <Command size={13} /> : <span className="code-tree-spacer" />}
          <span>{item.label}</span><small>{item.detail}</small></button>)}
        {!choices.length && <p>{emptyChoices}</p>}
      </div>
    </CodeDialog>}
    {remoteMenu && <CodeMenu label={`Remote: ${host}`} x={remoteMenu.x} y={remoteMenu.y} items={remoteItems} close={closeRemoteMenu} />}
    {menu && <CodeMenu label={menu.path ? nameOf(menu.path) : project.name} x={menu.x} y={menu.y} items={entryMenu(menu.path)} close={closeMenu} />}
    {confirmDelete && <CodeDialog title={`Delete ${nameOf(confirmDelete)}?`} close={() => setConfirmDelete(null)}>
      <p>{deleteNote(confirmDelete)}</p>
      <div className="code-dialog-actions"><button className="code-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
        <button className="code-primary code-danger" onClick={() => { const path = confirmDelete; setConfirmDelete(null); void deleteEntry(path); }}>Delete</button></div>
    </CodeDialog>}
    {form && <CodeDialog title={form.title} close={() => { if (!formBusy) setForm(null); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        await submitForm();
      }}>
        <label className="code-field">{form.label}<input className="code-input" value={form.value} onChange={event => setForm({ ...form, value: event.target.value })} required /></label>
        {formError && <p role="alert" className="code-error">{formError}</p>}
        <div className="code-dialog-actions"><button className="code-secondary" type="button" onClick={() => setForm(null)} disabled={formBusy}>Cancel</button>
          <button className="code-primary" disabled={formBusy || !form.value.trim()}>{form.submit}</button></div>
      </form>
    </CodeDialog>}
    {comparison && <CodeDialog title={`Compare ${nameOf(comparison.path)}`} close={() => setComparison(null)}>
      <div className="code-compare"><div><strong>Your changes</strong><pre>{comparison.text}</pre></div>
        <div><strong>On disk</strong><pre>{comparison.disk?.text ?? '(File is unavailable)'}</pre></div></div>
    </CodeDialog>}
    {confirmReload && <CodeDialog title={`Reload ${nameOf(confirmReload.path)}?`} close={() => setConfirmReload(null)}>
      <p>Reloading discards the changes in this tab.</p>
      <div className="code-dialog-actions"><button className="code-secondary" onClick={() => setConfirmReload(null)}>Cancel</button>
        <button className="code-primary" onClick={() => { files.acceptDisk(confirmReload); setConfirmReload(null); }}>Reload</button></div>
    </CodeDialog>}
  </WorkbenchLayout>;
}
