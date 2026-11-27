import ts from 'typescript-service';
import { standardLibrary } from './standardLibrary';
import type { LanguageAction, LanguageActions, Location, Problem, OutlineItem } from './languageTypes';

const root = '/project/';
const libraries = { ...standardLibrary, '/lib/workos.d.ts': 'declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void; };' } as Record<string, string>;
let files = new Map<string, { text: string; version: number }>();
let version = 0;
const defaults: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true, checkJs: true, strict: true, allowImportingTsExtensions: true, noEmit: true,
  jsx: ts.JsxEmit.Preserve, skipLibCheck: true, types: [],
};
let options = defaults;
const textAt = (path: string) => files.get(path)?.text ?? libraries[path];
const sourceFile = (path: string) => /\.[cm]?[jt]sx?$/i.test(path);
const service = ts.createLanguageService({
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...Array.from(files.keys()).filter(sourceFile), '/lib/workos.d.ts'],
  getScriptVersion: path => String(files.get(path)?.version ?? 0),
  getProjectVersion: () => String(version),
  getScriptSnapshot: path => {
    const text = textAt(path);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => root,
  getDefaultLibFileName: () => '/lib/lib.es2022.d.ts',
  fileExists: path => textAt(path) !== undefined,
  readFile: textAt,
  useCaseSensitiveFileNames: () => true,
});

function sync(snapshot: Record<string, string>) {
  let changed = files.size !== Object.keys(snapshot).length;
  const next = new Map<string, { text: string; version: number }>();
  for (const [relative, text] of Object.entries(snapshot)) {
    const path = root + relative;
    const old = files.get(path);
    if (old?.text === text) next.set(path, old);
    else { changed = true; next.set(path, { text, version: version + 1 }); }
  }
  if (!changed) return;
  files = next;
  version++;
  const config = files.get(root + 'tsconfig.json');
  const parsed = config && ts.parseConfigFileTextToJson('tsconfig.json', config.text);
  const selected = parsed?.config?.compilerOptions;
  const converted = selected && ts.convertCompilerOptionsFromJson(selected, root);
  options = { ...defaults, ...converted?.options, allowJs: true, noEmit: true, lib: undefined, types: [] };
}

function location(fileName: string, position: number): Location | undefined {
  if (!fileName.startsWith(root)) return;
  const source = service.getProgram()?.getSourceFile(fileName);
  if (!source) return;
  const { line, character } = source.getLineAndCharacterOfPosition(position);
  return { path: fileName.slice(root.length), line: line + 1, column: character + 1 };
}

function problems(): Problem[] {
  const result: Problem[] = [];
  for (const path of files.keys()) {
    if (!sourceFile(path)) continue;
    for (const item of [...service.getSyntacticDiagnostics(path), ...service.getSemanticDiagnostics(path)]) {
      const from = item.start ?? 0;
      const at = location(path, from);
      if (at) result.push({ ...at, from, to: from + (item.length ?? 0),
        message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
        severity: item.category === ts.DiagnosticCategory.Error ? 'error' : 'warning' });
      if (result.length >= 1000) return result;
    }
  }
  return result;
}

function outline(path: string): OutlineItem[] {
  const result: OutlineItem[] = [];
  if (!files.has(root + path)) return result;
  const visit = (item: ts.NavigationTree, depth: number) => {
    for (const child of item.childItems ?? []) {
      // Skip the anonymous wrappers TypeScript adds for callbacks and object literals.
      if (child.kind === ts.ScriptElementKind.unknown || /^<.*>$/.test(child.text)) continue;
      const span = child.nameSpan ?? child.spans[0];
      const at = location(root + path, span.start);
      if (at) result.push({ ...at, name: child.text, kind: child.kind, depth });
      if (result.length >= 2000) return;
      if (child.kind !== ts.ScriptElementKind.variableElement && child.kind !== ts.ScriptElementKind.constElement
        && child.kind !== ts.ScriptElementKind.letElement) visit(child, depth + 1);
    }
  };
  visit(service.getNavigationTree(root + path), 0);
  return result;
}

const actions: { [K in LanguageAction]: (payload: LanguageActions[K][0]) => LanguageActions[K][1] } = {
  sync: ({ files }) => sync(files),
  problems,
  completion: ({ path, position }) => service.getCompletionsAtPosition(root + path, position, {
    includeCompletionsForModuleExports: false, includeInsertTextCompletions: true,
  })?.entries.slice(0, 150).map(item => ({ label: item.name, kind: item.kind, apply: item.insertText ?? item.name })) ?? [],
  hover: ({ path, position }) => {
    const item = service.getQuickInfoAtPosition(root + path, position);
    return item ? { text: [ts.displayPartsToString(item.displayParts), ts.displayPartsToString(item.documentation)].filter(Boolean).join('\n'),
      from: item.textSpan.start, to: item.textSpan.start + item.textSpan.length } : null;
  },
  definition: ({ path, position }) => (service.getDefinitionAtPosition(root + path, position) ?? [])
    .flatMap(item => location(item.fileName, item.textSpan.start) ?? []),
  references: ({ path, position }) => (service.getReferencesAtPosition(root + path, position) ?? [])
    .flatMap(item => location(item.fileName, item.textSpan.start) ?? []),
  rename: ({ path, position }) => {
    const info = service.getRenameInfo(root + path, position, { allowRenameOfImportPath: false });
    if (!info.canRename) return { edits: [], message: info.localizedErrorMessage };
    const edits = service.findRenameLocations(root + path, position, false, false, true) ?? [];
    return { edits: edits.filter(item => item.fileName.startsWith(root)).map(item => ({
      path: item.fileName.slice(root.length), start: item.textSpan.start, length: item.textSpan.length,
      prefix: item.prefixText, suffix: item.suffixText,
    })) };
  },
  outline: ({ path }) => outline(path),
};

self.onmessage = ({ data }) => {
  const action = actions[data.action as LanguageAction];
  // The client and worker share LanguageActions. The discriminant is checked by the lookup.
  try { self.postMessage({ id: data.id, result: action(data.payload as never) }); }
  catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
