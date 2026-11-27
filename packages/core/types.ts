/** Engine-specific document data stays opaque to the workspace persistence layer. */
export type DocumentKind = 'note' | 'code' | 'pdf';

export interface DocumentRecord {
  id: string;
  kind: DocumentKind;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  data: unknown;
}

export interface CreateDocumentInput {
  kind: DocumentKind;
  title: string;
  data: unknown;
}

export interface CommitDocumentInput {
  id: string;
  expectedRevision: number;
  /** A new UUID for each logical edit; reuse it only to retry that exact edit. */
  operationId: string;
  title: string;
  data: unknown;
}

export interface WorkspaceStore {
  /** Browser storage remains subject to browser quota, eviction and user clearing. */
  readonly durability: 'browser-local' | 'host-committed';
  list(): Promise<DocumentRecord[]>;
  read(id: string): Promise<DocumentRecord>;
  create(input: CreateDocumentInput): Promise<DocumentRecord>;
  commit(input: CommitDocumentInput): Promise<DocumentRecord>;
  remove(id: string, expectedRevision: number): Promise<void>;
  putAsset(blob: Blob): Promise<string>;
  getAsset(id: string): Promise<Blob>;
  getPreference<T>(key: string, fallback: T): Promise<T>;
  setPreference<T>(key: string, value: T): Promise<void>;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const WORKSPACE_LIMITS = Object.freeze({
  documentBytes: 1024 * 1024,
  preferenceBytes: 256 * 1024,
  assetBytes: 20 * 1024 * 1024,
  titleCharacters: 240,
  preferenceKeyCharacters: 128,
  jsonDepth: 64,
  jsonNodes: 100_000,
  nativeTimeoutMs: 30_000,
});

export interface NativeRequest {
  protocolVersion: 1;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

/** WKScriptMessageHandlerWithReply exposes a Promise-returning postMessage. */
export interface NativeMessageHandler {
  postMessage(request: NativeRequest): Promise<unknown>;
}
