import type { editor, Position } from 'monaco-editor/editor/editor.api';
import { codeApi } from './code-api.ts';
import { acquireModel, releaseModel } from './editor-shared.ts';
import type { MonacoApi, PrKey } from '../types.ts';

type Loc = { path: string; line: number; col: number; endLine?: number; endCol?: number; external?: boolean; preview?: string };
type HoverResult = { contents?: string; range?: { line: number; col: number; endLine: number; endCol: number } };
type Asked<T> = { result?: T; error?: string };
type OpenTarget = (path: string, line: number) => void;
type Registration = { key: string; openTarget: OpenTarget; dispose: () => void };

const MAX_FILES = 25;
const LANGS = ['typescript', 'javascript'];
let current: Registration | null = null;

const ask = async <T>(n: PrKey, op: string, params: Record<string, string | number | null>): Promise<Asked<T>> => {
  try {
    const r = await fetch(`/api/code/pr/${n}/${op}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`);
    const body = await r.json().catch(() => ({}));
    return r.status === 200 && !body.error ? { result: body.result } : { error: body.error || body.status || `http ${r.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

const headPath = (model: editor.ITextModel) => (model.uri.scheme === 'cc' && model.uri.path.startsWith('/head/') && /\.[cm]?[jt]sx?$/.test(model.uri.path) ? model.uri.path.slice(6) : null);
const external = (p: string) => p.replace(/^\/+/, '');

export function registerLangProviders(monaco: MonacoApi, { n, sha, openTarget, languageFor }: { n: PrKey; sha: string; openTarget: OpenTarget; languageFor: (path: string) => string }) {
  const key = `${n}:${sha}`;
  if (current?.key === key) {
    current.openTarget = openTarget;
    return current;
  }
  current?.dispose();
  const held = new Map<string, editor.ITextModel>();
  let lastAsk: { uri: string; position: Position } | null = null;
  const reg: Registration = { key, openTarget, dispose: () => {} };

  const modelFor = async (loc: Loc) => {
    const ext = Boolean(loc.external);
    const side = ext ? 'ext' : 'head';
    const p = ext ? external(loc.path) : loc.path;
    const uri = monaco.Uri.from({ scheme: 'cc', path: `/${side}/${p}` });
    const id = uri.toString();
    if (held.has(id)) return uri;
    const existing = monaco.editor.getModel(uri);
    let text = existing?.getValue();
    if (text === undefined) {
      const fetched: string = await codeApi.file(n, ext ? 'head' : sha, p).then((f) => f.text).catch(() => `${'\n'.repeat(Math.max(0, loc.line - 1))}${loc.preview || ''}`);
      text = fetched;
    }
    held.set(id, acquireModel({ monaco, languageFor }, side, p, text));
    return uri;
  };

  const toLocations = async (list: Loc[]) => {
    const out: { uri: Awaited<ReturnType<typeof modelFor>>; range: InstanceType<MonacoApi['Range']> }[] = [];
    const files = new Set<string>();
    for (const loc of list) {
      const id = `${loc.external ? 'ext' : 'head'}:${loc.path}`;
      if (!files.has(id) && files.size >= MAX_FILES) continue;
      files.add(id);
      const uri = await modelFor(loc);
      out.push({ uri, range: new monaco.Range(loc.line, loc.col, loc.endLine || loc.line, loc.endCol || loc.col) });
    }
    return out;
  };

  const params = (model: editor.ITextModel, position: Position) => ({ sha, path: headPath(model), line: position.lineNumber, col: position.column });

  const textSearch = async (model: editor.ITextModel, position: Position) => {
    const word = model.getWordAtPosition(position)?.word;
    if (!word || word.length < 2) return [];
    const { hits = [] }: { hits?: { path: string; line: number; text: string }[] } = await codeApi.search(n, word).catch(() => ({}));
    return toLocations(hits.map((h) => {
      const col = Math.max(1, h.text.indexOf(word) + 1);
      return { path: h.path, line: h.line, col, endLine: h.line, endCol: col + word.length, preview: h.text };
    }));
  };

  const subs = LANGS.flatMap((lang) => [
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model, position) => {
        if (!headPath(model)) return [];
        lastAsk = { uri: model.uri.toString(), position };
        const r = await ask<Loc[]>(n, 'definition', params(model, position));
        return Array.isArray(r.result) ? toLocations(r.result) : [];
      },
    }),
    monaco.languages.registerReferenceProvider(lang, {
      provideReferences: async (model, position) => {
        if (!headPath(model)) return [];
        const r = await ask<Loc[]>(n, 'references', params(model, position));
        return Array.isArray(r.result) ? toLocations(r.result) : textSearch(model, position);
      },
    }),
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        if (!headPath(model)) return null;
        const r = await ask<HoverResult>(n, 'hover', params(model, position));
        if (!r.result?.contents) return null;
        const g = r.result.range;
        return { contents: [{ value: r.result.contents }], range: g && new monaco.Range(g.line, g.col, g.endLine, g.endCol) };
      },
    }),
  ]);

  subs.push(monaco.editor.registerEditorOpener({
    openCodeEditor(source, uri, selection) {
      if (uri.scheme !== 'cc' || source.getModel()?.uri.toString() === uri.toString()) return false;
      if (uri.path.startsWith('/ext/')) {
        if (lastAsk && source.getModel()?.uri.toString() === lastAsk.uri) {
          source.setPosition(lastAsk.position);
          source.trigger('cc', 'editor.action.peekDefinition', null);
        }
        return true;
      }
      if (!uri.path.startsWith('/head/')) return false;
      reg.openTarget(uri.path.slice(6), selection ? ('startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber) : 1);
      return true;
    },
  }));

  reg.dispose = () => {
    subs.forEach((s) => s.dispose());
    held.forEach((m) => releaseModel(m));
    held.clear();
    if (current === reg) current = null;
  };
  current = reg;
  return reg;
}
