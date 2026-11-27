import { storageError, WorkspaceError } from '../core/errors';
import { WORKSPACE_LIMITS, type CommitDocumentInput, type CreateDocumentInput, type DocumentRecord, type WorkspaceStore } from '../core/types';
import { canonicalHash, jsonSnapshot, newId, validateBlob, validateCommit, validateCreate, validateDocument, validateId, validatePreferenceKey, validateRevision } from '../core/validation';

export const BROWSER_DATABASE_NAME = 'iphone-workspace-v1';
const DATABASE_VERSION = 1;
const DOCUMENTS = 'documents';
const OPERATIONS = 'operations';
const ASSETS = 'assets';
const PREFERENCES = 'preferences';

interface StoredOperation {
  id: string;
  documentId: string;
  requestHash: string;
  /** Hash-verified retries supply the original data; keep only acknowledgement metadata. */
  result: { revision: number; updatedAt: string } | null;
}

interface StoredAsset { id: string; blob: Blob; createdAt: string }
interface StoredPreference { key: string; value: unknown }

interface BrowserStoreOptions {
  /** Injectable solely for isolated tests or a separately named workspace database. */
  indexedDB?: IDBFactory;
  databaseName?: string;
}

type TransactionWork<T> = (transaction: IDBTransaction, success: (value: T) => void, failure: (error: unknown) => void, request: <R>(request: IDBRequest<R>, callback: (value: R) => void) => void) => void;

/**
 * Each write resolves only on IDBTransaction.complete. Request.success alone is
 * not a save acknowledgement. Browser-local persistence is still evictable.
 */
export class BrowserWorkspaceStore implements WorkspaceStore {
  readonly durability = 'browser-local' as const;
  private database: Promise<IDBDatabase> | undefined;
  private readonly databaseName: string;
  private readonly factory: IDBFactory | undefined;

