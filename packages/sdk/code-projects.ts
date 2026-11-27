import { createWorkspaceId, type NativeMessageHandler } from '../core';
import { NativeTransport } from './native-store';

/** `linux` is the folder's path inside the Linux environment, when Linux can reach it. */
/** `host` names an SSH project's saved connection. */
export interface Project { id: string; name: string; ssh?: boolean; host?: string; linux?: string }
export interface Entry { path: string; directory: boolean }
export interface FileVersion { text: string; revision: string }
export interface Folder extends Project { root?: boolean }
/** Where New Project puts projects: the shared folder Linux sees as ~/Projects. */
export const linuxProjects = 'home/Projects';
export const maxFileBytes = 512 * 1024;
const excluded = new Set(['.git', '.Trash', 'node_modules', '.build', '.next', 'dist', 'build', 'coverage', '__pycache__']);
export const nameOf = (path: string) => path.split('/').at(-1)!;
export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
export function checkPath(path: string) {
  if (!path || path.length > 1024 || path.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) {
    throw new Error('Enter a relative path inside the project.');
  }
  return path;
}
export function checkText(text: string) {
  if (text.includes('\0') || new TextEncoder().encode(text).length > maxFileBytes) throw new Error('Code supports UTF-8 text files up to 512 KB.');
}
export const conflict = (message = 'The file changed outside this editor.') => Object.assign(new Error(message), { code: 'E_CONFLICT' });
export const sourceFile = (path: string) => /\.[cm]?[jt]sx?$/i.test(path);

const handler = (globalThis as { webkit?: { messageHandlers?: { workspace?: NativeMessageHandler } } }).webkit?.messageHandlers?.workspace;
const native = handler ? new NativeTransport(handler) : undefined;
export const isNative = Boolean(native);
function request<T>(method: string, params: Record<string, unknown> = {}, transport = native): Promise<T> {
  if (!transport) return Promise.reject(Object.assign(new Error('This operation requires WorkOS Code.'), { code: 'E_UNAVAILABLE' }));
  return transport.request('code.' + method, params) as Promise<T>;
}

type BrowserEntry = Entry & Partial<FileVersion> & { project: string };
let connection: Promise<IDBDatabase> | undefined;
function database() {
  return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('workos-code', 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('projects', { keyPath: 'id' });
      opening.result.createObjectStore('entries', { keyPath: ['project', 'path'] }).createIndex('project', 'project');
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  }).catch(error => { connection = undefined; throw error; });
}
function value<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (projects: IDBObjectStore, entries: IDBObjectStore) => Promise<T>) {
  const tx = (await database()).transaction(['projects', 'entries'], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Project storage operation was cancelled.'));
  });
  try {
    const [result] = await Promise.all([run(tx.objectStore('projects'), tx.objectStore('entries')), done]);
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* Already complete. */ }
    throw error;
  }
}
function textEntry(project: string, path: string, text: string): BrowserEntry {
  return { project, path, text, directory: false, revision: createWorkspaceId() };
}

export const starter = {
  'tsconfig.json': '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "ESNext",\n    "moduleResolution": "Bundler",\n    "strict": true\n  }\n}\n',
  'main.ts': 'import { greet } from "./greet";\n\nconsole.log(greet("WorkOS"));\n',
  'greet.ts': 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
};

