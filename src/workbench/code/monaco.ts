import * as monaco from 'monaco-editor/editor/editor.api';
import './monaco-features.ts';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/shell/register';
import { getTheme, onThemeChange } from '../../theme.ts';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// colours are the --dp-* tokens of src/preview/preview.css (panel, subtle, line, t2/t4, accent, ok, bad), light then dark
monaco.editor.defineTheme('cocopilot', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editorLineNumber.foreground': '#b4b4bb',
    'editorLineNumber.activeForeground': '#52525b',
    'editor.selectionBackground': '#5e5ce629',
    'editor.inactiveSelectionBackground': '#5e5ce617',
    'editor.lineHighlightBackground': '#f3f3f5',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedLineBackground': '#16a34a17',
    'diffEditor.insertedTextBackground': '#16a34a33',
    'diffEditor.removedLineBackground': '#dc262614',
    'diffEditor.removedTextBackground': '#dc26262e',
    'diffEditorGutter.insertedLineBackground': '#16a34a24',
    'diffEditorGutter.removedLineBackground': '#dc26261f',
    'diffEditor.diagonalFill': '#e4e4e7',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e4e4e7',
    'editorIndentGuide.background1': '#ececef',
    'scrollbarSlider.background': '#18181b1f',
    'scrollbarSlider.hoverBackground': '#18181b33',
  },
});

monaco.editor.defineTheme('cocopilot-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#141416',
    'editorGutter.background': '#141416',
    'editorLineNumber.foreground': '#4f4f56',
    'editorLineNumber.activeForeground': '#a1a1aa',
    'editor.selectionBackground': '#7b7bf540',
    'editor.inactiveSelectionBackground': '#7b7bf524',
    'editor.lineHighlightBackground': '#18181b',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedLineBackground': '#3fcf7a17',
    'diffEditor.insertedTextBackground': '#3fcf7a33',
    'diffEditor.removedLineBackground': '#f2656517',
    'diffEditor.removedTextBackground': '#f2656538',
    'diffEditorGutter.insertedLineBackground': '#3fcf7a24',
    'diffEditorGutter.removedLineBackground': '#f2656524',
    'diffEditor.diagonalFill': '#26262a',
    'editorWidget.background': '#18181b',
    'editorWidget.border': '#26262a',
    'editorIndentGuide.background1': '#26262a',
    'scrollbarSlider.background': '#ececef1f',
    'scrollbarSlider.hoverBackground': '#ececef33',
  },
});

const themeName = (t: string) => (t === 'dark' ? 'cocopilot-dark' : 'cocopilot');
monaco.editor.setTheme(themeName(getTheme().resolved));
onThemeChange((t) => monaco.editor.setTheme(themeName(t)));

const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  scss: 'scss', css: 'css', html: 'html', htm: 'html', svg: 'html', json: 'javascript', jsonc: 'javascript', json5: 'javascript',
  md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell',
};

export const languageFor = (path: string | null | undefined) => EXT[(String(path || '').split('.').pop() ?? '').toLowerCase()] || 'plaintext';

export { monaco };
