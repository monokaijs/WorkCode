import { approvedOnlineURL } from '../core/catalog';
import { WorkspaceError } from '../core/errors';
import type { NativeMessageHandler, WorkspaceStore } from '../core/types';
import { validateId } from '../core/validation';
import { BrowserWorkspaceStore } from './browser-store';
import { NativeTransport, NativeWorkspaceStore } from './native-store';

export * from '../core/index';
export * from './app-context';

function nativeHandler(): NativeMessageHandler | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = window as unknown as { webkit?: { messageHandlers?: { workspace?: NativeMessageHandler } } };
  const handler = host.webkit?.messageHandlers?.workspace;
  if (handler !== undefined && (!handler || typeof handler.postMessage !== 'function')) {
    throw new WorkspaceError('E_PROTOCOL', 'The native workspace bridge is malformed.');
  }
  return handler;
}

/** The factory is safe to import in SSR/tests; browser facilities are used lazily. */
export function createWorkspaceStore(): WorkspaceStore {
  const handler = nativeHandler();
  return handler ? new NativeWorkspaceStore(new NativeTransport(handler)) : new BrowserWorkspaceStore();
}

export async function openCode(id: string | null = null): Promise<boolean> {
  if (id !== null) validateId(id);
  const handler = nativeHandler();
  if (!handler) return false;
  const result = await new NativeTransport(handler).request('host.openCode', { id });
  if (typeof result !== 'boolean') throw new WorkspaceError('E_PROTOCOL', 'Invalid Code launch result.');
  return result;
}

export async function openNativePDF(id: string): Promise<boolean> {
  validateId(id);
  const handler = nativeHandler();
  if (!handler) return false;
  const result = await new NativeTransport(handler).request('host.openPDF', { id });
  if (typeof result !== 'boolean') throw new WorkspaceError('E_PROTOCOL', 'The native host returned an invalid launch result.');
  return result;
}

/** Browser launch is initiated before any await, preserving the user's gesture. */
export async function openOnlineApp(url: string): Promise<boolean> {
  const approved = approvedOnlineURL(url);
  const handler = nativeHandler();
  if (handler) {
    const result = await new NativeTransport(handler).request('host.openOnline', { url: approved });
    if (typeof result !== 'boolean') throw new WorkspaceError('E_PROTOCOL', 'The native host returned an invalid launch result.');
    return result;
  }
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false;
  // noopener/noreferrer deliberately prevent a returned WindowProxy in modern
  // browsers. A null return therefore cannot reliably identify popup blocking.
  try { window.open(approved, '_blank', 'noopener,noreferrer'); }
  catch (error) { throw new WorkspaceError('E_UNAVAILABLE', 'The browser could not open the online application.', error); }
  return true;
}
