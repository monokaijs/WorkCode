import { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { AppFile } from '../../../packages/sdk/app-context';
import CodeDialog from './CodeDialog';
import FileWorkspace from './FileWorkspace';
import { editorText, type EditorLanguage } from './ProjectEditor';
import { downloadBlob, errorCode, errorMessage } from '../workspace';
import { codeApp, useDirtyState } from './appContext';

export interface OpenFile { handle: AppFile; version: string; text: string }
/** A file from outside Code. It saves only when asked, and never over a newer version. */
export default function AppFileEditor({ file, registerGuard, close }: {
  file: OpenFile; registerGuard(fn: () => Promise<boolean>): () => void; close(): void;
}) {
  const [handle, setHandle] = useState(file.handle);
  const [canSaveAs, setCanSaveAs] = useState(false);
  const [saved, setSaved] = useState(editorText(file.text));
  const [data, setData] = useState<{ text: string; language: EditorLanguage }>({ text: saved, language: /\.[cm]?tsx?$/i.test(handle.name) ? 'typescript'
    : /\.[cm]?jsx?$/i.test(handle.name) ? 'javascript' : 'plaintext' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [discard, setDiscard] = useState(false);
  const version = useRef(file.version);
  const writing = useRef(false);
  const dirty = data.text !== saved;
  useDirtyState(dirty);
  useEffect(() => {
    void codeApp.supports('files.pickSave').then(setCanSaveAs).catch(error => setMessage(errorMessage(error)));
  }, []);
  useEffect(() => () => { void codeApp.files.release(handle).catch(console.error); }, [handle]);
  useEffect(() => registerGuard(async () => {
    if (dirty) setMessage('Save your changes before leaving this file.');
    return !dirty && !writing.current;
  }), [registerGuard, dirty]);

  async function save(copy: boolean) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setMessage('');
    let destination: AppFile | undefined;
    const text = data.text;
    try {
      const lineEnding = file.text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      const encoded = text.replaceAll('\n', lineEnding);
      if (copy && !canSaveAs) {
        downloadBlob(new Blob([encoded], { type: 'text/plain;charset=utf-8' }), handle.name);
      } else {
        let expected = version.current;
        if (copy) {
          const target = await codeApp.files.pickSave(handle.name);
          destination = target.file;
          expected = target.version;
        }
        version.current = await codeApp.files.write(destination ?? handle, new TextEncoder().encode(encoded), expected);
        if (destination) { setHandle(destination); destination = undefined; }
      }
      setSaved(text);
    } catch (error) {
      if (errorCode(error) !== 'E_CANCELLED') setMessage(errorCode(error) === 'E_CONFLICT'
        ? 'This file changed on disk. Save a copy to keep your edits.' : errorMessage(error));
    } finally {
      if (destination) void codeApp.files.release(destination).catch(console.error);
      writing.current = false;
      setBusy(false);
    }
  }
  return <FileWorkspace label={handle.name} name={handle.name} text={data.text} language={data.language} dirty={dirty}
    onChange={text => setData(previous => ({ ...previous, text }))} onLanguage={language => setData(previous => ({ ...previous, language }))}
    close={close}
    actions={<>
      {handle.writable && <button type="button" className="code-primary" disabled={!dirty || busy} onClick={() => void save(false)}>Save</button>}
      <button type="button" className="code-secondary" disabled={busy} onClick={() => void save(true)}>{canSaveAs ? 'Save As' : 'Download copy'}</button>
    </>}
    alerts={message && <div role="alert" className="code-conflict"><AlertCircle size={14} /><span>{message}</span>
      {dirty && <button type="button" disabled={busy} onClick={() => setDiscard(true)}>Discard edits…</button>}
    </div>}
    status={<span className={`code-save-state ${message ? 'warn' : ''}`} role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : ''}</span>}>
    {discard && <CodeDialog title="Discard unsaved edits?" close={() => setDiscard(false)}>
      <p>Return to the last saved text in this editor.</p>
      <div className="code-dialog-actions">
        <button className="code-secondary" onClick={() => setDiscard(false)}>Cancel</button>
        <button className="code-primary code-danger" onClick={() => {
          setData(previous => ({ ...previous, text: saved }));
          setMessage(''); setDiscard(false);
        }}>Discard edits</button>
      </div>
    </CodeDialog>}
  </FileWorkspace>;
}
