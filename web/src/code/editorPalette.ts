import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

const readable = (role: string) =>
  `color-mix(in srgb, var(--workspace-${role}) 72%, var(--workspace-text))`;

export const editorPalette = [
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: readable('purple') },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: readable('green') },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: readable('warning') },
    { tag: [tags.typeName, tags.className, tags.function(tags.variableName), tags.function(tags.propertyName)], color: readable('blue') },
    { tag: [tags.comment, tags.meta], color: 'var(--workspace-secondary-text)' },
    { tag: tags.invalid, color: readable('danger') },
  ])),
  EditorView.theme({
    '&': { color: 'var(--workspace-text)', backgroundColor: 'var(--workspace-canvas)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--workspace-accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--workspace-accent) 25%, var(--workspace-canvas))',
    },
    '.cm-gutters': { color: 'var(--workspace-secondary-text)', backgroundColor: 'var(--workspace-canvas)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--workspace-text) 6%, var(--workspace-canvas))' },
    '.cm-tooltip, .cm-panels': {
      color: 'var(--workspace-text)',
      backgroundColor: 'var(--workspace-panel)',
      borderColor: 'var(--workspace-divider)',
    },
    '.cm-button, .cm-textfield': {
      color: 'var(--workspace-text)',
      background: 'var(--workspace-canvas)',
      borderColor: 'var(--workspace-divider)',
    },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--workspace-warning) 27%, var(--workspace-canvas))' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--workspace-accent) 35%, var(--workspace-canvas))' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'color-mix(in srgb, var(--workspace-accent) 21%, var(--workspace-canvas))',
      color: 'var(--workspace-text)',
    },
  }),
];
