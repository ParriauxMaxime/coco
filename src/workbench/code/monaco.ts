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

monaco.editor.defineTheme('cocopilot', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorLineNumber.foreground': '#9ca3af',
    'editorLineNumber.activeForeground': '#374151',
    'editor.selectionBackground': '#e0e7ff',
    'editor.inactiveSelectionBackground': '#eef2ff',
    'editor.lineHighlightBackground': '#f6f7f8',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedLineBackground': '#e6fdee',
    'diffEditor.insertedTextBackground': '#86efac55',
    'diffEditor.removedLineBackground': '#fee2e2',
    'diffEditor.removedTextBackground': '#fca5a566',
    'diffEditorGutter.insertedLineBackground': '#e6fdee',
    'diffEditorGutter.removedLineBackground': '#fee2e2',
  },
});

monaco.editor.defineTheme('cocopilot-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#161a22',
    'editorGutter.background': '#161a22',
    'editorLineNumber.foreground': '#5c6372',
    'editorLineNumber.activeForeground': '#c3c7d1',
    'editor.selectionBackground': '#25235a',
    'editor.inactiveSelectionBackground': '#1b1a3d',
    'editor.lineHighlightBackground': '#1b202a',
    'editor.lineHighlightBorder': '#00000000',
    'diffEditor.insertedLineBackground': '#0f2a1a',
    'diffEditor.insertedTextBackground': '#22c55e33',
    'diffEditor.removedLineBackground': '#2e1414',
    'diffEditor.removedTextBackground': '#ef444444',
    'diffEditorGutter.insertedLineBackground': '#0f2a1a',
    'diffEditorGutter.removedLineBackground': '#2e1414',
    'diffEditor.diagonalFill': '#262b36',
    'editorWidget.background': '#1d2129',
    'editorIndentGuide.background1': '#262b36',
  },
});

const themeName = (t) => (t === 'dark' ? 'cocopilot-dark' : 'cocopilot');
monaco.editor.setTheme(themeName(getTheme().resolved));
onThemeChange((t) => monaco.editor.setTheme(themeName(t)));

const EXT = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  scss: 'scss', css: 'css', html: 'html', json: 'javascript',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell',
};

export const languageFor = (path) => EXT[String(path || '').split('.').pop().toLowerCase()] || 'plaintext';

export { monaco };
