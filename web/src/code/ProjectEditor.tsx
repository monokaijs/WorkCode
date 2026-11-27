import { useEffect, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
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
export type EditorLanguage = 'javascript' | 'typescript' | 'plaintext';
interface Props {
  path: string;
  text: string;
  /** A library file keeps its language apart from its title. Project files go by their path. */
  language?: EditorLanguage;
  /** The editor's accessible name. A project tab names its file. */
  label?: string;
  problems?: Problem[];
  onChange(text: string): void;
  onCursor?(line: number, column: number): void;
  register?(handle: EditorHandle | null): void;
  /** The project's language service. A file opened by itself has none. */
  query?<K extends LanguageAction>(action: K, payload: LanguageActions[K][0]): Promise<LanguageActions[K][1]>;
  goToDefinition?(position: number): void;
}

export const editorText = (text: string) => text.replace(/\r\n?/g, '\n');
const noProblems: Problem[] = [];

/** How the editor reads a file: its grammar and whether the language service answers for it. */
function grammar({ path, language, query }: Props) {
  const kind = language ?? (sourceFile(path) ? /\.[cm]?tsx?$/i.test(path) ? 'typescript' : 'javascript' : 'plaintext');
  if (kind === 'plaintext') return null;
  // An explicit language also applies to untitled files.
  const jsx = language ? !/\.[cm]?ts$/i.test(path) : /\.[jt]sx$/i.test(path);
  return { typescript: kind === 'typescript', jsx, service: Boolean(query) && sourceFile(path) };
}

export default function ProjectEditor(props: Props) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const syntax = useRef(new Compartment()).current;
  const naming = useRef(new Compartment()).current;
  const applied = useRef('');
  const config = grammar(props);
  const configKey = JSON.stringify(config);
  const label = props.label ?? `Editor for ${nameOf(props.path)}`;

  /** The grammar, completion and hover for the file. Renaming a file swaps these in place. */
  function languageSupport(value: ReturnType<typeof grammar>) {
    if (!value) return [];
    const query: NonNullable<Props['query']> = (action, payload) => current.current.query!(action, payload);
    return [
      javascript({ typescript: value.typescript, jsx: value.jsx }),
      value.service ? autocompletion({ override: [async context => {
        const word = context.matchBefore(/[\p{L}\p{N}_$]*/u);
        if (!context.explicit && !word?.text && context.state.sliceDoc(context.pos - 1, context.pos) !== '.') return null;
        try {
          const options = await query('completion', { path: current.current.path, position: context.pos });
          return { from: word?.from ?? context.pos, options: options.map(option => ({
            label: option.label, apply: option.apply, type: option.kind,
          })) };
        } catch { return null; }
      }] }) : [],
      value.service ? hoverTooltip(async (editor, position) => {
        try {
          const result = await query('hover', { path: current.current.path, position });
          if (!result || result.to > editor.state.doc.length) return null;
          return { pos: result.from, end: result.to, above: true, create: () => {
            const dom = document.createElement('pre');
            dom.className = 'code-hover';
            dom.textContent = result.text;
            return { dom };
          } };
        } catch { return null; }
      }) : [],
      value.service ? EditorView.domEventHandlers({ mousedown(event, editor) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0 || !current.current.goToDefinition) return false;
        const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        current.current.goToDefinition(position);
        return true;
      } }) : [],
    ];
  }
  const attributes = (name: string) => EditorView.contentAttributes.of({
    'aria-label': name, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
  });

  // One view per document. Project tabs are keyed by path, so a project file
  // still gets a fresh view when it moves; a retitled library file does not.
  useEffect(() => {
    applied.current = configKey;
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: current.current.text,
        extensions: [
          editorPalette, current.current.language ? EditorView.lineWrapping : [],
          lineNumbers(), foldGutter(), lintGutter(), highlightActiveLine(),
          highlightActiveLineGutter(), history(), bracketMatching(), indentOnInput(), drawSelection(),
          rectangularSelection(), highlightSelectionMatches(), EditorState.allowMultipleSelections.of(true),
          syntax.of(languageSupport(config)),
          keymap.of([...completionKeymap, ...searchKeymap, ...foldKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          naming.of(attributes(label)),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(tx => tx.annotation(Transaction.userEvent) === 'code.disk')) {
              current.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const position = update.state.selection.main.head;
              const line = update.state.doc.lineAt(position);
              current.current.onCursor?.(line.number, position - line.from + 1);
            }
          }),
        ],
      }),
    });
    view.current = editor;
    current.current.register?.({
      position: () => editor.state.selection.main.head,
      replace: text => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, userEvent: "input.rename" }),
      reveal(line, column) {
        const row = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
        const position = Math.min(row.to, row.from + Math.max(0, column - 1));
        editor.dispatch({ selection: EditorSelection.cursor(position), effects: EditorView.scrollIntoView(position, { y: 'center' }) });
        editor.focus();
      },
    });
    return () => { current.current.register?.(null); editor.destroy(); view.current = null; };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || applied.current === configKey) return;
    applied.current = configKey;
    editor.dispatch({ effects: syntax.reconfigure(languageSupport(config)) });
  }, [configKey]);
  useEffect(() => {
    view.current?.dispatch({ effects: naming.reconfigure(attributes(label)) });
  }, [label]);
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.text },
      annotations: [Transaction.userEvent.of('code.disk'), Transaction.addToHistory.of(false)],
    });
  }, [props.text]);
  const problems = props.problems ?? noProblems;
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, problems
      .filter(problem => problem.from <= editor.state.doc.length && problem.to <= editor.state.doc.length)
      .map(problem => ({ from: problem.from, to: problem.to, severity: problem.severity, message: problem.message, source: 'TypeScript' }))));
  }, [problems]);

  return <div className="code-editor-surface" ref={parent} />;
}
