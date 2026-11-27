import { captureBrowserImage, pickBrowserImage } from './browser-images';

/** WorkOS application SDK. Importing it does not open storage or contact a host. */
export type AppCapability = 'files.read' | 'files.write' | 'preferences' | 'share' | 'clipboard' | 'notifications' | 'camera' | 'photos';
export interface WorkOSManifest {
  version: 1;
  capabilities: AppCapability[];
  commands?: { id: string; title: string; location: 'files' | 'desktop' | 'launcher' | 'window'; extensions?: string[] }[];
}
export interface AppFile {
  readonly id: string;
  readonly name: string;
  readonly writable: boolean;
}
export type Activation = { kind: 'launch' | 'open' | 'command'; command?: string; files?: AppFile[] };
export type CapabilityOperation = 'files.pickOpen' | 'files.pickSave' | 'files.read' | 'files.write'
  | 'preferences' | 'share' | 'clipboard.readText' | 'clipboard.writeText' | 'notifications' | 'camera.capture' | 'photos.pick';
export type AppPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';
export interface AppShare { title?: string; text?: string; url?: string; files?: AppFile[] }
export interface OpenOptions { multiple?: boolean; edit?: boolean; extensions?: string[] }
export class AppCapabilityError extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}

interface AppTransport { postMessage(request: Record<string, unknown>): Promise<unknown> }
function transport(): AppTransport | undefined {
  return (globalThis as { webkit?: { messageHandlers?: { workosApp?: AppTransport } } }).webkit?.messageHandlers?.workosApp;
}

async function call<T>(bridge: AppTransport, method: string, fields: Record<string, unknown> = {}): Promise<T> {
  try { return await bridge.postMessage({ ...fields, version: 1, method }) as T; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppCapabilityError(message.match(/\bE_[A-Z_]+\b/)?.[0] ?? 'E_UNAVAILABLE', message);
  }
}

function encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}