export const projects = {
  connectSSH: () => request<Folder | null>('connectSSH', {}, handler && new NativeTransport(handler, 30 * 60_000)),
  clear: () => request('clear'),
  folders: (parent: string | null) => request<Folder[]>('folders', { parent }),
  /** Saved SSH connections, which the Files app shares. */
  hosts: async () => (await request<Folder[]>('folders', { parent: null })).filter(folder => folder.id.startsWith('remote-')),
  async open(id: string, claim = true): Promise<Project | null> {
    if (native) {
      const value = await request<Project | { redirected: true }>('open', { id, claim });
      return 'redirected' in value ? null : value;
    }
    return transaction('readonly', async store => {
      const project = await value<Project | undefined>(store.get(id));
      if (!project) throw new Error('This project is no longer available.');
      return project;
    });
  },
  async create(name: string, parent: string | null, initialFiles: Record<string, string> = starter): Promise<Project> {
    if (!name.trim() || name.includes('/')) throw new Error('Enter a project name.');
    checkPath(name);
    if (native) return request('create', { parent, name });
    const project = { id: createWorkspaceId(), name };
    const paths = new Map<string, BrowserEntry>();
    for (const [path, text] of Object.entries(initialFiles)) {
      checkPath(path);
      checkText(text);
      paths.set(path, textEntry(project.id, path, text));
      for (let folder = parentOf(path); folder; folder = parentOf(folder)) {
        if (!paths.has(folder)) paths.set(folder, { project: project.id, path: folder, directory: true });
      }
    }
    await transaction('readwrite', async (store, entries) => {
      await Promise.all([value(store.add(project)), ...Array.from(paths.values(), item => value(entries.add(item)))]);
    });
    return project;
  },
  async import(files: FileList) {
    const initial = Object.create(null) as Record<string, string>;
    const name = files[0]?.webkitRelativePath.split('/')[0];
    if (!name) throw new Error('Choose a folder to import.');
    let bytes = 0;
    for (const file of files) {
      const parts = file.webkitRelativePath.split('/').slice(1);
      if (parts.some(part => excluded.has(part)) || file.size > maxFileBytes) continue;
      // Imported binary files cannot be edited as source.
      const text = await file.arrayBuffer().then(buffer => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)).catch(() => null);
      if (text === null || text.includes('\0')) continue;
      bytes += file.size;
      if (bytes > 32 * 1024 * 1024 || Object.keys(initial).length >= 4000) throw new Error('This folder exceeds the browser project import limit (32 MB or 4,000 text files).');
      initial[parts.join('/')] = text;
    }
    return this.create(name, null, initial);
  },
  async list(project: Project): Promise<Entry[]> {
    if (native) return request('list', { id: project.id });
    return transaction('readonly', async (_, entries) =>
      (await value<BrowserEntry[]>(entries.index('project').getAll(project.id))).map(({ path, directory }) => ({ path, directory })));
  },
  async read(project: Project, path: string): Promise<FileVersion> {
    checkPath(path);
    if (native) return request('read', { id: project.id, path });
    return transaction('readonly', async (_, entries) => {
      const entry = await value<BrowserEntry | undefined>(entries.get([project.id, path]));
      if (!entry || entry.directory) throw Object.assign(new Error('This file no longer exists.'), { code: 'E_NOT_FOUND' });
      return { text: entry.text!, revision: entry.revision! };
    });
  },
  async write(project: Project, path: string, text: string, revision: string | null): Promise<FileVersion> {
    checkPath(path);
    checkText(text);
    if (native) return request('write', { id: project.id, path, text, revision });
    return transaction('readwrite', async (_, entries) => {
      const old = await value<BrowserEntry | undefined>(entries.get([project.id, path]));
      if (old && !old.directory && old.text === text && revision !== null) return { text, revision: old.revision! };
      if ((old?.revision ?? null) !== revision || old?.directory) throw conflict();
      const parent = parentOf(path);
      if (parent && !(await value<BrowserEntry | undefined>(entries.get([project.id, parent])))?.directory) throw new Error('The parent folder does not exist.');
      const entry = textEntry(project.id, path, text);
      await value(entries.put(entry));
      return { text, revision: entry.revision! };
    });
  },
  async mkdir(project: Project, path: string) {
    checkPath(path);
    if (native) return request('mkdir', { id: project.id, path });
    return transaction('readwrite', async (_, entries) => {
      const parent = parentOf(path);
      if (parent && !(await value<BrowserEntry | undefined>(entries.get([project.id, parent])))?.directory) throw new Error('The parent folder does not exist.');
      await value(entries.add({ project: project.id, path, directory: true }));
    });
  },
  /** Home items go to the Trash. Items on connected drives are deleted. */
  async delete(project: Project, path: string) {
    checkPath(path);
    if (native) return request('delete', { id: project.id, path });
    return transaction('readwrite', async (_, entries) => {
      const all = await value<BrowserEntry[]>(entries.index('project').getAll(project.id));
      const removing = all.filter(item => item.path === path || item.path.startsWith(path + '/'));
      if (!removing.length) throw Object.assign(new Error('This item no longer exists.'), { code: 'E_NOT_FOUND' });
      await Promise.all(removing.map(item => value(entries.delete([project.id, item.path]))));
    });
  },
  async move(project: Project, from: string, to: string) {
    checkPath(from); checkPath(to);
    if (from === to) return;
    if (native) return request('move', { id: project.id, from, to });
    return transaction('readwrite', async (_, entries) => {
      const all = await value<BrowserEntry[]>(entries.index('project').getAll(project.id));
      const parent = parentOf(to);
      const moving = all.filter(item => item.path === from || item.path.startsWith(from + '/'));
      if (!moving.length || to.startsWith(from + '/') || all.some(item => item.path === to)
        || (parent && !all.some(item => item.path === parent && item.directory))) throw new Error('Choose an available destination inside the project.');
      const renamed = moving.map(item => ({ ...item, path: to + item.path.slice(from.length) }));
      await Promise.all([...moving.map(item => value(entries.delete([project.id, item.path]))),
        ...renamed.map(item => value(entries.add(item)))]);
    });
  },
};

/** Each terminal is bound to the host's active project and this document. */
export function openProjectShell(project: Project) {
  const params = { id: project.id, token: createWorkspaceId() };
  const ready = request('shellOpen', params);
  let writes = ready;
  return {
    async read() { await ready; return request<string>('shellRead', params); },
    input(text: string) {
      const send = async () => {
        await ready;
        // Limit messages by UTF-8 size without splitting surrogate pairs.
        let chunk = '';
        for (const character of text) {
          chunk += character;
          if (chunk.length >= 8192) { await request('shellInput', { ...params, text: chunk }); chunk = ''; }
        }
        if (chunk) await request('shellInput', { ...params, text: chunk });
      };
      writes = writes.then(send, send);
      return writes;
    },
    async resize(cols: number, rows: number) {
      await ready;
      await request('shellResize', { ...params, cols: Math.min(1000, cols), rows: Math.min(500, rows) });
    },
    async close() { await ready; await request('shellClose', params); },
  };
}
