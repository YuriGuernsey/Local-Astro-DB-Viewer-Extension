// CodeMirror 6 setup for the SQL tab: SQLite dialect, schema-aware autocomplete and VS Code theming.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { SQLite, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { SchemaInfo } from '../shared/protocol';

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], class: 'tok-keyword' },
  { tag: [tags.string, tags.special(tags.string)], class: 'tok-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'tok-number' },
  { tag: [tags.lineComment, tags.blockComment, tags.comment], class: 'tok-comment' },
  { tag: [tags.special(tags.name), tags.quote], class: 'tok-ident' },
  { tag: [tags.typeName, tags.standard(tags.name)], class: 'tok-type' },
  { tag: [tags.function(tags.variableName)], class: 'tok-function' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 13px)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--vscode-editorGutter-background, var(--vscode-editor-background))',
    color: 'var(--vscode-editorLineNumber-foreground)',
    border: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
  '.cm-placeholder': { color: 'var(--vscode-editorGhostText-foreground, var(--vscode-descriptionForeground))' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)',
    color: 'var(--vscode-editorSuggestWidget-foreground)',
    border: '1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-widget-border))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--vscode-editor-font-family, monospace)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground))',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-list-activeSelectionForeground))',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--vscode-editorSuggestWidget-highlightForeground)', fontWeight: '600' },
  '.cm-completionDetail': { color: 'var(--vscode-descriptionForeground)', fontStyle: 'normal' },
});

function schemaSpec(schema: SchemaInfo): Record<string, string[]> {
  // CodeMirror reads dots in keys as schema.table, so literal dots are escaped; no prototype,
  // so a table named __proto__ is an ordinary key.
  const spec: Record<string, string[]> = Object.create(null);
  for (const t of schema.tables) spec[t.name.replace(/\./g, '\\.')] = t.columns.map((c) => c.name);
  return spec;
}

export interface SqlEditor {
  view: EditorView;
  /** Updates completions; columns of `defaultTable` complete without a qualifier. */
  setSchema(schema: SchemaInfo, defaultTable?: string | null): void;
  getText(): string;
  setText(text: string): void;
  /** Selected text, or null when the selection is empty. */
  selection(): string | null;
  cursor(): number;
  focus(): void;
}

export function createSqlEditor(
  parent: HTMLElement,
  opts: { doc: string; schema: SchemaInfo; defaultTable?: string | null; onRun(all: boolean): void; onChange(text: string): void },
): SqlEditor {
  const language = new Compartment();
  const lang = (schema: SchemaInfo, defaultTable?: string | null) =>
    sql({ dialect: SQLite, schema: schemaSpec(schema), upperCaseKeywords: true, defaultTable: defaultTable ?? undefined });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        autocompletion({ icons: false }),
        syntaxHighlighting(highlight),
        placeholder('Write SQL here…'),
        language.of(lang(opts.schema, opts.defaultTable)),
        theme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'SQL editor' }),
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run: () => (opts.onRun(false), true) },
            { key: 'Shift-Mod-Enter', run: () => (opts.onRun(true), true) },
          ]),
        ),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    setSchema: (schema, defaultTable) => view.dispatch({ effects: language.reconfigure(lang(schema, defaultTable)) }),
    getText: () => view.state.doc.toString(),
    setText: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } }),
    selection: () => {
      const r = view.state.selection.main;
      return r.empty ? null : view.state.sliceDoc(r.from, r.to);
    },
    cursor: () => view.state.selection.main.head,
    focus: () => view.focus(),
  };
}
