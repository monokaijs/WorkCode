import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, Code2, FileCode2, FolderOpen, FolderPlus, Server, Upload, X } from 'lucide-react';
import { errorMessage, store } from '../workspace';
import CodeDialog from './CodeDialog';
import ProjectPane from './ProjectPane';
import { checkPath, isNative, linuxProjects, projects, type Folder, type Project } from '../../../packages/sdk/code-projects';
import './code.css';

export interface ProjectTarget { id: string; path?: string; serial: number }
export interface LibraryCopy { name: string; text: string }
interface Props {
  openFile(): void;
  windowID: string;
  target?: ProjectTarget;
  copy?: LibraryCopy;
  onCopyDone(): void;
  onCancelCopy(): void;
  library: { id: string; title: string }[];
  openDocument(id: string): void;
  newDocument(): void;
  importDocument(): void;
  registerGuard(guard: () => Promise<boolean>): () => void;
}
const recentKey = 'code.projects.recent';
/** How a project location reads to people: Linux sees Home/Projects as ~/Projects. */
function describe({ id, host }: Project, hosts: Folder[]) {
  if (id === linuxProjects || id.startsWith(linuxProjects + '/')) return '~/Projects' + id.slice(linuxProjects.length);
  if (!id.startsWith('remote-')) return id.replace(/^home\/?/, 'Home/');
  const [connection, ...path] = id.split('/');
  return `SSH · ${host ?? hosts.find(item => item.id === connection)?.name ?? 'host'}:/${path.join('/')}`;
}
const lastKey = (windowID: string) => `code.projects.active.${windowID}`;

