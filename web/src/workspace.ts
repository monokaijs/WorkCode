import { createWorkspaceStore, type DocumentRecord } from '../../packages/sdk';

export const store = createWorkspaceStore();
export type AppId = 'files' | 'code' | 'pdf';
export interface CodeData { text: string; language: string }
export interface PDFData { assetId: string; fileName: string; size: number }
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Something went wrong. Your existing files have been kept.';
export const errorCode = (error: unknown): string => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

let bootPromise: Promise<DocumentRecord[]> | undefined;
export function bootstrap(): Promise<DocumentRecord[]> {
  const initialize = async () => {
    const documents = await store.list();
    const initialized = await store.getPreference('workspace.initialized.v1', false);
    if (!initialized) {
      if (documents.length === 0) {
        documents.push(await store.create({ kind: 'code', title: 'hello-workspace.js', data: { language: 'javascript', text: '// Your ideas start here.\n// Save this file to a project to run it in Code.\n\nfunction greet(name) {\n  return `Hello, ${name}. Make something useful.`;\n}\n\nconst message = greet("Workspace");\nconsole.log(message);\n' } }));
      }
      // The preference survives deleting every document: an empty workspace stays empty.
      await store.setPreference('workspace.initialized.v1', true);
    }
    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  if (!bootPromise) {
    const boot = store.durability === 'browser-local' && navigator.locks?.request
      ? navigator.locks.request('workspace-initialize-v1', initialize).then(value => value)
      : initialize();
    bootPromise = boot.catch(error => { bootPromise = undefined; throw error; });
  }
  return bootPromise;
}

export function humanDate(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 'Recently' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parsed);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function exportDocument(record: DocumentRecord) {
  const title = record.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'Untitled';
  if (record.kind === 'pdf') {
    const data = record.data as PDFData;
    downloadBlob(await store.getAsset(data.assetId), data.fileName || `${title}.pdf`);
  } else if (record.kind === 'code') {
    downloadBlob(new Blob([(record.data as CodeData).text], { type: 'text/plain;charset=utf-8' }), /\.[a-z0-9]+$/i.test(title) ? title : `${title}.txt`);
  } else {
    downloadBlob(new Blob([JSON.stringify({ format: 'workspace-note', version: 1, title: record.title, data: record.data }, null, 2)], { type: 'application/json' }), `${title}.workspace-note.json`);
  }
}

// Read older rich-text documents without modifying the stored content.
export function noteText(data: unknown): string {
  function textOf(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const { type, text, content } = node as { type?: string; text?: string; content?: unknown[] };
    if (type === 'text') return typeof text === 'string' ? text : '';
    if (type === 'hardBreak') return '\n';
    if (!Array.isArray(content)) return '';
    return content.map(textOf).join(['paragraph', 'heading', 'codeBlock'].includes(type ?? '') ? '' : '\n');
  }
  return data && typeof data === 'object' && 'content' in data ? textOf(data.content) : '';
}
