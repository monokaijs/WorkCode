import { WorkspaceError, type WorkspaceErrorCode } from '../core/errors';
import { WORKSPACE_LIMITS, type CommitDocumentInput, type CreateDocumentInput, type DocumentRecord, type NativeMessageHandler, type NativeRequest, type WorkspaceStore } from '../core/types';
import { exactKeys, jsonSnapshot, newId, validateBlob, validateCommit, validateCreate, validateDocument, validateId, validateMimeType, validatePreferenceKey, validateRevision } from '../core/validation';

const MAX_BASE64_CHARACTERS = Math.ceil(WORKSPACE_LIMITS.assetBytes / 3) * 4;

function protocolError(cause: unknown): WorkspaceError {
  return new WorkspaceError('E_PROTOCOL', 'The native host returned an invalid response.', cause);
}

function readReply(reply: unknown): unknown {
  let hostError: WorkspaceError;
  try {
    if (reply !== null && typeof reply === 'object' && 'ok' in reply && reply.ok === true) {
      exactKeys(reply, ['ok', 'result'], 'Native reply');
      return (reply as Record<string, unknown>).result;
    }
    exactKeys(reply, ['ok', 'error'], 'Native reply');
    if (reply.ok !== false) throw protocolError(undefined);
    exactKeys(reply.error, ['code', 'message'], 'Native error');
    const { code, message } = reply.error;
    if (typeof code !== 'string' || !/^E_[A-Z_]{1,48}$/.test(code) || typeof message !== 'string' || message.length > 2048) throw protocolError(undefined);
    hostError = new WorkspaceError(code as WorkspaceErrorCode, message);
  } catch (error) {
    throw protocolError(error);
  }
  throw hostError;
}

/** A timeout is an unknown outcome, never permission to replay a new operation ID. */
export class NativeTransport {
  constructor(private readonly handler: NativeMessageHandler, private readonly timeoutMs: number = WORKSPACE_LIMITS.nativeTimeoutMs) {}

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const envelope: NativeRequest = { protocolVersion: 1, requestId: newId(), method, params };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new WorkspaceError('E_TIMEOUT', 'The native host did not reply in time. A write may have committed; reconcile it before retrying. Retry a commit only with the same operation ID and identical input.')), this.timeoutMs);
      try {
        Promise.resolve(this.handler.postMessage(envelope)).then(reply => {
          try { finish(undefined, readReply(reply)); } catch (error) { finish(error); }
        }, error => finish(new WorkspaceError('E_UNAVAILABLE', 'The native host connection failed. A write may have committed; reconcile its state before retrying.', error)));
      } catch (error) {
        finish(new WorkspaceError('E_UNAVAILABLE', 'The native host connection is unavailable.', error));
      }
    });
  }
}

async function base64FromBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  return btoa(chunks.join(''));
}

function blobFromReply(value: unknown): Blob {
  try {
    exactKeys(value, ['base64', 'mimeType'], 'Asset response');
    const encoded = value.base64;
    const mimeType = validateMimeType(value.mimeType);
    if (typeof encoded !== 'string' || encoded.length > MAX_BASE64_CHARACTERS || encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw protocolError(undefined);
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.slice(0, encoded.length - padding).includes('=') || encoded.length / 4 * 3 - padding > WORKSPACE_LIMITS.assetBytes) throw protocolError(undefined);
    const decoded = atob(encoded);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch (error) { throw protocolError(error); }
}

export class NativeWorkspaceStore implements WorkspaceStore {
  readonly durability = 'host-committed' as const;
  constructor(private readonly transport: NativeTransport) {}

  private resultDocument(result: unknown): DocumentRecord {
    try { return validateDocument(result); } catch (error) { throw protocolError(error); }
  }

  async list(): Promise<DocumentRecord[]> {
    const result = await this.transport.request('documents.list', {});
    if (!Array.isArray(result)) throw protocolError(undefined);
    return result.map(value => this.resultDocument(value));
  }

  async read(id: string): Promise<DocumentRecord> {
    validateId(id);
    return this.resultDocument(await this.transport.request('documents.read', { id }));
  }

  async create(input: CreateDocumentInput): Promise<DocumentRecord> {
    const snapshot = validateCreate(input);
    return this.resultDocument(await this.transport.request('documents.create', { ...snapshot }));
  }

  async commit(input: CommitDocumentInput): Promise<DocumentRecord> {
    const snapshot = validateCommit(input);
    return this.resultDocument(await this.transport.request('documents.commit', { ...snapshot }));
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    validateId(id); validateRevision(expectedRevision);
    const result = await this.transport.request('documents.remove', { id, expectedRevision });
    if (result !== null) throw protocolError(undefined);
  }

  async putAsset(blob: Blob): Promise<string> {
    const snapshot = validateBlob(blob);
    const base64 = await base64FromBlob(snapshot);
    const result = await this.transport.request('assets.put', { base64, mimeType: snapshot.type });
    try { return validateId(result, 'Asset ID'); } catch (error) { throw protocolError(error); }
  }

  async getAsset(id: string): Promise<Blob> {
    validateId(id);
    return blobFromReply(await this.transport.request('assets.get', { id }));
  }

  async getPreference<T>(key: string, fallback: T): Promise<T> {
    validatePreferenceKey(key);
    const snapshot = jsonSnapshot(fallback, WORKSPACE_LIMITS.preferenceBytes, 'Preference fallback').value;
    const result = await this.transport.request('preferences.get', { key, fallback: snapshot });
    try { return jsonSnapshot(result, WORKSPACE_LIMITS.preferenceBytes, 'Preference response').value as T; }
    catch (error) { throw protocolError(error); }
  }

  async setPreference<T>(key: string, value: T): Promise<void> {
    validatePreferenceKey(key);
    const snapshot = jsonSnapshot(value, WORKSPACE_LIMITS.preferenceBytes, 'Preference').value;
    const result = await this.transport.request('preferences.set', { key, value: snapshot });
    if (result !== null) throw protocolError(undefined);
  }
}
