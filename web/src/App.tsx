import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, Circle, Code2, FileCode2, FileText, Files, FolderOpen, Grid2X2, HardDrive, LoaderCircle, Plus, Search, Trash2, Upload, X, AlertCircle, RefreshCw } from 'lucide-react';
import { openCode, openNativePDF, type DocumentRecord, type DocumentKind } from '../../packages/sdk';
import { bootstrap, errorCode, errorMessage, exportDocument, humanDate, noteText, store, type AppId, type CodeData, type PDFData } from './workspace';
import type { LibraryCopy, ProjectTarget } from './code/CodeWorkbench';
import { codeApp } from './code/appContext';
import type { AppFile } from '../../packages/sdk/app-context';
import type { OpenFile } from './code/AppFileEditor';
const AppFileEditor = import.meta.env.MODE === 'workos-host' ? () => null : lazy(() => import('./code/AppFileEditor'));
const CodeWorkbench = import.meta.env.MODE === 'workos-host' ? () => null : lazy(() => import('./code/CodeWorkbench'));
const LibraryFileEditor = import.meta.env.MODE === 'workos-host' ? () => null : lazy(() => import('./code/LibraryFileEditor'));
const PDFViewer = lazy(() => import('./components/PDFViewer'));
type Guard = () => Promise<boolean>;
type RegisterGuard = (guard: Guard) => () => void;
type Notice = { message: string; type: 'success' | 'error' | 'info' };
type ConfirmOptions = { title: string; message: string; confirmLabel?: string; danger?: boolean };
type Ask = (options: ConfirmOptions) => Promise<boolean>;
type Notify = (message: string, type?: Notice['type']) => void;

declare global { interface Window { workspaceFlush?: Guard; workspaceBeforeClose?: Guard; workspaceResume?: Guard; workspaceOpenDocument?: (id: string) => Promise<boolean>; workspaceOpenProject?: (id: string, path?: string) => Promise<boolean> } }
const navItems = [
  { id: 'files' as const, label: 'Files', icon: Files, subtitle: 'Everything you’re working on, in one place.' },
  { id: 'code' as const, label: 'Code', icon: Code2, subtitle: '' },
  { id: 'pdf' as const, label: 'PDF', icon: BookOpen, subtitle: 'Read, think, and keep the original.' },
];
const appForKind = (kind: DocumentKind): AppId => kind === 'pdf' ? 'pdf' : 'code';
const iconForKind = (kind: DocumentKind) => kind === 'note' ? FileText : kind === 'code' ? FileCode2 : BookOpen;
const kindName = (kind: DocumentKind) => kind === 'note' ? 'Note' : kind === 'code' ? 'Code file' : 'PDF';
const knownApp = (id: unknown): id is AppId => navItems.some(item => item.id === id);
const defaultGuard: Guard = async () => true;

class EditorBoundary extends Component<{ children: ReactNode; onRecover: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="empty-state"><AlertCircle size={30} /><h3>This editor could not open the file</h3><p>Your saved file has been kept. Return to Files to export it or try another document.</p><button className="button secondary" onClick={this.props.onRecover}>Return to Files</button></div> : this.props.children; }
}

