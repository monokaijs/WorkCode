import { useEffect, useReducer, useRef, useState } from 'react';
import { errorCode, errorMessage, store } from '../workspace';
import { editorText } from './ProjectEditor';
import { nameOf, projects, sourceFile, type Entry, type FileVersion, type Project } from '../../../packages/sdk/code-projects';

export interface Buffer {
  path: string;
  base: FileVersion;
  text: string;
  disk?: FileVersion | null;
  error?: string;
}
export interface Session { tabs: string[]; active: string | null; entry: string | null }
export const dirty = (buffer: Buffer) => buffer.text !== editorText(buffer.base.text);
function sessionKey(project: Project) {
  // Project IDs can contain long native paths. Preference keys are bounded.
  let first = 2166136261, second = 5381;
  for (const ch of project.id) {
    first = Math.imul(first ^ ch.codePointAt(0)!, 16777619);
    second = Math.imul(second, 33) ^ ch.codePointAt(0)!;
  }
  return `code.session.${first >>> 0}.${second >>> 0}`;
};

export function useProjectFiles(project: Project, report: (error: unknown) => void) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [session, setSession] = useState<Session>({ tabs: [], active: null, entry: null });
  const [ready, setReady] = useState(false);
  const [indexing, setIndexing] = useState(true);
  const [saving, setSaving] = useState(0);
  const [generation, redraw] = useReducer(count => count + 1, 0);
  const state = useRef(session);
  const buffers = useRef(new Map<string, Buffer>()).current;
  const index = useRef(new Map<string, FileVersion>()).current;
  const skipped = useRef(new Set<string>()).current;
  const loads = useRef(new Map<string, Promise<Buffer | undefined>>()).current;
  const saves = useRef(new Map<string, Promise<boolean>>()).current;
  const saveLater = useRef<number>(undefined);
  const persist = useRef(Promise.resolve());
  const mounted = useRef(true);
  const restoring = useRef(true);
  const scan = useRef<Promise<void> | null>(null);
  const structure = useRef(0);
  const key = sessionKey(project);

  const remember = (next: Session) => {
    state.current = next;
    setSession(next);
    if (restoring.current) return;
    persist.current = persist.current.catch(() => {}).then(() => store.setPreference(key, { ...next, project: project.id }));
    void persist.current.catch(report);
  };

  function open(path: string, activate = true): Promise<Buffer | undefined> {
    const show = (buffer: Buffer | undefined) => {
      if (!buffer || !mounted.current) return;
      const previous = state.current;
      remember({
        ...previous,
        tabs: previous.tabs.includes(path) ? previous.tabs : [...previous.tabs, path],
        active: activate ? path : previous.active,
      });
      return buffer;
    };
    const existing = buffers.get(path);
    if (existing) return Promise.resolve(show(existing));
    let pending = loads.get(path);
    if (!pending) {
      const epoch = structure.current;
      pending = projects.read(project, path).then(base => {
        if (!mounted.current || structure.current !== epoch) return;
        const buffer: Buffer = { path, base, text: editorText(base.text) };
        buffers.set(path, buffer);
        index.set(path, base);
        redraw();
        return buffer;
      }).catch(error => { if (!restoring.current && mounted.current) report(error); return undefined; }).finally(() => loads.delete(path));
      loads.set(path, pending);
    }
    return pending.then(show);
  }

  function save(buffer: Buffer): Promise<boolean> {
    if (saves.has(buffer.path)) return saves.get(buffer.path)!;
    if (buffer.disk !== undefined) return Promise.resolve(false);
    if (!dirty(buffer)) return Promise.resolve(true);
    const task = (async () => {
      setSaving(value => value + 1);
      try {
        while (dirty(buffer)) {
          const original = buffer.base;
          const text = original.text.includes('\r\n') && !/(?<!\r)\n/.test(original.text)
            ? buffer.text.replace(/\n/g, '\r\n')
            : original.text.includes('\r') && !original.text.includes('\n') ? buffer.text.replace(/\n/g, '\r') : buffer.text;
          try {
            buffer.base = await projects.write(project, buffer.path, text, original.revision);
            buffer.error = undefined;
            index.set(buffer.path, buffer.base);
          } catch (error) {
            if (errorCode(error) === 'E_CONFLICT') {
              try {
                const disk = await projects.read(project, buffer.path);
                buffer.disk = disk;
                index.set(buffer.path, disk);
              } catch (readError) {
                if (errorCode(readError) === 'E_NOT_FOUND') buffer.disk = null;
                else buffer.error = errorMessage(readError);
              }
            } else buffer.error = errorMessage(error);
            return false;
          }
        }
        return true;
      } finally {
        setSaving(value => value - 1);
        redraw();
      }
    })().finally(() => saves.delete(buffer.path));
    saves.set(buffer.path, task);
    return task;
  }

  function change(buffer: Buffer, text: string) {
    buffer.text = text;
    redraw();
    window.clearTimeout(saveLater.current);
    saveLater.current = window.setTimeout(() => { void flushFiles(); }, 650);
  }

  async function flushFiles() {
    window.clearTimeout(saveLater.current);
    const results = await Promise.all(Array.from(buffers.values(), save));
    return results.every(Boolean);
  }

  async function flush() {
    if (!await flushFiles()) {
      const problem = Array.from(buffers.values()).find(buffer => buffer.disk !== undefined || buffer.error);
      if (problem) report(problem.error || `Resolve the external change to ${nameOf(problem.path)} before closing.`);
      return false;
    }
    try { await persist.current; return true; } catch { return false; }
  }

  async function refresh(full = false) {
    if (scan.current) {
      if (!full) return scan.current;
      await scan.current;
      return refresh(true);
    }
    if (!mounted.current) return;
    const epoch = structure.current;
    const task = (async () => {
      const files = await projects.list(project);
      if (!mounted.current || structure.current !== epoch) return;
      setEntries(files);
      const paths = new Set(files.filter(item => !item.directory).map(item => item.path));
      for (const path of index.keys()) if (!paths.has(path)) index.delete(path);
      for (const path of skipped) if (!paths.has(path)) skipped.delete(path);
      const priority = (path: string) => sourceFile(path) || path === 'tsconfig.json' ? 0 : 1;
      const candidates = [...paths].filter(path => full || (!index.has(path) && !skipped.has(path)));
      candidates.sort((left, right) => priority(left) - priority(right));
      const queue = [...new Set([...buffers.keys(), ...candidates])];
      let next = 0;
      let indexedBytes = full ? 0 : Array.from(index.values()).reduce((bytes, file) => bytes + file.text.length * 2, 0);
      let truncated = false;
      await Promise.all(Array.from({ length: Math.min(queue.length, 8) }, async () => {
        while (next < queue.length && mounted.current && structure.current === epoch) {
          const path = queue[next++];
          const buffer = buffers.get(path);
          if (saves.has(path)) continue;
          const previous = buffer?.base;
          let version: FileVersion | null;
          try { version = paths.has(path) ? await projects.read(project, path) : null; }
          catch (error) {
            if (errorCode(error) === 'E_NOT_FOUND') version = null;
            else continue;
          }
          if (!mounted.current || structure.current !== epoch || saves.has(path) || (buffer && buffer.base !== previous)) continue;
          if (version) {
            const oldBytes = full ? 0 : (index.get(path)?.text.length ?? 0) * 2;
            const bytes = version.text.length * 2;
            if (indexedBytes - oldBytes + bytes <= 32 * 1024 * 1024 || buffer) {
              indexedBytes += bytes - oldBytes;
              index.set(path, version);
              skipped.delete(path);
            } else {
              index.delete(path);
              skipped.add(path);
              truncated = true;
            }
          } else {
            index.delete(path);
            skipped.add(path);
          }
          if (!buffer) continue;
          if (buffer.base.revision === version?.revision) {
            if (buffer.disk !== undefined) buffer.disk = undefined;
            continue;
          }
          if (dirty(buffer) || !version) buffer.disk = version;
          else {
            buffer.base = version;
            buffer.text = editorText(version.text);
            buffer.disk = undefined;
            buffer.error = undefined;
          }
        }
      }));
      if (!mounted.current || structure.current !== epoch) return;
      if (truncated) report('The project index reached 32 MB. Open individual files to include them, or open a smaller folder.');
      redraw();
    })().catch(error => { if (mounted.current) report(error); });
    scan.current = task;
    try { await task; }
    finally { if (scan.current === task) scan.current = null; }
  }

  async function close(path: string) {
    const buffer = buffers.get(path);
    if (buffer && !await save(buffer)) {
      report(buffer.error || `Resolve the external change to ${nameOf(path)} before closing.`);
      return;
    }
    buffers.delete(path);
    const previous = state.current;
    const tabs = previous.tabs.filter(item => item !== path);
    const active = previous.active === path ? (tabs[Math.max(0, previous.tabs.indexOf(path) - 1)] ?? null) : previous.active;
    remember({ ...previous, tabs, active });
  }

  function acceptDisk(buffer: Buffer) {
    if (!buffer.disk) {
      buffers.delete(buffer.path);
      void close(buffer.path);
      return;
    }
    buffer.base = buffer.disk;
    buffer.text = editorText(buffer.disk.text);
    buffer.disk = undefined;
    buffer.error = undefined;
    redraw();
  }

  async function move(from: string, to: string) {
    if (from === to) return;
    if (!await flush()) throw new Error('Save or resolve your pending edits before moving files.');
    await projects.move(project, from, to);
    structure.current++;
    const remap = (path: string) => path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
    for (const buffer of Array.from(buffers.values())) {
      const path = remap(buffer.path);
      if (path === buffer.path) continue;
      buffers.delete(buffer.path);
      buffer.path = path;
      buffers.set(path, buffer);
    }
    const { active, tabs, entry } = state.current;
    remember({ tabs: tabs.map(remap), active: active && remap(active), entry: entry && remap(entry) });
    await refresh(true);
  }

  /** Deletes a file or folder. Its open tabs close without saving: the user confirmed the delete. */
  async function remove(path: string) {
    await projects.delete(project, path);
    structure.current++;
    const inside = (item: string) => item === path || item.startsWith(path + '/');
    for (const key of Array.from(buffers.keys())) if (inside(key)) buffers.delete(key);
    for (const key of Array.from(index.keys())) if (inside(key)) index.delete(key);
    const { tabs, active, entry } = state.current;
    const kept = tabs.filter(item => !inside(item));
    const neighbour = active && inside(active) ? tabs.slice(0, tabs.indexOf(active)).reverse().find(item => !inside(item)) ?? kept[0] ?? null : active;
    remember({ tabs: kept, active: neighbour, entry: entry && inside(entry) ? null : entry });
    await refresh(true);
  }

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      const saved = await store.getPreference<(Session & { project: string }) | null>(key, null).catch(error => { report(error); return null; });
      if (!mounted.current) return;
      if (saved?.project === project.id && Array.isArray(saved.tabs)) {
        for (const path of saved.tabs.slice(0, 30)) if (typeof path === 'string') await open(path, false);
        if (mounted.current) {
          remember({ ...state.current, active: state.current.tabs.includes(saved.active ?? '') ? saved.active : state.current.tabs[0] ?? null, entry: saved.entry });
        }
      }
      if (!mounted.current) return;
      restoring.current = false;
      setReady(true);
      await refresh(true);
      if (mounted.current) setIndexing(false);
    })();
    const interval = window.setInterval(() => { if (!document.hidden && !restoring.current) void refresh(); }, 5500);
    const focus = () => { if (!restoring.current) void refresh(true); };
    window.addEventListener('focus', focus);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.clearTimeout(saveLater.current);
      window.removeEventListener('focus', focus);
    };
  }, [project.id]);

  return { entries, session, remember, ready, generation, redraw, indexing, saving, buffers, index,
    open, change, refresh, flush, close, move, remove, acceptDisk };
}