  constructor(options: BrowserStoreOptions = {}) {
    this.databaseName = options.databaseName ?? BROWSER_DATABASE_NAME;
    this.factory = options.indexedDB;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const factory = this.factory ?? globalThis.indexedDB;
    if (!factory) return Promise.reject(new WorkspaceError('E_STORAGE', 'IndexedDB is unavailable. Use a browser with local storage enabled.'));
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let rejected = false;
      let request: IDBOpenDBRequest;
      try { request = factory.open(this.databaseName, DATABASE_VERSION); }
      catch (error) { reject(storageError(error, 'The local workspace database could not be opened.')); return; }
      request.onupgradeneeded = () => {
        try {
          const db = request.result;
          if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(OPERATIONS)) {
            const operations = db.createObjectStore(OPERATIONS, { keyPath: 'id' });
            operations.createIndex('documentId', 'documentId', { unique: false });
          }
          if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(PREFERENCES)) db.createObjectStore(PREFERENCES, { keyPath: 'key' });
        } catch (error) {
          rejected = true;
          request.transaction?.abort();
          reject(storageError(error, 'The local workspace database could not be initialized.'));
        }
      };
      request.onerror = () => {
        rejected = true;
        reject(storageError(request.error, 'The local workspace database could not be opened.'));
      };
      request.onblocked = () => {
        rejected = true;
        reject(new WorkspaceError('E_STORAGE', 'Another workspace tab is blocking a database upgrade. Close it and try again.'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (rejected) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.database = undefined; };
        db.onclose = () => { this.database = undefined; };
        resolve(db);
      };
    });
    this.database = opening;
    void opening.catch(() => { if (this.database === opening) this.database = undefined; });
    return opening;
  }

  /** Release this connection. Persisted records remain available to a new store. */
  async close(): Promise<void> {
    const opening = this.database;
    this.database = undefined;
    if (opening) (await opening).close();
  }

  private async transaction<T>(stores: string | string[], mode: IDBTransactionMode, work: TransactionWork<T>): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try { transaction = database.transaction(stores, mode); }
      catch (error) { reject(storageError(error)); return; }
      let result: T;
      let hasResult = false;
      let failure: WorkspaceError | undefined;
      const fail = (error: unknown) => {
        failure ??= storageError(error);
        try { transaction.abort(); } catch { reject(failure); }
      };
      const request = <R>(operation: IDBRequest<R>, callback: (value: R) => void) => {
        operation.onerror = () => fail(operation.error);
        operation.onsuccess = () => {
          try { callback(operation.result); } catch (error) { fail(error); }
        };
      };
      transaction.onabort = () => reject(failure ?? storageError(transaction.error, 'The workspace transaction was rolled back.'));
      transaction.onerror = () => { failure ??= storageError(transaction.error); };
      transaction.oncomplete = () => {
        if (failure) reject(failure);
        else if (!hasResult) reject(new WorkspaceError('E_STORAGE', 'The workspace transaction completed without a result.'));
        else resolve(result!);
      };
      try { work(transaction, value => { result = value; hasResult = true; }, fail, request); }
      catch (error) { fail(error); }
    });
  }

  private storedDocument(value: unknown): DocumentRecord {
    try { return validateDocument(value); }
    catch (error) { throw new WorkspaceError('E_STORAGE', 'A stored document has an unsupported or corrupt format.', error); }
  }

  async list(): Promise<DocumentRecord[]> {
    return this.transaction(DOCUMENTS, 'readonly', (tx, done, _fail, request) => {
      request(tx.objectStore(DOCUMENTS).getAll(), values => {
        const documents = values.map(value => this.storedDocument(value));
        documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        done(documents);
      });
    });
  }

  async read(id: string): Promise<DocumentRecord> {
    validateId(id);
    return this.transaction(DOCUMENTS, 'readonly', (tx, done, _fail, request) => {
      request(tx.objectStore(DOCUMENTS).get(id), value => {
        if (value === undefined) throw new WorkspaceError('E_NOT_FOUND', 'This document no longer exists.');
        done(this.storedDocument(value));
      });
    });
  }

  async create(input: CreateDocumentInput): Promise<DocumentRecord> {
    const snapshot = validateCreate(input);
    const timestamp = new Date().toISOString();
    const document: DocumentRecord = { ...snapshot, id: newId(), revision: 1, createdAt: timestamp, updatedAt: timestamp };
    return this.transaction(DOCUMENTS, 'readwrite', (tx, done, _fail, request) => {
      request(tx.objectStore(DOCUMENTS).add(document), () => done(document));
    });
  }

  async commit(input: CommitDocumentInput): Promise<DocumentRecord> {
    const snapshot = validateCommit(input);
    const hash = await canonicalHash(snapshot);
    return this.transaction([DOCUMENTS, OPERATIONS], 'readwrite', (tx, done, _fail, request) => {
      const documents = tx.objectStore(DOCUMENTS);
      const operations = tx.objectStore(OPERATIONS);
      request(operations.get(snapshot.operationId), (previous: StoredOperation | undefined) => {
        if (previous) {
          if (previous.requestHash !== hash || previous.documentId !== snapshot.id) throw new WorkspaceError('E_VALIDATION', 'An operation ID cannot be reused for a different edit.');
          if (previous.result === null) throw new WorkspaceError('E_NOT_FOUND', 'This document was deleted.');
          request(documents.get(snapshot.id), current => {
            if (current === undefined) throw new WorkspaceError('E_NOT_FOUND', 'This document no longer exists.');
            const original = previous.result!;
            done(this.storedDocument({
              ...this.storedDocument(current), title: snapshot.title, data: snapshot.data,
              revision: original.revision, updatedAt: original.updatedAt,
            }));
          });
          return;
        }
        request(documents.get(snapshot.id), value => {
          if (value === undefined) throw new WorkspaceError('E_NOT_FOUND', 'This document no longer exists.');
          const current = this.storedDocument(value);
          if (current.revision !== snapshot.expectedRevision) throw new WorkspaceError('E_CONFLICT', 'This document changed elsewhere. Reload before saving.');
          if (current.revision === Number.MAX_SAFE_INTEGER) throw new WorkspaceError('E_STORAGE', 'The document revision limit has been reached.');
          const document: DocumentRecord = {
            ...current, title: snapshot.title, data: snapshot.data, revision: current.revision + 1,
            updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString(),
          };
          request(documents.put(document), () => {
            const operation: StoredOperation = {
              id: snapshot.operationId, documentId: document.id, requestHash: hash,
              result: { revision: document.revision, updatedAt: document.updatedAt },
            };
            request(operations.add(operation), () => done(document));
          });
        });
      });
    });
  }

  async remove(id: string, expectedRevision: number): Promise<void> {
    validateId(id); validateRevision(expectedRevision);
    return this.transaction([DOCUMENTS, OPERATIONS], 'readwrite', (tx, done, _fail, request) => {
      const documents = tx.objectStore(DOCUMENTS);
      const operations = tx.objectStore(OPERATIONS);
      request(documents.get(id), value => {
        if (value === undefined) throw new WorkspaceError('E_NOT_FOUND', 'This document no longer exists.');
        if (this.storedDocument(value).revision !== expectedRevision) throw new WorkspaceError('E_CONFLICT', 'This document changed elsewhere. Reload before deleting.');
        request(documents.delete(id), () => {
          request(operations.index('documentId').openCursor(id), cursor => {
            if (!cursor) { done(undefined); return; }
            const operation = cursor.value as StoredOperation;
            cursor.update({ ...operation, result: null });
            cursor.continue();
          });
        });
      });
    });
  }

  async putAsset(blob: Blob): Promise<string> {
    const snapshot = validateBlob(blob);
    const asset: StoredAsset = { id: newId(), blob: snapshot, createdAt: new Date().toISOString() };
    return this.transaction(ASSETS, 'readwrite', (tx, done, _fail, request) => {
      request(tx.objectStore(ASSETS).add(asset), () => done(asset.id));
    });
  }

  async getAsset(id: string): Promise<Blob> {
    validateId(id);
    return this.transaction(ASSETS, 'readonly', (tx, done, _fail, request) => {
      request(tx.objectStore(ASSETS).get(id), (asset: StoredAsset | undefined) => {
        if (!asset) throw new WorkspaceError('E_NOT_FOUND', 'This asset no longer exists.');
        try { done(validateBlob(asset.blob)); }
        catch (error) { throw new WorkspaceError('E_STORAGE', 'The stored asset is corrupt or unsupported.', error); }
      });
    });
  }

  async getPreference<T>(key: string, fallback: T): Promise<T> {
    validatePreferenceKey(key);
    const snapshot = jsonSnapshot(fallback, WORKSPACE_LIMITS.preferenceBytes, 'Preference fallback').value;
    return this.transaction(PREFERENCES, 'readonly', (tx, done, _fail, request) => {
      request(tx.objectStore(PREFERENCES).get(key), (stored: StoredPreference | undefined) => {
        if (!stored) { done(snapshot as T); return; }
        try { done(jsonSnapshot(stored.value, WORKSPACE_LIMITS.preferenceBytes, 'Stored preference').value as T); }
        catch (error) { throw new WorkspaceError('E_STORAGE', 'The stored preference is corrupt or unsupported.', error); }
      });
    });
  }

  async setPreference<T>(key: string, value: T): Promise<void> {
    validatePreferenceKey(key);
    const snapshot = jsonSnapshot(value, WORKSPACE_LIMITS.preferenceBytes, 'Preference').value;
    return this.transaction(PREFERENCES, 'readwrite', (tx, done, _fail, request) => {
      request(tx.objectStore(PREFERENCES).put({ key, value: snapshot }), () => done(undefined));
    });
  }
}
