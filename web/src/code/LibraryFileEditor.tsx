import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Check, FolderInput, LoaderCircle } from 'lucide-react';
import type { DocumentRecord } from '../../../packages/sdk';
import { useDocumentDraft } from '../useDocumentDraft';
import { errorMessage, store, type CodeData } from '../workspace';
import { useDirtyState } from './appContext';
import type { LibraryCopy } from './CodeWorkbench';
import FileWorkspace, { editorLanguage } from './FileWorkspace';

interface Props {
  record: DocumentRecord;
  registerGuard(guard: () => Promise<boolean>): () => void;
  onCommitted(record: DocumentRecord): void;
  onCopy(record: DocumentRecord): Promise<void>;
  onExport(record: DocumentRecord): Promise<void>;
  onSaveToProject(copy: LibraryCopy): void;
  ask(options: { title: string; message: string; confirmLabel: string; danger: boolean }): Promise<boolean>;
  notify(message: string, type: 'info' | 'error'): void;
  close(): void;
}

/** A library file in the Code workbench. Edits save themselves, as drafts. */
export default function LibraryFileEditor({ record, registerGuard, onCommitted, onCopy, onExport, onSaveToProject, ask, notify, close }: Props) {
  const draft = useDocumentDraft(record, onCommitted);
  const [resolving, setResolving] = useState(false);
  const data = draft.data as CodeData;
  // Keystrokes can arrive before React renders the previous one.
  const latest = useRef(data);
  latest.current = data;
  useDirtyState(draft.status !== 'saved');
  useEffect(() => registerGuard(draft.flush), [registerGuard, draft.flush]);

  async function resolve(action: 'copy' | 'reload' | 'retry') {
    if (action === 'reload' && !await ask({ title: 'Reload the saved version?', message: 'Your unsaved changes in this editor will be replaced. Save a copy first if you want to keep both versions.', confirmLabel: 'Reload saved version', danger: true })) return;
    setResolving(true);
    try {
      if (action === 'copy') await onCopy(await draft.saveCopy());
      else if (action === 'reload') await draft.reload();
      else await draft.retry();
    } catch (error) { notify(errorMessage(error), 'error'); }
    finally { setResolving(false); }
  }

  async function share(action: 'project' | 'export') {
    if (!await draft.flush()) { notify('Resolve the save conflict or save a copy first.', 'info'); return; }
    try {
      const saved = await store.read(record.id);
      if (action === 'project') onSaveToProject({ name: saved.title, text: (saved.data as CodeData).text });
      else await onExport(saved);
    } catch (error) { notify(errorMessage(error), 'error'); }
  }

  const status = {
    saved: store.durability === 'browser-local' ? 'Saved in this browser' : 'Saved on device',
    saving: 'Saving…', dirty: 'Unsaved changes', conflict: 'Another version exists', error: 'Save needs attention',
  }[draft.status];
  const blocked = draft.status === 'conflict' || draft.status === 'error';
  const change = (next: Partial<CodeData>) => {
    latest.current = { ...latest.current, ...next };
    draft.change({ data: latest.current });
  };

  return <FileWorkspace label="Code file editor" name={draft.title.trim() || 'Untitled'} busy={resolving}
    text={data.text} language={editorLanguage(data.language)} dirty={draft.status !== 'saved'}
    onChange={text => change({ text })} onLanguage={language => change({ language })} close={close}
    title={<input className="code-tab-title" aria-label="Document title" data-testid="document-title" maxLength={240}
      size={Math.max(8, draft.title.length + 1)} spellCheck={false} autoCapitalize="off" autoCorrect="off"
      value={draft.title} placeholder="Untitled" onChange={event => draft.change({ title: event.target.value })} />}
    actions={<>
      <button type="button" className="code-icon" title="Save to Project" aria-label="Save to Project" onClick={() => void share('project')}><FolderInput size={16} /></button>
      <button type="button" className="code-icon" title="Export document" aria-label="Export document" onClick={() => void share('export')}><ArrowDownToLine size={16} /></button>
    </>}
    alerts={blocked && <div className="code-conflict" role="alert">
      <AlertCircle size={14} /><span>{draft.message}</span>
      <button type="button" disabled={resolving} onClick={() => void resolve('copy')}>Save as copy</button>
      <button type="button" disabled={resolving} onClick={() => void resolve('reload')}>Reload saved version</button>
      {draft.status === 'error' && <button type="button" disabled={resolving} onClick={() => void resolve('retry')}>Retry save</button>}
    </div>}
    status={<span className={`code-save-state ${blocked ? 'warn' : ''}`} role="status" data-testid="save-status">
      {draft.status === 'saved' ? <Check size={12} /> : draft.status === 'saving' ? <LoaderCircle size={12} className="spin" /> : null}{status}
    </span>} />;
}
