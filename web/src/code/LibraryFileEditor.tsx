import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, Check, FolderInput } from 'lucide-react';
import type { DocumentRecord } from '../../../packages/sdk';
import CodeEditor from '../components/CodeEditor';
import { useDocumentDraft } from '../useDocumentDraft';
import { errorMessage, store, type CodeData } from '../workspace';
import { useDirtyState } from './appContext';
import type { LibraryCopy } from './CodeWorkbench';
import './code.css';

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

export default function LibraryFileEditor({ record, registerGuard, onCommitted, onCopy, onExport, onSaveToProject, ask, notify, close }: Props) {
  const draft = useDocumentDraft(record, onCommitted);
  const [resolving, setResolving] = useState(false);
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

  return <section className="code-app code-file" aria-label="Code file editor" inert={resolving} aria-busy={resolving}>
    <header className="code-toolbar">
      <button className="code-icon" title="Projects" aria-label="Projects" onClick={close}><ArrowLeft size={18} /></button>
      <input className="code-file-title" aria-label="Document title" data-testid="document-title" maxLength={240}
        value={draft.title} placeholder="Untitled" onChange={event => draft.change({ title: event.target.value })} />
      <button className="code-icon" title="Save to Project" aria-label="Save to Project" onClick={() => void share('project')}><FolderInput size={18} /></button>
      <button className="code-icon" title="Export document" aria-label="Export document" onClick={() => void share('export')}><ArrowDownToLine size={18} /></button>
    </header>
    {(draft.status === 'conflict' || draft.status === 'error') && <div className="code-conflict" role="alert">
      <span>{draft.message}</span>
      <button onClick={() => void resolve('copy')}>Save as copy</button>
      <button onClick={() => void resolve('reload')}>Reload saved version</button>
      {draft.status === 'error' && <button onClick={() => void resolve('retry')}>Retry save</button>}
    </div>}
    <CodeEditor data={draft.data as CodeData} resetToken={draft.resetToken} onChange={data => draft.change({ data })}
      status={<span className="code-save-state" role="status" data-testid="save-status">
        {draft.status === 'saved' && <Check size={14} />}{status}
      </span>} />
  </section>;
}
