import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorkspaceId, type DocumentRecord } from '../../packages/sdk';
import { errorCode, errorMessage, store } from './workspace';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
export function useDocumentDraft(record: DocumentRecord, onCommitted: (record: DocumentRecord) => void) {
  const [title, setTitle] = useState(record.title);
  const [data, setData] = useState(record.data);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [message, setMessage] = useState('');
  const draft = useRef({ title: record.title, data: record.data });
  const revision = useRef(record.revision);
  const edit = useRef(0), saved = useRef(0), blocked = useRef(false);
  const saving = useRef<Promise<boolean> | null>(null);
  const pendingCommit = useRef<{ version: number; input: { id: string; expectedRevision: number; operationId: string; title: string; data: unknown } } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const committed = useRef(onCommitted);
  committed.current = onCommitted;
  const updateStatus = (value: SaveStatus, error = '') => { if (mounted.current) { setStatus(value); setMessage(error); } };

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    // All callers share one draining loop. Starting a second loop after waiting
    // could race a newer edit and its expected revision.
    if (saving.current) return saving.current;
    if (blocked.current) return false;
    if (saved.current === edit.current) return true;
    const work = async () => {
      while (saved.current < edit.current) {
        // Retain the exact operation after an ambiguous transport failure. If
        // the host committed but its reply was lost, a retry retrieves that ack.
        if (!pendingCommit.current) pendingCommit.current = { version: edit.current, input: { id: record.id, expectedRevision: revision.current, operationId: createWorkspaceId(), title: draft.current.title.trim() || 'Untitled', data: draft.current.data } };
        const operation = pendingCommit.current;
        updateStatus('saving');
        try {
          const result = await store.commit(operation.input);
          revision.current = result.revision;
          saved.current = operation.version;
          pendingCommit.current = null;
          committed.current(result);
        } catch (error) {
          const code = errorCode(error);
          // Definitive rejections did not commit. A user may fix an oversized
          // draft and retry a new payload; only ambiguous failures reuse it.
          if (['E_VALIDATION', 'E_POLICY', 'E_NOT_FOUND', 'E_CONFLICT'].includes(code)) pendingCommit.current = null;
          blocked.current = true;
          updateStatus(code === 'E_CONFLICT' ? 'conflict' : 'error', errorMessage(error));
          return false;
        }
      }
      updateStatus('saved');
      return true;
    };
    saving.current = work();
    try { return await saving.current; } finally { saving.current = null; }
  }, [record.id]);

  const change = useCallback((next: { title?: string; data?: unknown }) => {
    draft.current = { ...draft.current, ...next };
    if (next.title !== undefined) setTitle(next.title);
    if ('data' in next) setData(next.data);
    edit.current++;
    clearTimeout(timer.current);
    if (!blocked.current) { setStatus('dirty'); timer.current = setTimeout(() => { void flush(); }, 650); }
  }, [flush]);

  const retry = async () => { blocked.current = false; return flush(); };
  const reload = async () => {
    const latest = await store.read(record.id);
    draft.current = { title: latest.title, data: latest.data };
    revision.current = latest.revision;
    edit.current = 0; saved.current = 0; blocked.current = false; pendingCommit.current = null;
    setTitle(latest.title); setData(latest.data);
    committed.current(latest); updateStatus('saved');
  };
  const saveCopy = async () => {
    const copy = await store.create({ kind: record.kind, title: `${draft.current.title.slice(0, 228)} (copy)`, data: draft.current.data });
    saved.current = edit.current; blocked.current = false; pendingCommit.current = null; updateStatus('saved');
    return copy;
  };
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (saved.current !== edit.current) { event.preventDefault(); event.returnValue = ''; } };
    const visibility = () => { if (document.visibilityState === 'hidden') void flush(); };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', visibility);
    return () => { mounted.current = false; clearTimeout(timer.current); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('visibilitychange', visibility); };
  }, [flush]);
  return { title, data, status, message, change, flush, retry, reload, saveCopy };
}
