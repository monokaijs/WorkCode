import { useEffect, useRef, type ReactNode } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import type { CodeData } from '../workspace';
import { LibraryLayout } from '../code/WorkbenchLayout';
import { editorPalette } from '../code/editorPalette';

export default function CodeEditor({ data, resetToken, onChange, status }: { status?: ReactNode; data: CodeData; resetToken: number; onChange: (value: CodeData) => void }) {
  const container = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null);
  const change = useRef(onChange), current = useRef(data), mode = useRef(new Compartment());
  const replacing = useRef(false);
  change.current = onChange; current.current = data;
  useEffect(() => {
    if (!container.current) return;
    const instance = new EditorView({
      parent: container.current,
      state: EditorState.create({ doc: current.current.text, extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(), highlightActiveLineGutter(), bracketMatching(), indentOnInput(),
        editorPalette, EditorView.lineWrapping,
        mode.current.of(current.current.language === 'plaintext' ? [] : javascript({ typescript: current.current.language === 'typescript', jsx: true })),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': 'Code editor', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        EditorView.updateListener.of(update => { if (update.docChanged && !replacing.current) change.current({ ...current.current, text: update.state.doc.toString() }); }),
      ] }),
    });
    view.current = instance;
    return () => { instance.destroy(); view.current = null; };
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: mode.current.reconfigure(data.language === 'plaintext' ? [] : javascript({ typescript: data.language === 'typescript', jsx: true })) }); }, [data.language]);
  useEffect(() => { const instance = view.current; if (instance && instance.state.doc.toString() !== data.text) { replacing.current = true; try { instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: data.text } }); } finally { replacing.current = false; } } }, [resetToken]);
  return <LibraryLayout
    language={null}
    source={<div className="code-editor-surface" ref={container} />}
    status={<footer className="code-statusbar">
      {status}
      <span className="code-toolbar-fill" />
      <span>{data.text.split('\n').length.toLocaleString()} {data.text.includes('\n') ? 'lines' : 'line'}</span>
      <select aria-label="Code language" value={data.language} onChange={event => onChange({ ...data, language: event.target.value })}>
        <option value="javascript">JavaScript</option><option value="typescript">TypeScript</option><option value="plaintext">Plain text</option>
      </select>
    </footer>} />;
}
