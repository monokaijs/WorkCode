import { useEffect, useRef, useState } from 'react';
import type { AppFile } from '../../../packages/sdk/app-context';
import CodeEditor from '../components/CodeEditor';
import CodeDialog from './CodeDialog';
import { downloadBlob, errorCode, errorMessage } from '../workspace';
import { codeApp, useDirtyState } from './appContext';
import './code.css';

export interface OpenFile { handle: AppFile; version: string; text: string }
export default function AppFileEditor({ file, registerGuard, close }: {
  file: OpenFile; registerGuard(fn: () => Promise<boolean>): () => void; close(): void;
}) {
  const [handle, setHandle] = useState(file.handle);
  const [canSaveAs, setCanSaveAs] = useState(false);
  const [saved, setSaved] = useState(file.text.replace(/\r\n?/g, '\n'));
  const [data, setData] = useState({ text: saved, language: /\.[cm]?tsx?$/i.test(handle.name) ? 'typescript'
    : /\.[cm]?jsx?$/i.test(handle.name) ? 'javascript' : 'plaintext' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [discard, setDiscard] = useState(false);
  const [reset, setReset] = useState(0);
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
    try {
      const lineEnding = file.text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
      const text = data.text.replaceAll('\n', lineEnding);
      if (copy && !canSaveAs) {
        downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), handle.name);
      } else {
        let expected = version.current;
        if (copy) {
          const target = await codeApp.files.pickSave(handle.name);
          destination = target.file;
          expected = target.version;
        }
        version.current = await codeApp.files.write(destination ?? handle, new TextEncoder().encode(text), expected);
        if (destination) { setHandle(destination); destination = undefined; }
      }
      setSaved(data.text);
    } catch (error) {
      if (errorCode(error) !== 'E_CANCELLED') setMessage(errorCode(error) === 'E_CONFLICT'
        ? 'This file changed on disk. Save a copy to keep your edits.' : errorMessage(error));
    } finally {
      if (destination) void codeApp.files.release(destination).catch(console.error);
      writing.current = false;
      setBusy(false);
    }
  }
  return <section className="code-app code-file" aria-label={handle.name}>
    <header className="code-toolbar">
      <button className="code-secondary" onClick={close}>Projects</button>
      <strong>{handle.name}</strong><span role="status">{dirty ? 'Unsaved changes' : ''}</span>
      <span className="code-toolbar-fill" />
      {handle.writable && <button className="code-primary" disabled={!dirty || busy} onClick={() => void save(false)}>Save</button>}
      <button className="code-secondary" disabled={busy} onClick={() => void save(true)}>{canSaveAs ? 'Save As' : 'Download copy'}</button>
    </header>
    {message && <div role="alert" className="code-conflict"><span>{message}</span>
      {dirty && <button disabled={busy} onClick={() => setDiscard(true)}>Discard edits…</button>}
    </div>}
    {discard && <CodeDialog title="Discard unsaved edits?" close={() => setDiscard(false)}>
      <p>Return to the last saved text in this editor.</p>
      <div className="code-dialog-actions">
        <button className="code-secondary" onClick={() => setDiscard(false)}>Cancel</button>
        <button className="code-primary code-danger" onClick={() => {
          setData({ ...data, text: saved }); setReset(value => value + 1);
          setMessage(''); setDiscard(false);
        }}>Discard edits</button>
      </div>
    </CodeDialog>}
    <CodeEditor data={data} resetToken={reset} onChange={setData} fileName={handle.name} />
  </section>;
}
