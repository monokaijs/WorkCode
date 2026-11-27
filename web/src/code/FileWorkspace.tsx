import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import ProjectEditor, { type EditorLanguage } from './ProjectEditor';
import { FileMark } from './ProjectTree';
import { SingleFileLayout } from './WorkbenchLayout';
import './code.css';

const languages: [EditorLanguage, string][] = [['javascript', 'JavaScript'], ['typescript', 'TypeScript'], ['plaintext', 'Plain text']];
export const editorLanguage = (value: string): EditorLanguage => value === 'typescript' || value === 'plaintext' ? value : 'javascript';

interface Props {
  label: string;
  name: string;
  title?: ReactNode;
  text: string;
  language: EditorLanguage;
  dirty: boolean;
  busy?: boolean;
  onChange(text: string): void;
  onLanguage(language: EditorLanguage): void;
  close(): void;
  actions: ReactNode;
  status: ReactNode;
  alerts?: ReactNode;
  children?: ReactNode;
}

/**
 * One file in the project workbench: the same header, editor island, tab,
 * editor and status bar, without the project's panels.
 */
export default function FileWorkspace(props: Props) {
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  return <section className="code-app code-file" aria-label={props.label} inert={props.busy} aria-busy={props.busy}>
    <SingleFileLayout project={{ content: <ArrowLeft size={18} />, onClick: props.close }}
      tab={<div className={`code-tab active ${props.dirty ? 'dirty' : ''}`} title={props.name}>
        <span className="code-tab-label"><FileMark path={props.name} />{props.title ?? <span>{props.name}</span>}</span>
        {props.dirty && <i className="code-dirty" aria-label="Unsaved" />}
      </div>}
      actions={<div className="code-file-actions">{props.actions}</div>}
      alerts={props.alerts}
      source={<ProjectEditor path={props.name} text={props.text} language={props.language} label="Code editor"
        onChange={props.onChange} onCursor={(line, column) => setCursor({ line, column })} />}
      status={<footer className="code-statusbar">
        {props.status}
        <span className="code-toolbar-fill" />
        <span>Ln {cursor.line}, Col {cursor.column}</span>
        <select className="code-language" aria-label="Code language" value={props.language}
          onChange={event => props.onLanguage(event.target.value as EditorLanguage)}>
          {languages.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select>
      </footer>}
    >{props.children}</SingleFileLayout>
  </section>;
}
