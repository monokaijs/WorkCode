import { useEffect, useRef } from 'react';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { editorPalette } from './editorPalette';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { nameOf, sourceFile } from '../../../packages/sdk/code-projects';
import type { LanguageAction, LanguageActions, Problem } from './languageTypes';

export interface EditorHandle {
  position(): number;
  reveal(line: number, column: number): void;
  replace(text: string): void;
}
interface Props {
  path: string;
  text: string;
  problems: Problem[];
  onChange(text: string): void;
  onCursor(line: number, column: number): void;
  register(handle: EditorHandle | null): void;
  query<K extends LanguageAction>(action: K, payload: LanguageActions[K][0]): Promise<LanguageActions[K][1]>;
  goToDefinition(position: number): void;
}

export const editorText = (text: string) => text.replace(/\r\n?/g, '\n');

export default function ProjectEditor(props: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const { path } = props;
  useEffect(() => {
    const supported = sourceFile(path);
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: current.current.text,
        extensions: [
          editorPalette,
          lineNumbers(), foldGutter(), lintGutter(), highlightActiveLine(),
          highlightActiveLineGutter(), history(), bracketMatching(), indentOnInput(), drawSelection(),
          rectangularSelection(), highlightSelectionMatches(), EditorState.allowMultipleSelections.of(true),
          supported ? javascript({ typescript: /\.[cm]?tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) }) : [],
          keymap.of([...completionKeymap, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.contentAttributes.of({
            'aria-label': `Editor for ${nameOf(path)}`, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(tx => tx.annotation(Transaction.userEvent) === 'code.disk')) {
              current.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const position = update.state.selection.main.head;
              const line = update.state.doc.lineAt(position);
              current.current.onCursor(line.number, position - line.from + 1);
            }
          }),
          supported ? autocompletion({ override: [async context => {
            const word = context.matchBefore(/[\p{L}\p{N}_$]*/u);
            if (!context.explicit && !word?.text && context.state.sliceDoc(context.pos - 1, context.pos) !== '.') return null;
            try {
              const options = await current.current.query('completion', { path, position: context.pos });
              return { from: word?.from ?? context.pos, options: options.map(option => ({
                label: option.label, apply: option.apply, type: option.kind,
              })) };
            } catch { return null; }
          }] }) : [],
          supported ? hoverTooltip(async (editor, position) => {
            try {
              const result = await current.current.query('hover', { path, position });
              if (!result || result.to > editor.state.doc.length) return null;
              return { pos: result.from, end: result.to, above: true, create: () => {
                const dom = document.createElement('pre');
                dom.className = 'code-hover';
                dom.textContent = result.text;
                return { dom };
              } };
            } catch { return null; }
          }) : [],
          EditorView.domEventHandlers({ mousedown(event, editor) {
            if (!supported || !(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
            const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
            if (position === null) return false;
            current.current.goToDefinition(position);
            return true;
          } }),
        ],
      }),
    });
    view.current = editor;
    current.current.register({
      position: () => editor.state.selection.main.head,
      replace: text => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: "input.rename" }),
      reveal(line, column) {
        const row = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
        const position = Math.min(row.to, row.from + Math.max(0, column - 1));
        editor.dispatch({ selection: EditorSelection.cursor(position), effects: EditorView.scrollIntoView(position, { y: 'center' }) });
        editor.focus();
      },
    });
    return () => { current.current.register(null); editor.destroy(); view.current = null; };
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.text },
      annotations: [Transaction.userEvent.of('code.disk'), Transaction.addToHistory.of(false)],
    });
  }, [props.text]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, props.problems
      .filter(problem => problem.from <= editor.state.doc.length && problem.to <= editor.state.doc.length)
      .map(problem => ({ from: problem.from, to: problem.to, severity: problem.severity, message: problem.message, source: 'TypeScript' }))));
  }, [props.problems]);

  return <div className="code-editor-surface" ref={parent} />;
}
