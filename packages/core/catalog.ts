import { WorkspaceError } from './errors';

/** Exact initial launch URLs. Subsequent hosted navigation is a host policy. */
export const CATALOG_APPS = Object.freeze([
  Object.freeze({ id: 'desmos', title: 'Desmos Scientific Calculator', url: 'https://www.desmos.com/scientific' }),
  Object.freeze({ id: 'excalidraw', title: 'Excalidraw', url: 'https://excalidraw.com/' }),
  Object.freeze({ id: 'wikipedia', title: 'Wikipedia', url: 'https://en.wikipedia.org/' }),
]);

export function approvedOnlineURL(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048 || input !== input.trim()) throw new WorkspaceError('E_POLICY', 'Choose an approved catalog application.');
  let url: URL;
  try { url = new URL(input); } catch { throw new WorkspaceError('E_POLICY', 'Online applications require an approved HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !CATALOG_APPS.some(app => app.url === url.href)) {
    throw new WorkspaceError('E_POLICY', 'This initial application URL is not in the curated catalog.');
  }
  return url.href;
}