export function createAppContext(browserAppID = 'default') {
  const bridge = transport();
  const imports = new Map<string, File>();
  function importFile(file: File): AppFile {
    const id = crypto.randomUUID();
    imports.set(id, file);
    return { id, name: file.name, writable: false };
  }
  const namespace = 'workos.preferences.' + encodeURIComponent(browserAppID) + '/';
  const unavailable = (): never => { throw new AppCapabilityError('E_UNAVAILABLE'); };
  const files = {
    async pickOpen(options: OpenOptions = {}): Promise<AppFile[]> {
      if (bridge) return call(bridge, 'files.pickOpen', { ...options });
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = !!options.multiple;
        input.accept = (options.extensions ?? []).map(ext => '.' + ext).join(',');
        input.oncancel = () => reject(new AppCapabilityError('E_CANCELLED'));
        input.onchange = () => resolve(Array.from(input.files ?? [], importFile));
        input.click();
      });
    },
    async read(file: AppFile): Promise<{ file: File; version: string }> {
      if (!bridge) {
        const original = imports.get(file.id);
        if (!original) throw new AppCapabilityError('E_INVALID_HANDLE');
        return { file: original, version: String(original.lastModified) };
      }
      const result = await call<{ base64: string; version: string }>(bridge, 'files.read', { id: file.id });
      const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
      return { file: new File([bytes], file.name), version: result.version };
    },
    async release(file: AppFile): Promise<void> {
      if (bridge) await call(bridge, 'files.release', { id: file.id });
      else imports.delete(file.id);
    },
    async pickSave(name: string): Promise<{ file: AppFile; version: string }> {
      return bridge ? call(bridge, 'files.pickSave', { name }) : unavailable();
    },
    async write(file: AppFile, bytes: Uint8Array, expectedVersion: string): Promise<string> {
      if (!bridge) return unavailable();
      if (bytes.byteLength > 8 * 1024 * 1024) throw new AppCapabilityError('E_VALIDATION', 'File exceeds 8 MiB.');
      return call(bridge, 'files.write', { id: file.id, expectedVersion, base64: encode(bytes) });
    },
  };
  const browserSupports = (op: CapabilityOperation): boolean => {
    switch (op) {
      case 'files.pickOpen': case 'files.read': return typeof document !== 'undefined';
      case 'files.write': case 'files.pickSave': return false;
      case 'camera.capture': return typeof document !== 'undefined' && !!globalThis.navigator?.mediaDevices?.getUserMedia;
      case 'photos.pick': return typeof document !== 'undefined';
      case 'share': return typeof navigator.share === 'function';
      case 'notifications': return typeof Notification !== 'undefined';
      case 'preferences': return typeof localStorage !== 'undefined';
      case 'clipboard.readText': return typeof navigator.clipboard?.readText === 'function';
      case 'clipboard.writeText': return typeof navigator.clipboard?.writeText === 'function';
    }
  };
  async function image(operation: 'camera.capture' | 'photos.pick', facing: 'user' | 'environment' = 'environment'): Promise<File> {
    if (bridge) {
      const base64 = await call<string>(bridge, operation, operation === 'camera.capture' ? { facing } : {});
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      return new File([bytes], operation === 'camera.capture' ? 'camera.jpg' : 'photo.jpg', { type: 'image/jpeg' });
    }
    if (!browserSupports(operation)) return unavailable();
    try { return operation === 'camera.capture' ? await captureBrowserImage(facing) : await pickBrowserImage(); }
    catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      const codes: Record<string, string> = { AbortError: 'E_CANCELLED', NotAllowedError: 'E_DENIED', SecurityError: 'E_DENIED',
        NotReadableError: 'E_BUSY', InvalidStateError: 'E_BUSY', TypeMismatchError: 'E_VALIDATION' };
      throw new AppCapabilityError(codes[name] ?? 'E_UNAVAILABLE', error instanceof Error ? error.message : String(error));
    }
  }
  return {
    files,
    camera: { capture: (options: { facing?: 'user' | 'environment' } = {}) => image('camera.capture', options.facing) },
    photos: { pick: () => image('photos.pick') },
    async supports(operation: CapabilityOperation): Promise<boolean> {
      if (!bridge) return browserSupports(operation);
      if (['notifications', 'clipboard.readText', 'clipboard.writeText'].includes(operation) && !browserSupports(operation)) return false;
      return call(bridge, 'supports', { operation });
    },
    permissions: {
      async query(operation: CapabilityOperation): Promise<AppPermission> {
        if (operation === 'notifications') {
          if (typeof Notification === 'undefined') return 'unavailable';
          return Notification.permission === 'default' ? 'prompt' : Notification.permission;
        }
        if (operation.startsWith('clipboard.')) {
          if (!browserSupports(operation)) return 'unavailable';
          try {
            const name = operation === 'clipboard.readText' ? 'clipboard-read' : 'clipboard-write';
            return (await navigator.permissions.query({ name: name as PermissionName })).state;
          } catch { return 'prompt'; }
        }
        if (bridge) return call(bridge, 'permissions.query', { operation });
        if (!browserSupports(operation)) return 'unavailable';
        if (operation === 'camera.capture') {
          try { return (await navigator.permissions.query({ name: 'camera' as PermissionName })).state; }
          catch { return 'prompt'; }
        }
        return operation === 'preferences' ? 'granted' : 'prompt';
      },
    },
    async setDirty(dirty: boolean): Promise<void> {
      if (bridge) await call(bridge, 'app.setDirty', { dirty });
    },
    async activation(): Promise<Activation> {
      return bridge ? call(bridge, 'app.activation') : { kind: 'launch' };
    },
    /** Drain pending invocations after registering, including a cold launch. */
    onActivation(listener: (activation: Activation) => void) {
      let active = true;
      const receive = async () => {
        const event: Activation = bridge ? await call(bridge, 'app.activation') : { kind: 'launch' };
        if (active) listener(event);
      };
      if (!bridge) {
        // A browser-installed PWA receives OS file launches through the web launch queue.
        const queue = (globalThis as { launchQueue?: {
          setConsumer(fn: (launch: { files: FileSystemFileHandle[] }) => void): void;
        } }).launchQueue;
        queue?.setConsumer(async ({ files }) => {
          if (!active || !files.length) return;
          try {
            const opened = await Promise.all(files.map(handle => handle.getFile()));
            if (active) listener({ kind: 'open', files: opened.map(importFile) });
          } catch (error) { console.error('Could not read the launched file.', error); }
        });
      }
      document.addEventListener('workos-activate', receive);
      const ready = receive();
      return { ready, remove() { active = false; document.removeEventListener('workos-activate', receive); } };
    },
    preferences: {
      async get<T>(key: string): Promise<T | null> {
        const raw = bridge ? await call<string | null>(bridge, 'preferences.get', { key }) : localStorage.getItem(namespace + key);
        return raw === null ? null : JSON.parse(raw) as T;
      },
      async set(key: string, value: unknown): Promise<void> {
        const json = JSON.stringify(value);
        if (json === undefined) throw new AppCapabilityError('E_VALIDATION');
        if (bridge) await call(bridge, 'preferences.set', { key, value: json });
        else localStorage.setItem(namespace + key, json);
      },
      async remove(key: string): Promise<void> {
        if (bridge) await call(bridge, 'preferences.remove', { key });
        else localStorage.removeItem(namespace + key);
      },
    },
    share: {
      async present({ title, text, url, files }: AppShare): Promise<void> {
        if (bridge) {
          await call(bridge, 'share.present', { text: text ?? title ?? '', ...(url && { url }), files: files?.map(file => file.id) ?? [] });
          return;
        }
        if (!navigator.share) return unavailable();
        const selected = files?.map(file => {
          const original = imports.get(file.id);
          if (!original) throw new AppCapabilityError('E_INVALID_HANDLE');
          return original;
        });
        await navigator.share({ title, text, url, ...(selected?.length && { files: selected }) });
      },
    },
    clipboard: {
      readText: () => navigator.clipboard?.readText() ?? Promise.reject(new AppCapabilityError('E_UNAVAILABLE')),
      writeText: (text: string) => navigator.clipboard?.writeText(text) ?? Promise.reject(new AppCapabilityError('E_UNAVAILABLE')),
    },
    notifications: {
      permission: () => typeof Notification === 'undefined' ? 'denied' : Notification.permission,
      requestPermission: () => typeof Notification === 'undefined' ? Promise.resolve('denied' as const) : Notification.requestPermission(),
      show: (title: string, options?: NotificationOptions) => {
        if (typeof Notification === 'undefined') return unavailable();
        if (Notification.permission !== 'granted') throw new AppCapabilityError('E_DENIED');
        return new Notification(title, options);
      },
    },
  };
}
