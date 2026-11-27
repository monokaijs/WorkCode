export interface Location { path: string; line: number; column: number }
export interface Problem extends Location { message: string; severity: 'error' | 'warning'; from: number; to: number }
export interface Completion { label: string; kind: string; apply: string }
export interface Edit { path: string; start: number; length: number; prefix?: string; suffix?: string }
/** One declaration in a file's structure, in source order. */
export interface OutlineItem extends Location { name: string; kind: string; depth: number }
export interface LanguageActions {
  sync: [{ files: Record<string, string> }, void];
  problems: [Record<string, never>, Problem[]];
  completion: [{ path: string; position: number }, Completion[]];
  hover: [{ path: string; position: number }, { text: string; from: number; to: number } | null];
  definition: [{ path: string; position: number }, Location[]];
  references: [{ path: string; position: number }, Location[]];
  rename: [{ path: string; position: number }, { edits: Edit[]; message?: string }];
  outline: [{ path: string }, OutlineItem[]];
}
export type LanguageAction = keyof LanguageActions;
