import { createElement, Fragment, type CSSProperties, type ReactNode } from 'react';
import initialize from './ui/workbench.wasm?init';

type Layout = { tag: string; className: string; control?: string; label?: string; children: (Layout | string)[] };
type Regions = Record<string, ReactNode>;
type Command = 'project' | 'tree' | 'panel' | 'tools' | 'search' | 'terminal' | 'actions';
type Binding = { content: ReactNode; onClick(): void; pressed?: boolean; disabled?: boolean };
type ProjectRegion =
  | 'explorer' | 'explorerDivider' | 'editor' | 'panelDivider' | 'bottom' | 'toolsDivider' | 'structure' | 'status' | 'children';

// Compile the small set of layout variations once. Only static element and
// region names cross the Wasm boundary. User content stays in React/CodeMirror.
const decoder = new TextDecoder();
const stack: Layout[] = [];
const decode = (ptr: number, length: number) => decoder.decode(new Uint8Array(memory.buffer, ptr, length));
const wasm = await initialize({ layout: {
  begin(tag: number, tagLength: number, cls: number, classLength: number) {
    const node = { tag: decode(tag, tagLength), className: decode(cls, classLength), children: [] };
    stack.at(-1)!.children.push(node);
    stack.push(node);
  },
  control(id: number, idLength: number, label: number, labelLength: number, cls: number, classLength: number) {
    stack.at(-1)!.children.push({ tag: 'button', className: decode(cls, classLength),
      control: decode(id, idLength), label: decode(label, labelLength), children: [] });
  },
  end() { stack.pop(); },
  region(ptr: number, length: number) { stack.at(-1)!.children.push(decode(ptr, length)); },
} });
const { memory, render_project, render_library } = wasm.exports as {
  memory: WebAssembly.Memory;
  render_project(tree: boolean, tools: boolean, panel: boolean, terminal: boolean): void;
  render_library(): void;
};
const cache = new Map<string, Layout>();
function layout(key: string, build: () => void) {
  let root = cache.get(key);
  if (!root) {
    root = { tag: '', className: '', children: [] };
    stack.push(root);
    try { build(); } finally { stack.length = 0; }
    cache.set(key, root);
  }
  return root;
}
function render(node: Layout, regions: Regions, commands: Record<string, Binding>, style?: CSSProperties): ReactNode[] {
  return node.children.map((child, index) => {
    if (typeof child === 'string') return <Fragment key={child}>{regions[child]}</Fragment>;
    if (child.control) {
      const binding = commands[child.control];
      return <button key={child.control} type="button" className={child.className} title={child.label}
        aria-label={child.label} aria-pressed={binding.pressed} disabled={binding.disabled}
        onClick={binding.onClick}>{binding.content}</button>;
    }
    const name = child.className.split(' ')[0];
    return createElement(child.tag, { className: child.className, key: name === 'code-toolbar-fill' ? name + index : name,
      style: name === 'code-work-area' ? style : undefined }, render(child, regions, commands, style));
  });
}
export function WorkbenchLayout({ tree, tools, panel, terminal, commands, style, ...regions }: Record<ProjectRegion, ReactNode> & {
  tree: boolean; tools: boolean; panel: boolean; terminal: boolean; commands: Record<Command, Binding>; style: CSSProperties;
}) {
  return render(layout(`project:${tree}:${tools}:${panel}:${terminal}`, () => render_project(tree, tools, panel, terminal)), regions, commands, style);
}
export function LibraryLayout(regions: Record<'language' | 'source' | 'status', ReactNode>) {
  return render(layout('library', render_library), regions, {});
}