export default function CodeWorkbench(props: Props) {
  const { windowID } = props;
  const [project, setProject] = useState<Project | null>(null);
  const [recent, setRecent] = useState<Project[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<'Open Folder' | 'New Project' | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [trail, setTrail] = useState<Folder[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');
  const [copied, setCopied] = useState<{ path: string; serial: number }>();
  const [destination, setDestination] = useState<{ project: Project; path: string }>();
  const [showLibrary, setShowLibrary] = useState(false);
  const [hosts, setHosts] = useState<Folder[]>([]);
  const paneGuard = useRef<(() => Promise<boolean>) | null>(null);
  const paneRefresh = useRef<(() => Promise<void>) | undefined>(undefined);
  const importInput = useRef<HTMLInputElement>(null);
  const lastTarget = useRef<number>(undefined);
  const generation = useRef(0);
  const operations = useRef(0);
  const mounted = useRef(true);
  const current = useRef(project);
  const persist = useRef(Promise.resolve());
  current.current = project;
  const report = useCallback((error: unknown) => setNotice(typeof error === 'string' ? error : errorMessage(error)), []);
  const register = useCallback((flush: (() => Promise<boolean>) | null, refresh?: () => Promise<void>) => {
    paneGuard.current = flush;
    paneRefresh.current = refresh;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => props.registerGuard(async () => {
    if (operations.current) return false;
    if (paneGuard.current && !await paneGuard.current()) return false;
    try { await persist.current; return true; } catch { return false; }
  }), [props.registerGuard]);
  useEffect(() => {
    const refresh = () => { void paneRefresh.current?.(); };
    window.addEventListener('workspace:resume', refresh);
    return () => window.removeEventListener('workspace:resume', refresh);
  }, []);

  const saveSelection = (value: Project | null) => {
    persist.current = persist.current.catch(() => {}).then(async () => {
      if (value) {
        const saved = await store.getPreference<Project[]>(recentKey, []);
        const next = [value, ...saved.filter(item => item.id !== value.id)].slice(0, 20);
        await store.setPreference(recentKey, next);
        if (mounted.current) setRecent(next);
      }
      await store.setPreference(lastKey(windowID), value);
    });
    void persist.current.catch(report);
  };

  async function select(id: string, remember: boolean, forceProject = false) {
    const token = ++generation.current;
    operations.current++;
    try {
      if (current.current?.id !== id && paneGuard.current && !await paneGuard.current()) return;
      const copying = Boolean(props.copy && !forceProject);
      const value = await projects.open(id, !copying);
      if (!mounted.current || token !== generation.current) return;
      if (!value) { setModal(null); return; }
      if (copying && props.copy) {
        const clean = props.copy.name.replace(/[\\/\x00-\x1f]/g, '-').trim();
        setDestination({ project: value, path: clean === '.' || clean === '..' ? 'untitled.txt' : clean || 'untitled.txt' });
      } else {
        setProject(value);
        if (remember) saveSelection(value);
      }
      setModal(null);
    } finally { operations.current--; }
  }

  useEffect(() => {
    if (props.target) return;
    let active = true;
    void (async () => {
      const values = await store.getPreference<Project[]>(recentKey, []);
      if (!active) return;
      setRecent(values);
      if (isNative) void projects.hosts().then(list => { if (active) setHosts(list); }).catch(() => {});
      if (props.copy) return;
      const last = await store.getPreference<Project | null>(lastKey(windowID), null);
      if (active && last && !current.current && !generation.current) await select(last.id, false);
    })().catch(error => { if (active) report(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!props.target || lastTarget.current === props.target.serial) return;
    lastTarget.current = props.target.serial;
    setLoading(true);
    void select(props.target.id, true, true).catch(report).finally(() => { if (mounted.current) setLoading(false); });
  }, [props.target?.serial]);
  useEffect(() => {
    document.title = project ? `${project.name} — Code` : 'Code';
  }, [project]);

  const closeFolderModal = () => { if (!busy) setModal(null); };
  function pickFolder(mode: 'Open Folder' | 'New Project') {
    if (!isNative && mode === 'Open Folder') { importInput.current?.click(); return; }
    setName(''); setModalError(''); setTrail([]); setFolders([]); setModal(mode);
  }
  const parent = trail.at(-1);
  useEffect(() => {
    if (!isNative || !modal) return;
    let active = true;
    setFolders([]);
    setModalError('');
    void projects.folders(parent?.id ?? null).then(result => { if (active) setFolders(result); })
      .catch(error => { if (active) setModalError(errorMessage(error)); });
    return () => { active = false; };
  }, [modal, parent?.id]);

  async function fromModal(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setModalError(''); operations.current++;
    try { await action(); }
    catch (error) { setModalError(errorMessage(error)); }
    finally { operations.current--; setBusy(false); }
  }

  const connectSSH = () => fromModal(async () => {
    const location = await projects.connectSSH();
    if (location) setTrail([location]);
  });
  /** Remote-SSH: choose a folder on a saved host, as VS Code does after connecting. */
  function openRemoteFolder(host: Folder) {
    setName(''); setModalError(''); setFolders([]); setTrail([host]); setModal('Open Folder');
  }
  /** Adds an SSH connection in the native form, then browses it. */
  async function connectHost() {
    if (operations.current) return;
    operations.current++;
    try {
      const location = await projects.connectSSH();
      if (!location || !mounted.current) return;
      setHosts(previous => [location, ...previous.filter(item => item.id !== location.id)]);
      openRemoteFolder(location);
    } catch (error) { report(error); } finally { operations.current--; }
  }
  async function saveDestination() {
    if (!destination || !props.copy) return;
    const path = checkPath(destination.path.trim());
    await projects.write(destination.project, path, props.copy.text, null);
    setDestination(undefined); setCopied({ path, serial: Date.now() }); props.onCopyDone();
    try {
      const opened = await projects.open(destination.project.id);
      if (opened) { setProject(opened); saveSelection(opened); }
    } catch (error) { report(`The file was saved, but the project could not be reopened. ${errorMessage(error)}`); }
  }
  return <div className="code-app">
    {project && !props.copy ? <ProjectPane key={project.id} project={project}
      remote={isNative ? { connect: () => void connectHost(), openFolder: openRemoteFolder } : undefined} target={props.target?.id === project.id && props.target.path
      ? { path: props.target.path, serial: props.target.serial } : undefined} copied={copied} report={report} register={register} onHome={async () => {
        if (paneGuard.current && !await paneGuard.current()) return;
        setProject(null);
        saveSelection(null);
        if (isNative) void projects.clear().catch(report);
      }} /> : <div className="code-welcome">
      <header className="code-welcome-bar"><span className="code-brand"><Code2 size={18} />Code</span>
        <button className="code-secondary" onClick={() => props.copy ? props.onCancelCopy() : setShowLibrary(value => !value)}>
          {props.copy ? <ArrowLeft size={15} /> : <FileCode2 size={15} />}{props.copy ? 'Back to File' : 'Library'}</button>
      </header>
      <div className="code-welcome-content">
        <div className="code-app-icon"><Code2 size={36} strokeWidth={1.4} /></div>
        <h1>{props.copy ? 'Save to Project' : 'Code'}</h1>
        <p>{props.copy ? 'Choose a project for this library file.' : isNative ? 'Open a folder on this device or on an SSH host.' : 'Open a folder to start working on its files.'}</p>
        <div className="code-welcome-actions">
          <button className="code-primary" disabled={loading} onClick={() => pickFolder('Open Folder')}><FolderOpen size={16} />Open Folder</button>
          <button className="code-secondary" disabled={loading} onClick={() => pickFolder('New Project')}><FolderPlus size={16} />New Project</button>
          {isNative && <button className="code-secondary" disabled={loading} onClick={() => void connectHost()}><Server size={16} />Connect to SSH Host…</button>}
          {!props.copy && <button className="code-secondary" disabled={loading} onClick={props.openFile}><FileCode2 size={16} />Open File</button>}
        </div>
        {loading && <p role="status">Opening Code…</p>}
        {recent.length > 0 && <section className="code-recent" aria-label="Recent Projects"><h2>Recent Projects</h2>
          {recent.slice(0, 8).map(item => <button key={item.id} onClick={() => { void select(item.id, true).catch(report); }}>
            {item.ssh || item.id.startsWith('remote-') ? <Server size={15} /> : <FolderOpen size={15} />}
            <span>{item.name}<small>{isNative ? describe(item, hosts) : 'Browser project'}</small></span><ArrowUpRight size={14} />
          </button>)}
        </section>}
        {hosts.length > 0 && !props.copy && <section className="code-recent" aria-label="SSH Hosts"><h2>SSH Hosts</h2>
          {hosts.map(item => <button key={item.id} onClick={() => openRemoteFolder(item)}>
            <Server size={15} /><span>{item.name}<small>Open a folder on this host</small></span><ChevronRight size={14} />
          </button>)}
        </section>}
        {showLibrary && <section className="code-recent" aria-label="Library Files"><h2>Library Files</h2>
          <button onClick={props.newDocument}><FileCode2 size={15} /><span>New code file</span></button>
          <button onClick={props.importDocument}><Upload size={15} /><span>Import file</span></button>
          {props.library.map(item => <button key={item.id} onClick={() => props.openDocument(item.id)}><FileCode2 size={15} /><span>{item.title}</span></button>)}
        </section>}
      </div>
      <input className="visually-hidden" type="file" aria-label="Import project folder" multiple
        {...{ webkitdirectory: '' }} ref={importInput} onChange={event => {
          const files = event.currentTarget.files;
          if (!files?.length) return;
          operations.current++;
          setLoading(true);
          void projects.import(files).then(value => select(value.id, true)).catch(report).finally(() => {
            operations.current--;
            setLoading(false);
            if (importInput.current) importInput.current.value = '';
          });
        }} />
    </div>}
    {notice && <div className="code-notice" role="status"><span>{notice}</span><button className="code-icon" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></button></div>}
    {modal && <CodeDialog title={modal === 'Open Folder' && trail[0]?.id.startsWith('remote-') ? `Open Folder on ${trail[0].name}` : modal} close={closeFolderModal}>
      {isNative && <>
        <div className="code-folder-nav">
          <button className="code-icon" aria-label="Parent folder" disabled={!parent || busy} onClick={() => setTrail(trail.slice(0, -1))}><ArrowLeft size={16} /></button>
          <span>{trail.length ? trail.map(folder => folder.name).join(' / ') : 'Files locations'}</span>
        </div>
        {!parent && <button className="code-secondary" disabled={busy} onClick={() => void connectSSH()}><Server size={15} />Connect to SSH Host…</button>}
        <div className="code-picker-results">{folders.map(folder => <button key={folder.id} disabled={busy} onClick={() => setTrail([...trail, folder])}>
          <FolderOpen size={16} /><span>{folder.name}</span><ChevronRight size={14} /></button>)}</div>
      </>}
      <form onSubmit={event => {
        event.preventDefault();
        if (modal === 'Open Folder' && parent) void fromModal(() => select(parent.id, true));
        if (modal === 'New Project') void fromModal(async () => {
          const value = await projects.create(name.trim(), parent?.id ?? null);
          await select(value.id, true);
        });
      }}>
        {modal === 'New Project' && <label className="code-field">Project name<input className="code-input" value={name} onChange={event => setName(event.target.value)} placeholder="my-project" required /></label>}
        {modal === 'New Project' && isNative && <p>Location · {parent ? describe(parent, hosts) : '~/Projects (shared with Linux)'}</p>}
        {modalError && <p className="code-error" role="alert">{modalError}</p>}
        <div className="code-dialog-actions"><button type="button" className="code-secondary" disabled={busy} onClick={closeFolderModal}>Cancel</button>
          <button className="code-primary" disabled={busy || (modal === 'Open Folder' ? !parent : !name.trim())}>{modal === 'Open Folder' ? 'Open This Folder' : 'Create Project'}</button></div>
      </form>
    </CodeDialog>}
    {props.copy && destination && <CodeDialog title={`Save to ${destination.project.name}`} close={() => { if (!busy) setDestination(undefined); }}>
      <form onSubmit={event => {
        event.preventDefault();
        void fromModal(saveDestination);
      }}>
        <label className="code-field">Project-relative path<input className="code-input" required value={destination.path} onChange={event => setDestination({ ...destination, path: event.target.value })} /></label>
        {modalError && <p className="code-error" role="alert">{modalError}</p>}
        <div className="code-dialog-actions"><button className="code-secondary" type="button" disabled={busy} onClick={() => setDestination(undefined)}>Cancel</button><button className="code-primary" disabled={busy}>Save File</button></div>
      </form>
    </CodeDialog>}
  </div>;
}
