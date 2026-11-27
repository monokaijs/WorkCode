import { invalid, WorkspaceError } from './errors';
import { WORKSPACE_LIMITS, type CommitDocumentInput, type CreateDocumentInput, type DocumentKind, type DocumentRecord, type JsonValue } from './types';
import { sha256 } from '@noble/hashes/sha2.js';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object.`);
  if (Object.getOwnPropertySymbols(value).length) invalid(`${label} cannot contain symbol properties.`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (UNSAFE_KEYS.has(key) || !descriptor.enumerable || !('value' in descriptor)) invalid(`${label} contains an unsupported property.`);
  }
}

export function exactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  assertRecord(value, label);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid(`${label} has an unexpected or missing field.`);
}

export function validateId(value: unknown, label = 'ID'): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(`${label} must be an opaque UUID.`);
  return value;
}

export function newId(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new WorkspaceError('E_UNAVAILABLE', 'Secure random identifiers are unavailable in this environment.');
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid('Expected revision must be a positive safe integer.');
  return value as number;
}

export function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Array.from(value).length > WORKSPACE_LIMITS.titleCharacters || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid(`Title must contain 1–${WORKSPACE_LIMITS.titleCharacters} characters without control characters.`);
  }
  return value;
}

export function validateKind(value: unknown): DocumentKind {
  if (value !== 'note' && value !== 'code' && value !== 'pdf') invalid('Document kind must be note, code or pdf.');
  return value;
}

export function validatePreferenceKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > WORKSPACE_LIMITS.preferenceKeyCharacters || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || UNSAFE_KEYS.has(value)) invalid('Preference key is invalid.');
  return value;
}

/**
 * Clone JSON before the first await, rejecting getters, exotic objects, cycles,
 * non-finite numbers and dangerous keys. Sorting keys makes retries deterministic.
 */
export function jsonSnapshot(value: unknown, maxBytes: number, label = 'Data'): { value: JsonValue; canonical: string } {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  function spend(count: number): void {
    bytes += count;
    if (bytes > maxBytes) invalid(`${label} exceeds its ${maxBytes}-byte limit.`);
  }
  function visit(item: unknown, depth: number): JsonValue {
    if (++nodes > WORKSPACE_LIMITS.jsonNodes || depth > WORKSPACE_LIMITS.jsonDepth) invalid(`${label} is too complex.`);
    if (item === null || typeof item === 'boolean') { spend(JSON.stringify(item).length); return item; }
    if (typeof item === 'string') {
      if (item.length > maxBytes) invalid(`${label} exceeds its size limit.`);
      spend(encoder.encode(JSON.stringify(item)).byteLength);
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid(`${label} must contain finite numbers.`);
      spend(JSON.stringify(item).length);
      return item;
    }
    if (typeof item !== 'object') invalid(`${label} must be JSON-compatible.`);
    if (ancestors.has(item)) invalid(`${label} cannot contain cycles.`);
    ancestors.add(item);
    let result: JsonValue;
    if (Array.isArray(item)) {
      if (item.length > WORKSPACE_LIMITS.jsonNodes || Object.getOwnPropertySymbols(item).length) invalid(`${label} contains an unsupported array.`);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(descriptors).filter(key => key !== 'length');
      if (keys.length !== item.length || keys.some((key, i) => key !== String(i) || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) invalid(`${label} arrays must be dense without extra properties.`);
      spend(2 + Math.max(0, keys.length - 1));
      result = keys.map(key => visit(descriptors[key]!.value, depth + 1));
    } else {
      assertRecord(item, label);
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const object: Record<string, JsonValue> = {};
      const keys = Object.keys(descriptors).sort();
      spend(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (key.length > maxBytes) invalid(`${label} contains an oversized key.`);
        spend(encoder.encode(JSON.stringify(key)).byteLength + 1);
        object[key] = visit(descriptors[key]!.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(item);
    return result;
  }
  try {
    const copy = visit(value, 0);
    const canonical = JSON.stringify(copy);
    if (new TextEncoder().encode(canonical).byteLength > maxBytes) invalid(`${label} exceeds its ${maxBytes}-byte limit.`);
    return { value: copy, canonical };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError('E_VALIDATION', `${label} is not a supported JSON value.`, error);
  }
}

export function validateCreate(input: unknown): CreateDocumentInput {
  exactKeys(input, ['kind', 'title', 'data'], 'Create request');
  return { kind: validateKind(input.kind), title: validateTitle(input.title), data: jsonSnapshot(input.data, WORKSPACE_LIMITS.documentBytes).value };
}

export function validateCommit(input: unknown): CommitDocumentInput {
  exactKeys(input, ['id', 'expectedRevision', 'operationId', 'title', 'data'], 'Commit request');
  return {
    id: validateId(input.id), expectedRevision: validateRevision(input.expectedRevision),
    operationId: validateId(input.operationId, 'Operation ID'), title: validateTitle(input.title),
    data: jsonSnapshot(input.data, WORKSPACE_LIMITS.documentBytes).value,
  };
}

export function validateDocument(value: unknown): DocumentRecord {
  exactKeys(value, ['id', 'kind', 'title', 'revision', 'createdAt', 'updatedAt', 'data'], 'Document');
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[field] !== 'string' || !ISO_DATE_PATTERN.test(value[field]) || !Number.isFinite(Date.parse(value[field]))) invalid(`Document ${field} must be an ISO8601 date.`);
  }
  return {
    id: validateId(value.id), kind: validateKind(value.kind), title: validateTitle(value.title), revision: validateRevision(value.revision),
    createdAt: value.createdAt as string, updatedAt: value.updatedAt as string,
    data: jsonSnapshot(value.data, WORKSPACE_LIMITS.documentBytes).value,
  };
}

export function validateMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 127 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value)) invalid('Asset MIME type is invalid.');
  return value.toLowerCase();
}

export function validateBlob(blob: unknown): Blob {
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) invalid('Asset must be a Blob.');
  if (blob.size > WORKSPACE_LIMITS.assetBytes) invalid('Assets cannot exceed 20 MiB.');
  const mime = validateMimeType(blob.type || 'application/octet-stream');
  return blob.slice(0, blob.size, mime);
}

export async function canonicalHash(value: unknown): Promise<string> {
  // Callers pass a validated immutable snapshot, with sorted JSON object keys.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  // HTTP LAN testing can lack subtle even though getRandomValues is available.
  // Use the same standard digest, without maintaining a custom hash function.
  const hash = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    : sha256(bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