function ConfirmationDialog({ value, finish }: { value: ConfirmOptions; finish: (choice: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; cancel.current?.focus(); return () => previous?.focus(); }, []);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) finish(false); }}><div ref={box} className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" onKeyDown={event => {
    if (event.key === 'Escape') finish(false);
    if (event.key === 'Tab') { const buttons = box.current?.querySelectorAll<HTMLButtonElement>('button'); if (buttons?.length) { if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1].focus(); } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0].focus(); } } }
  }}><div className={`dialog-icon ${value.danger ? 'danger' : ''}`}><AlertCircle size={24} /></div><h2 id="dialog-title">{value.title}</h2><p id="dialog-message">{value.message}</p><div className="dialog-actions"><button ref={cancel} className="button secondary" onClick={() => finish(false)}>Cancel</button><button className={`button ${value.danger ? 'danger-button' : 'primary'}`} onClick={() => finish(true)}>{value.confirmLabel || 'Continue'}</button></div></div></div>;
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const standalone = document.documentElement.hasAttribute('data-code-app') || location.pathname.endsWith('/code.html');
  const embedded = standalone || params.get('embedded') === '1';
  // Inside a Workspace desktop window: the window chrome supplies the title bar.
  const desktopWindow = embedded && params.get('desktop') === '1';
  const initialApp = knownApp(params.get('app')) ? params.get('app') as AppId : standalone ? 'code' : 'files';
  const [app, setApp] = useState<AppId>(initialApp), [documents, setDocuments] = useState<DocumentRecord[]>([]), [selectedId, setSelectedId] = useState<string | null>(null), [loading, setLoading] = useState(true), [fatal, setFatal] = useState(''), [search, setSearch] = useState(''), [notice, setNotice] = useState<Notice | null>(null), [operation, setOperation] = useState(false), [confirmation, setConfirmation] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const [openingFile, setOpeningFile] = useState(false);
  const [external, setExternal] = useState<OpenFile>();
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [copy, setCopy] = useState<LibraryCopy>();
  const [target, setTarget] = useState<ProjectTarget | undefined>(() => {
    const id = params.get('project');
    return id ? { id, path: params.get('path') ?? undefined, serial: 0 } : undefined;
  });
  const sequence = useRef(0);
  const rawWindowID = params.get('window') ?? '';
  const windowID = /^[a-f0-9-]{36}$/i.test(rawWindowID) ? rawWindowID : embedded ? 'phone' : 'browser';
  const workbench = app === 'code' && (!selectedId || Boolean(copy));
  const guard = useRef<Guard>(defaultGuard), fileInput = useRef<HTMLInputElement>(null), operationRef = useRef(false), bootingRef = useRef(true);
  const lastSelection = useRef<Partial<Record<AppId, string>>>({});
  const pendingView = useRef<Promise<void>>(Promise.resolve());
  const notify: Notify = useCallback((message, type = 'success') => setNotice({ message, type }), []);
  const ask: Ask = useCallback(options => new Promise<boolean>(resolve => setConfirmation({ ...options, resolve })), []);
  const registerGuard = useCallback<RegisterGuard>(fn => { guard.current = fn; return () => { if (guard.current === fn) guard.current = defaultGuard; }; }, []);
  const remember = useCallback(async (nextApp: AppId, nextId: string | null) => {
    if (nextId) lastSelection.current[nextApp] = nextId;
    const snapshot = { app: nextApp, selectedId: nextId, selections: { ...lastSelection.current } };
    pendingView.current = pendingView.current.catch(() => {}).then(() => store.setPreference('workspace.view.v1', snapshot));
    try { await pendingView.current; } catch { notify('Your documents are safe, but this view could not be remembered for next time.', 'info'); }
  }, [notify]);
  const upsert = useCallback((record: DocumentRecord) => setDocuments(previous => [record, ...previous.filter(item => item.id !== record.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))), []);
  const beginOperation = useCallback(() => { if (operationRef.current || bootingRef.current) return false; operationRef.current = true; setOperation(true); return true; }, []);
  const endOperation = useCallback(() => { operationRef.current = false; setOperation(false); }, []);
  const load = useCallback(() => {
    bootingRef.current = true; setLoading(true); setFatal('');
    void bootstrap().then(async records => {
      setDocuments(records);
      let nextApp = initialApp;
      let selected = params.get('document');
      if (!embedded && !params.has('app')) {
        const last = await store.getPreference<{ app?: string; selectedId?: string; selections?: Partial<Record<AppId, string>> }>('workspace.view.v1', {});
        if (knownApp(last.app)) nextApp = last.app;
        if (last.selections && typeof last.selections === 'object') { for (const item of navItems) { const id = last.selections[item.id]; if (typeof id === 'string' && records.some(record => record.id === id && appForKind(record.kind) === item.id)) lastSelection.current[item.id] = id; } }
        selected = last.selectedId || selected;
      }
      if (selected && records.some(item => item.id === selected)) { const doc = records.find(item => item.id === selected)!; if (nextApp !== 'files') nextApp = appForKind(doc.kind); }
      else selected = nextApp === 'code' ? null : records.find(item => appForKind(item.kind) === nextApp)?.id ?? null;
      if (selected) lastSelection.current[nextApp] = selected;
      setApp(nextApp); setSelectedId(selected); bootingRef.current = false; setLoading(false);
    }).catch(error => { setFatal(errorMessage(error)); bootingRef.current = false; setLoading(false); });
  }, [initialApp, embedded, params]);
  useEffect(load, [load]);
  const navigate = useCallback(async (next: AppId) => {
    if (!beginOperation()) { notify('Please wait for the current file operation to finish.', 'info'); return false; }
    try {
      if (!await guard.current()) { notify('Resolve the unsaved changes before leaving this document.', 'info'); return false; }
      const remembered = lastSelection.current[next];
      const nextId = next === 'code' ? null : documents.find(item => item.id === remembered && appForKind(item.kind) === next)?.id ?? documents.find(item => appForKind(item.kind) === next)?.id ?? null;
      await remember(next, nextId); setCopy(undefined); setTarget(undefined); setExternal(undefined); setApp(next); setSearch(''); setSelectedId(nextId); return true;
    } finally { endOperation(); }
  }, [documents, notify, remember, beginOperation, endOperation]);
  const openDocument = useCallback(async (id: string) => {
    if (!beginOperation()) { notify('Please wait for the current file operation to finish.', 'info'); return false; }
    let pdfId: string | null = null;
    try {
      if (!await guard.current()) { notify('Resolve the unsaved changes before opening another document.', 'info'); return false; }
      const record = await store.read(id); upsert(record);
      const next = appForKind(record.kind); await remember(next, id); setApp(next); setCopy(undefined); setTarget(undefined); setExternal(undefined); setSelectedId(id); setSearch('');
      if (record.kind === 'pdf') pdfId = id;
    } catch (error) { notify(errorMessage(error), 'error'); return false; } finally { endOperation(); }
    if (pdfId) { try { if (await openNativePDF(pdfId)) setSelectedId(null); } catch (error) { notify(errorMessage(error), 'error'); } }
    return true;
  }, [upsert, remember, notify, beginOperation, endOperation]);
  const openProject = useCallback(async (id: string, path?: string) => {
    if (!beginOperation()) return false;
    try {
      if (!await guard.current()) return false;
      await remember('code', null);
      setExternal(undefined); setApp('code'); setCopy(undefined); setSelectedId(null);
      setTarget({ id, path, serial: ++sequence.current });
      return true;
    } finally { endOperation(); }
  }, [beginOperation, endOperation, remember]);
  const openAppFile = useCallback(async (handle: AppFile) => {
    let opened = false;
    const acquired = beginOperation();
    if (acquired) setOpeningFile(true);
    try {
      if (!acquired || !await guard.current()) {
        notify('Finish the current edit before opening another file.', 'info');
        return;
      }
      const { file, version } = await codeApp.files.read(handle);
      if (file.size > 512 * 1024) throw new Error('Code supports text files up to 512 KB.');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (text.includes('\0')) throw new Error('Choose a UTF-8 text file.');
      if (standalone && import.meta.env.MODE !== 'workos-host') {
        const { isNative, projects } = await import('../../packages/sdk/code-projects');
        if (isNative) await projects.clear();
      }
      setCopy(undefined); setTarget(undefined); setSelectedId(null);
      setExternal({ handle, version, text });
      opened = true;
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally {
      if (!opened) void codeApp.files.release(handle).catch(console.error);
      if (acquired) { setOpeningFile(false); endOperation(); }
    }
  }, [beginOperation, endOperation, notify, standalone]);
  useEffect(() => {
    if (app !== 'code' || loading || fatal) return;
    const subscription = codeApp.onActivation(event => {
      const [file, ...rest] = event.files ?? [];
      if (file) void openAppFile(file);
      for (const extra of rest) void codeApp.files.release(extra).catch(console.error);
    });
    void subscription.ready.catch(error => notify(errorMessage(error), 'error'));
    return subscription.remove;
  }, [app, loading, fatal, openAppFile, notify]);
  async function pickAppFile() {
    try {
      const [file] = await codeApp.files.pickOpen({ edit: await codeApp.supports('files.write') });
      if (file) await openAppFile(file);
    } catch (error) { if (errorCode(error) !== 'E_CANCELLED') notify(errorMessage(error), 'error'); }
  }
  const refreshWorkspace = useCallback(async () => {
    if (!beginOperation()) return false;
    try {
      if (!await guard.current()) return false;
      const fresh = await store.list();
      const oldSelected = documents.find(item => item.id === selectedId), newSelected = fresh.find(item => item.id === selectedId);
      if (oldSelected && newSelected && oldSelected.revision !== newSelected.revision) setEditorEpoch(value => value + 1);
      if (selectedId && !newSelected) setSelectedId(null);
      setDocuments(fresh); window.dispatchEvent(new Event('workspace:resume')); return true;
    } catch (error) { notify(`Could not refresh your workspace: ${errorMessage(error)}`, 'error'); return false; } finally { endOperation(); }
  }, [documents, selectedId, notify, beginOperation, endOperation]);
  useEffect(() => { const beforeClose = async () => { if (!beginOperation()) return false; try { if (!await guard.current()) return false; await pendingView.current.catch(() => {}); return true; } finally { endOperation(); } }; window.workspaceFlush = beforeClose; window.workspaceBeforeClose = beforeClose; window.workspaceResume = refreshWorkspace; window.workspaceOpenDocument = openDocument; window.workspaceOpenProject = openProject; const focus = () => { void refreshWorkspace(); }; window.addEventListener('focus', focus); return () => { delete window.workspaceFlush; delete window.workspaceBeforeClose; delete window.workspaceResume; delete window.workspaceOpenDocument; delete window.workspaceOpenProject; window.removeEventListener('focus', focus); }; }, [openDocument, openProject, refreshWorkspace, beginOperation, endOperation]);
  const newCodeFile = async () => {
    if (!beginOperation()) return;
    try {
      if (!await guard.current()) return;
      const record = await store.create({ kind: 'code', title: 'untitled.js', data: { text: '', language: 'javascript' } });
      upsert(record); await remember('code', record.id); setApp('code'); setSelectedId(record.id); setSearch('');
    } catch (error) { notify(errorMessage(error), 'error'); } finally { endOperation(); }
  };
  const exportOne = async (record: DocumentRecord) => { try { await exportDocument(record); notify('Export prepared. Keep a copy somewhere safe.'); } catch (error) { notify(errorMessage(error), 'error'); } };
  const remove = async (record: DocumentRecord) => {
    if (!await ask({ title: `Delete “${record.title}”?`, message: 'This removes the file from this workspace. Export a copy first if you want to keep it.', confirmLabel: 'Delete file', danger: true })) return;
    if (!beginOperation()) return;
    try { if (!await guard.current()) return; await store.remove(record.id, record.revision); setDocuments(previous => previous.filter(item => item.id !== record.id)); if (selectedId === record.id) setSelectedId(null); notify('File deleted from this workspace.'); } catch (error) { notify(errorMessage(error), 'error'); try { setDocuments(await store.list()); } catch { /* Preserve the currently visible list when a refresh also fails. */ } } finally { endOperation(); }
  };
  const importFile = async (file: File) => {
    if (!beginOperation()) return;
    let importedPDF: string | null = null;
    try {
      if (!await guard.current()) return;
      let record: DocumentRecord;
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        if (file.size > 20 * 1024 * 1024) throw new Error('Choose a PDF smaller than 20 MB. The original file has not been changed.');
        const header = await file.slice(0, 1024).text(); if (!header.includes('%PDF-')) throw new Error('This file does not look like a PDF.');
        const assetId = await store.putAsset(new Blob([file], { type: 'application/pdf' }));
        record = await store.create({ kind: 'pdf', title: file.name.slice(0, 240), data: { assetId, fileName: file.name, size: file.size } });
      } else {
        if (file.size > 750 * 1024) throw new Error('Choose a text file smaller than 750 KB for this version of the editor.');
        const text = await file.text();
        if (text.includes('\u0000')) throw new Error('This looks like a binary file. Import a text file or a PDF.');
        if (file.name.endsWith('.workspace-note.json')) {
          const imported = JSON.parse(text);
          if (imported.format !== 'workspace-note' || imported.version !== 1 || imported.data?.format !== 'tiptap' || imported.data.content?.type !== 'doc') throw new Error('This is not a supported Workspace note export.');
          const allowed = new Set(['doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'hardBreak', 'horizontalRule']);
          const validate = (node: { type?: string; content?: unknown[] }, depth: number) => { if (!node || typeof node !== 'object' || depth > 30 || !allowed.has(node.type || '')) throw new Error('This note contains an unsupported content type.'); if (node.content !== undefined && !Array.isArray(node.content)) throw new Error('The note content is invalid.'); node.content?.forEach(child => validate(child as typeof node, depth + 1)); };
          validate(imported.data.content, 0);
          record = await store.create({ kind: 'note', title: String(imported.title || file.name).slice(0, 240), data: imported.data });
        } else record = await store.create({ kind: 'code', title: file.name.slice(0, 240), data: { text, language: /\.tsx?$/i.test(file.name) ? 'typescript' : /\.jsx?$/i.test(file.name) ? 'javascript' : 'plaintext' } });
      }
      upsert(record); await remember(appForKind(record.kind), record.id); setApp(appForKind(record.kind)); setSelectedId(record.id); notify('File imported. The original is unchanged.');
      if (record.kind === 'pdf') importedPDF = record.id;
    } catch (error) { notify(errorMessage(error), 'error'); } finally { endOperation(); }
    // Native launch asks our before-close guard. Finish the committed import
    // first, otherwise the guard correctly refuses while operationRef is set.
    if (importedPDF) { try { if (await openNativePDF(importedPDF)) setSelectedId(null); } catch (error) { notify(errorMessage(error), 'error'); } }
  };
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void guard.current(); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  const active = navItems.find(item => item.id === app)!;
  const selected = documents.find(item => item.id === selectedId);
  const windowTitle = selected && appForKind(selected.kind) === app ? selected.title : active.label;
  useEffect(() => { if (desktopWindow && !workbench) document.title = windowTitle; }, [desktopWindow, windowTitle, workbench]);
  const appDocuments = documents.filter(item => appForKind(item.kind) === app);
  const filtered = (app === 'files' ? documents : appDocuments).filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const copyCreated = async (record: DocumentRecord) => {
    upsert(record);
    if (!beginOperation()) { notify('Your changes were saved as a separate copy. Open it from Files.'); return; }
    try { await remember(appForKind(record.kind), record.id); setSelectedId(record.id); setApp(appForKind(record.kind)); notify('Your changes were saved as a separate copy.'); } finally { endOperation(); }
  };
  const requestImport = () => { if (fileInput.current) { fileInput.current.value = ''; fileInput.current.click(); } };
  const empty = <div className="empty-state"><div className="empty-icon">{app === 'pdf' ? <BookOpen size={28} /> : <Code2 size={28} />}</div><h3>{app === 'pdf' ? 'Bring something worth reading.' : 'Start with a new line.'}</h3><p>{app === 'pdf' ? 'Import a PDF up to 20 MB. Your original stays intact.' : 'Create a file or import code to make it your own.'}</p><button className="button primary" disabled={operation} onClick={() => app === 'pdf' ? requestImport() : void newCodeFile()}><Plus size={16} />{app === 'pdf' ? 'Import PDF' : 'New code file'}</button></div>;

  const projectBrowser = <CodeWorkbench openFile={() => void pickAppFile()} windowID={windowID} target={target} copy={copy} registerGuard={registerGuard}
            onCopyDone={() => { void remember('code', null); setCopy(undefined); setSelectedId(null); }}
            onCancelCopy={() => setCopy(undefined)} library={documents.filter(record => record.kind === 'code')}
            openDocument={id => void openDocument(id)} importDocument={requestImport} newDocument={() => void newCodeFile()} />;
  return <div className={`workspace-shell ${embedded ? 'embedded' : ''} ${desktopWindow ? 'desktop-window' : ''}`}>
    {!embedded && <aside className="sidebar"><a className="brand" href="#" onClick={event => { event.preventDefault(); void navigate('files'); }} aria-label="Workspace home"><span className="brand-mark"><Grid2X2 size={24} strokeWidth={1.6} /></span><span>workspace<span className="brand-period">.</span></span></a><div className="sidebar-section-title">YOUR DESK</div><nav aria-label="Apps">{navItems.map(item => { const Icon = item.icon; return <button key={item.id} aria-current={app === item.id ? 'page' : undefined} aria-label={`Open ${item.label}`} data-testid={`nav-${item.id}`} className={`nav-item ${app === item.id ? 'active' : ''}`} onClick={() => void navigate(item.id)}><Icon size={19} strokeWidth={1.65} /><span>{item.label}</span>{app === item.id && <span className="nav-active-dot" />}</button>; })}</nav><div className="sidebar-bottom"><div className="sidebar-quote">A place for<br />your next good idea.</div><div className="local-status"><span className="status-dot" /><div><strong>{store.durability === 'browser-local' ? 'Saved in this browser' : 'Saved on this device'}</strong><span>{store.durability === 'browser-local' ? 'Export important files for backup' : 'Your own little workspace'}</span></div></div><div className="sidebar-version">WORKSPACE <span>EARLY PREVIEW · 0.1</span></div></div></aside>}
    <main className="main-workspace" inert={openingFile}>
      {!embedded && <header className="topbar"><div className="topbar-path"><FolderOpen size={15} /><span>Your space</span><ChevronRight size={13} /><strong>{active.label}</strong></div><div className="topbar-right"><span className="desktop-only">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span><span className="profile-avatar" aria-label="Personal workspace">W</span></div></header>}
      {embedded && app !== initialApp && <button className="embedded-back text-button" onClick={() => void navigate(initialApp)}><ArrowLeft size={15} />Back to {navItems.find(item => item.id === initialApp)?.label}</button>}
      {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.type === 'error' ? <AlertCircle size={17} /> : notice.type === 'success' ? <Check size={17} /> : <Circle size={13} />}</span><p>{notice.message}</p><button className="tool-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
      {import.meta.env.MODE === 'workos-host' && app === 'code' ? <div className="empty-state">
        <button className="button primary" onClick={() => void openCode(selectedId).catch(error => notify(errorMessage(error), 'error'))}>Open in Code</button>
      </div> : app === 'code' && (workbench || selected?.kind === 'code') && !loading && !fatal ? <div className="code-app-slot" inert={operation}>
        <EditorBoundary onRecover={() => void navigate('files')}><Suspense fallback={<div className="editor-loading">Opening Code…</div>}>
          {!workbench && selected ? <LibraryFileEditor key={`${selected.id}-${editorEpoch}`} record={selected}
            onCommitted={upsert} onCopy={copyCreated} onExport={exportOne} onSaveToProject={setCopy}
            registerGuard={registerGuard} ask={ask} notify={notify} close={() => void navigate('code')} />
            : external ? <AppFileEditor key={external.handle.id} file={external} registerGuard={registerGuard}
            close={() => void navigate('code')} /> : projectBrowser}
        </Suspense></EditorBoundary>
      </div> : <>
      {app !== 'code' && <div className="app-heading"><div><div className="app-eyebrow">YOUR PERSONAL WORKSPACE</div><h1>{active.label}<span className="heading-dot">.</span></h1><p>{active.subtitle}</p></div><div className="heading-actions">{['files', 'code', 'pdf'].includes(app) && <button className="button secondary" aria-label="Import file" data-testid="file-import-button" disabled={operation || loading} onClick={requestImport}><Upload size={16} /><span>Import{app === 'pdf' ? ' PDF' : ''}</span></button>}{['files', 'code'].includes(app) && <button className="button primary" aria-label="New code file" data-testid="new-code-file" disabled={operation || loading} onClick={() => void newCodeFile()}><Plus size={17} />New file</button>}</div></div>}

      <div className={`app-content ${operation ? "is-busy" : ""}`} inert={operation} aria-busy={operation}>
        {app === 'code' && selected?.kind === 'note' && <button className="button secondary code-legacy-projects" onClick={() => void navigate('code')}><ArrowLeft size={15} />Projects</button>}
        {loading ? <div className="empty-state"><LoaderCircle className="spin" size={28} /><h3>Making a little space…</h3><p>Opening your workspace.</p></div> : fatal ? <div className="empty-state"><AlertCircle size={30} /><h3>Your workspace couldn’t be opened</h3><p>{fatal}</p><button className="button primary" onClick={load}><RefreshCw size={16} />Try again</button></div> : app === 'files' ? <div className="files-page">
          <div className="files-welcome"><div><span className="section-eyebrow">ROOM TO THINK</span><h2>All your ideas.<br />Right where you left them.</h2><p>Create a code file or import a PDF.</p></div><div className="files-illustration" aria-hidden="true"><div className="paper paper-back"><Code2 size={27} /></div><div className="paper paper-front"><FileText size={28} /><span /><span /><span /></div><div className="illustration-dot" /></div></div>
          <div className="file-stats">{([{ kind: 'code', label: 'Code files', icon: FileCode2 }, { kind: 'pdf', label: 'PDFs', icon: BookOpen }] as const).map(item => <button key={item.kind} className="file-stat" onClick={() => void navigate(appForKind(item.kind))}><span className={`kind-icon ${item.kind}`}><item.icon size={22} /></span><span><strong>{documents.filter(doc => doc.kind === item.kind).length}</strong><span>{item.label}</span></span><ArrowUpRight size={17} /></button>)}</div>
          <div className="file-table-head"><h3>All files <span>{documents.length}</span></h3><label className="search-field"><Search size={16} /><input aria-label="Search files" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a file…" />{search && <button className="tool-button" aria-label="Clear search" onClick={() => setSearch('')}><X size={14} /></button>}</label></div>
          <div className="file-table" role="table" aria-label="Workspace files"><div className="file-table-labels" role="row"><span role="columnheader">NAME</span><span role="columnheader">TYPE</span><span role="columnheader">UPDATED</span><span className="visually-hidden" role="columnheader">Actions</span></div>{filtered.length ? filtered.map(record => { const Icon = iconForKind(record.kind); return <div className="file-row" role="row" key={record.id}><button className="file-name" aria-label={`Open ${record.title}`} onClick={() => void openDocument(record.id)}><span className={`kind-icon ${record.kind}`}><Icon size={19} /></span><span>{record.title}</span></button><span className="file-type" role="cell">{kindName(record.kind)}</span><span className="file-date" role="cell">{humanDate(record.updatedAt)}</span><div className="file-row-actions" role="cell"><button className="tool-button" aria-label={`Export ${record.title}`} onClick={() => void exportOne(record)}><ArrowDownToLine size={16} /></button><button className="tool-button" aria-label={`Delete ${record.title}`} disabled={operation} onClick={() => void remove(record)}><Trash2 size={16} /></button></div></div>; }) : <div className="quiet-empty"><FolderOpen size={28} /><h3>{search ? 'No files match that search.' : 'A clean desk, ready for you.'}</h3><p>{search ? 'Try a different name.' : 'Create a file or import your first document.'}</p></div>}</div><p className="files-storage-note"><HardDrive size={14} />{store.durability === 'browser-local' ? 'Files stay in this browser. Clearing site data removes them; export important work.' : 'Files are committed to this app’s storage. Export a separate copy for backup.'}</p>
        </div> : <div className={`editor-layout ${selected ? 'has-selection' : ''}`}><aside className="document-list"><label className="search-field"><Search size={15} /><input aria-label={`Search ${active.label.toLowerCase()}`} value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${active.label.toLowerCase()}…`} /></label><div className="collection-label"><span>YOUR COLLECTION</span><span>{appDocuments.length}</span></div><div className="document-list-items">{filtered.map(record => { const Icon = iconForKind(record.kind); return <button key={record.id} className={`document-list-card ${record.id === selectedId ? 'selected' : ''}`} onClick={() => void openDocument(record.id)} aria-label={`Open ${record.title}`} aria-current={record.id === selectedId ? 'true' : undefined}><span className="document-list-title"><Icon size={15} /><strong>{record.title}</strong>{record.id === selectedId && <span className="selected-dot" />}</span><span className="document-preview">{record.kind === 'note' ? noteText(record.data).slice(0, 120) : record.kind === 'code' ? (record.data as CodeData).text.slice(0, 120) || 'An empty file, ready for your code.' : `${((record.data as PDFData).size / 1024 / 1024).toFixed(1)} MB · PDF document`}</span><span className="document-list-date">{humanDate(record.updatedAt)}</span></button>; })}{!filtered.length && <div className="list-empty">{search ? 'No matching documents.' : 'Your collection starts here.'}</div>}</div><div className="collection-footer"><span className="status-dot" />{appDocuments.length} {appDocuments.length === 1 ? 'document' : 'documents'} in your collection</div></aside><div className="editor-panel"><button className="mobile-back text-button" onClick={async () => { if (!beginOperation()) return; try { if (await guard.current()) { await remember(app, null); setSelectedId(null); } } finally { endOperation(); } }}><ArrowLeft size={16} />All {active.label.toLowerCase()}</button>{selected && appForKind(selected.kind) === app ? <EditorBoundary key={selected.id} onRecover={() => void navigate('files')}>{selected.kind === 'pdf' ? <div className="document-pane pdf-pane"><div className="pdf-document-header"><div><span className="section-eyebrow">YOUR LIBRARY</span><h2>{selected.title}</h2></div><button className="button secondary" aria-label="Export PDF" onClick={() => void exportOne(selected)}><ArrowDownToLine size={16} />Export</button></div><Suspense fallback={<div className="editor-loading">Opening PDF viewer…</div>}><PDFViewer data={selected.data as PDFData} /></Suspense></div> : selected.kind === 'note' ? <section className="document-pane"><div className="document-heading"><h2>{selected.title}</h2><button className="button secondary" onClick={() => void exportOne(selected)}><ArrowDownToLine size={16} />Export original note</button></div><div className="legacy-note-text">{noteText(selected.data)}</div></section> : null}</EditorBoundary> : empty}</div></div>}
      </div>
      </>}
    </main>
      <input ref={fileInput} className="visually-hidden" aria-label="Import file input" data-testid="file-import" type="file" accept={app === 'pdf' ? 'application/pdf,.pdf' : '.pdf,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.py,.rs,.go,.yaml,.yml,.toml,.csv'} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); }} />
    {confirmation && <ConfirmationDialog value={confirmation} finish={choice => { confirmation.resolve(choice); setConfirmation(null); }} />}
  </div>;
}
