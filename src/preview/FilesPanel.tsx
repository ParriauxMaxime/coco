import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { editor } from 'monaco-editor/editor/editor.api';
import { FileConflict, errorMessage, filesApi, gitApi } from '../api.ts';
import type { FsEntry, FsFile } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { toast } from '../components/Toast.tsx';
import { pendingClass } from '../components/action.ts';
import { useUnsaved } from '../updates.ts';
import { EDITOR_OPTIONS, useMonaco } from '../workbench/code/editor-shared.ts';
import QuickOpen from '../workbench/code/QuickOpen.tsx';
import { PathLabel, useLocal } from '../workbench/tabs/Code.tsx';
import { parseWsFileTab, wsFileTabId } from '../workbench/code/ids.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import '../workbench/code/code.css';
import './git.css';
import './files.css';

const HIDDEN = new Set(['.git', 'node_modules']);
const LETTER: Record<string, [string, string]> = { added: ['A', 'dp-ok'], modified: ['M', 'dp-warn'], removed: ['D', 'dp-bad'], renamed: ['R', 'dp-info'] };
const RELOAD_MS = 300;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const parents = (p: string) => p.split('/').slice(0, -1).map((_, i, all) => all.slice(0, i + 1).join('/'));

// the workspace's uncommitted files as git badges, read again on each change the git watch sees; reload also runs then
function useGitMarks(wsId: string, onChange: () => void) {
  const [marks, setMarks] = useState<Map<string, string>>(() => new Map());
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    let live = true;
    const load = () => gitApi.diff(wsId).then((d) => live && setMarks(new Map(d.files.map((f) => [f.filename, f.status]))), () => {});
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(topic('workspace-git', wsId), { message: (ev: { type?: string }) => {
      if (ev.type !== 'changed') return;
      clearTimeout(timer);
      timer = setTimeout(() => { load(); changed.current(); }, RELOAD_MS);
    } });
    return () => { live = false; clearTimeout(timer); off(); };
  }, [wsId]);
  return marks;
}

// ⌘P in the Files view the owner clicked last goes to its own quick open, ahead of the work's PR one
let lastTouched: HTMLElement | null = null;
function useScopedQuickOpen(root: React.RefObject<HTMLElement | null>, onOpen: () => void) {
  const opener = useRef(onOpen);
  opener.current = onOpen;
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    lastTouched = el;
    const touch = (e: PointerEvent) => { lastTouched = e.target instanceof Node && el.contains(e.target) ? el : lastTouched === el ? null : lastTouched; };
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p' || lastTouched !== el || !el.isConnected) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      opener.current();
    };
    addEventListener('pointerdown', touch, true);
    addEventListener('keydown', key, true);
    return () => {
      removeEventListener('pointerdown', touch, true);
      removeEventListener('keydown', key, true);
      if (lastTouched === el) lastTouched = null;
    };
  }, [root]);
}

type PanelProps = { wsId: string; onOpenTab?: (path: string) => void };
// a workspace's files, as the Paseo app's explorer shows them: the tree on the side (a folder read when first opened, .git and node_modules
// hidden unless asked, git badges on changed files), the picked file in Monaco on the right, read-only until Edit
export function FilesPanel({ wsId, onOpenTab }: PanelProps) {
  const [open, setOpen] = useLocal<string[]>(`cc.files.open.${wsId}`, []);
  const [picked, setPicked] = useLocal<string | null>(`cc.files.pick.${wsId}`, null);
  const [showHidden, setShowHidden] = useLocal('cc.files.hidden', false);
  const [filter, setFilter] = useState('');
  const [dirs, setDirs] = useState<Record<string, FsEntry[] | string>>({});
  const [qo, setQo] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const opened = useMemo(() => new Set(open), [open]);
  const loaded = useRef(new Set<string>());

  const list = useCallback((dir: string) => {
    loaded.current.add(dir);
    filesApi.list(wsId, dir).then((r) => setDirs((d) => ({ ...d, [dir]: r.entries })), (e) => setDirs((d) => ({ ...d, [dir]: errorMessage(e) })));
  }, [wsId]);
  useEffect(() => {
    list('');
    open.forEach(list);
  }, [list]);
  const marks = useGitMarks(wsId, () => loaded.current.forEach(list));
  const marked = useMemo(() => new Set([...marks.keys()].flatMap(parents)), [marks]);

  const toggle = (dir: string) => {
    if (opened.has(dir)) return setOpen(open.filter((d) => d !== dir));
    setOpen([...open, dir]);
    if (!loaded.current.has(dir)) list(dir);
  };
  const reveal = (p: string) => {
    const up = parents(p);
    up.filter((d) => !loaded.current.has(d)).forEach(list);
    setOpen([...new Set([...open, ...up])]);
    setPicked(p);
  };
  useScopedQuickOpen(root, () => setQo(true));

  // with a filter: the matching names among the folders read so far, and the folders above them
  const q = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    for (const entries of Object.values(dirs)) {
      if (typeof entries === 'string') continue;
      for (const e of entries) if (e.name.toLowerCase().includes(q)) [e.path, ...parents(e.path)].forEach((p) => keep.add(p));
    }
    return keep;
  }, [q, dirs]);
  const visible = (e: FsEntry) => (showHidden || !HIDDEN.has(e.name)) && (!shown || shown.has(e.path));

  const rows = (dir: string, depth: number): React.ReactNode => {
    const entries = dirs[dir];
    const pad = { paddingLeft: 8 + depth * 14 };
    if (entries === undefined) return <div className="fx-none" style={pad}>Reading…</div>;
    if (typeof entries === 'string') return <div className="fx-none dp-bad" style={pad}>{entries}</div>;
    const list = entries.filter(visible);
    if (!list.length && depth) return <div className="fx-none" style={pad}>{shown ? 'No match.' : 'Empty.'}</div>;
    return list.map((e) => {
      if (e.kind === 'dir') {
        const isOpen = opened.has(e.path) || Boolean(shown);
        return (
          <div key={e.path}>
            <button type="button" className="fx-row" style={pad} title={e.path} onClick={() => toggle(e.path)}>
              <span className={`dp-caret${isOpen ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
              <Icon name="folder" size={12} />
              <span className="fx-name">{e.name}</span>
              {e.link && <span className="fx-link" title="symbolic link">↗</span>}
              {marked.has(e.path) && <span className="fx-dot" title="holds uncommitted changes" />}
            </button>
            {isOpen && rows(e.path, depth + 1)}
          </div>
        );
      }
      const [letter, tone] = LETTER[marks.get(e.path) ?? ''] ?? [];
      return (
        <button key={e.path} type="button" className={`fx-row fx-file${picked === e.path ? ' dp-on' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 20 }} title={`${e.path} · ${size(e.size)}`} onClick={() => setPicked(e.path)} onDoubleClick={() => onOpenTab?.(e.path)}>
          <span className={`fx-name${tone ? ` fx-tone ${tone}` : ''}`}>{e.name}</span>
          {e.link && <span className="fx-link" title="symbolic link">↗</span>}
          {letter && <span className={`gp-st ${tone}`}>{letter}</span>}
        </button>
      );
    });
  };

  return (
    <div ref={root} className="fx">
      <div className="fx-body">
        <aside className="fx-side">
          <div className="fx-tools">
            <input className="dp-inp dp-sm" value={filter} placeholder="Filter opened folders" aria-label="Filter files" onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
            <button type="button" className={`dp-ibtn${showHidden ? ' dp-on' : ''}`} title={showHidden ? 'Hide .git and node_modules' : 'Show .git and node_modules'} onClick={() => setShowHidden(!showHidden)}><Icon name="eye" size={14} /></button>
            <button type="button" className="dp-ibtn" title="Go to file (⌘P)" onClick={() => setQo(true)}><Icon name="search" size={14} /></button>
            <button type="button" className="dp-ibtn" title="Read the open folders again" onClick={() => loaded.current.forEach(list)}><Icon name="refresh" size={14} /></button>
          </div>
          <div className="fx-tree" role="tree">{rows('', 0)}</div>
        </aside>
        <main className="fx-main">
          {picked ? <WorkspaceFile key={picked} wsId={wsId} path={picked} onOpenTab={onOpenTab} /> : <div className="dp-empty">Pick a file, or ⌘P to go to one.</div>}
        </main>
      </div>
      {qo && <QuickOpen open onClose={() => setQo(false)} fetchTree={() => filesApi.tree(wsId)} onOpen={reveal} placeholder="Go to file in this workspace" />}
    </div>
  );
}

type EditorHandle = { value(): string; saved(): void; reset(text: string): void };
type EditorProps = { path: string; text: string; readOnly: boolean; onDirty: (dirty: boolean) => void; onSave: () => void };
// one Monaco editor on a workspace file: its own model, dirty while it differs from the last text loaded or saved, ⌘S saves
const FileEditor = forwardRef<EditorHandle, EditorProps>(function FileEditor({ path, text, readOnly, onDirty, onSave }, ref) {
  const { mod, error } = useMonaco();
  const host = useRef<HTMLDivElement>(null);
  const [ed, setEd] = useState<editor.IStandaloneCodeEditor | null>(null);
  const clean = useRef(0);
  const cb = useRef({ onDirty, onSave });
  cb.current = { onDirty, onSave };

  useEffect(() => {
    if (!mod || !host.current) return undefined;
    const { monaco } = mod;
    const model = monaco.editor.createModel(text, mod.languageFor(path));
    const one = monaco.editor.create(host.current, { ...EDITOR_OPTIONS, glyphMargin: false, readOnly, model });
    clean.current = model.getAlternativeVersionId();
    const sub = model.onDidChangeContent(() => cb.current.onDirty(model.getAlternativeVersionId() !== clean.current));
    one.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cb.current.onSave());
    setEd(one);
    return () => {
      sub.dispose();
      setEd(null);
      one.dispose();
      model.dispose();
    };
  }, [mod, path]);

  // the disk's text, once read again: kept where the owner was reading
  useEffect(() => {
    const model = ed?.getModel();
    if (!ed || !model || model.getValue() === text) return;
    const view = ed.saveViewState();
    model.setValue(text);
    if (view) ed.restoreViewState(view);
    clean.current = model.getAlternativeVersionId();
    cb.current.onDirty(false);
  }, [ed, text]);
  useEffect(() => { ed?.updateOptions({ readOnly }); }, [ed, readOnly]);

  useImperativeHandle(ref, () => ({
    value: () => ed?.getModel()?.getValue() ?? text,
    saved() {
      clean.current = ed?.getModel()?.getAlternativeVersionId() ?? 0;
      cb.current.onDirty(false);
    },
    reset(next) {
      const model = ed?.getModel();
      if (!model) return;
      if (model.getValue() !== next) model.setValue(next);
      clean.current = model.getAlternativeVersionId();
      cb.current.onDirty(false);
    },
  }));
  return (
    <div className="cc-editor-wrap fx-editor">
      <div ref={host} className="cc-editor" />
      {!mod && <div className="cc-editor-status">{error ? `Editor failed to load: ${error.message}` : 'Loading editor…'}</div>}
    </div>
  );
});

// one file of a workspace: read-only until Edit, Save (⌘S) over the version read; reloaded when it changes on disk unless edited, a banner then
export function WorkspaceFile({ wsId, path, onOpenTab }: { wsId: string; path: string; onOpenTab?: (path: string) => void }) {
  const [file, setFile] = useState<FsFile | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [disk, setDisk] = useState<{ modifiedAt: string } | 'missing' | null>(null);
  const [saving, setSaving] = useState(false);
  const ed = useRef<EditorHandle>(null);
  const now = useRef({ file, dirty, saving });
  now.current = { file, dirty, saving };
  useUnsaved(dirty);

  const load = useCallback(() => filesApi.read(wsId, path).then((f) => { setFile(f); setError(''); setDisk(null); return f; }, (e) => { setError(errorMessage(e)); return null; }), [wsId, path]);
  // the disk's version in the editor, the owner's edits dropped
  const reload = () => void load().then((f) => f && ed.current?.reset(f.content ?? ''));
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribe(topic('workspace-file', wsId, path), { message: (ev: { type?: string; modifiedAt?: string }) => {
    const { file: cur, dirty: edited, saving: busy } = now.current;
    if (!cur || busy) return;
    if (ev.type === 'missing') return setDisk('missing');
    if (!ev.modifiedAt || ev.modifiedAt === cur.modifiedAt) return;
    if (edited) setDisk({ modifiedAt: ev.modifiedAt });
    else void load();
  } }), [wsId, path, load]);

  const save = async (over?: string) => {
    const cur = now.current.file;
    if (!cur || !ed.current || now.current.saving) return;
    const content = ed.current.value();
    setSaving(true);
    try {
      const r = await filesApi.write(wsId, { path, content, expectedModifiedAt: over ?? cur.modifiedAt, ...(cur.revision && !over ? { expectedRevision: cur.revision } : {}) });
      setFile({ ...cur, content, size: r.size, modifiedAt: r.modifiedAt, revision: r.revision });
      ed.current.saved();
      setDisk(null);
      toast.success(`Saved ${path}`);
    } catch (e) {
      if (e instanceof FileConflict) setDisk(e.modifiedAt ? { modifiedAt: e.modifiedAt } : 'missing');
      else toast.error(`Save failed: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const onSave = () => { if (now.current.dirty) void save(); };

  const text = file?.kind === 'text';
  return (
    <div className="fx-file-view">
      <div className="fx-bar">
        <Icon name="file" size={14} />
        <span className="fx-path" title={path}><PathLabel path={path} /></span>
        {file && <span className="dp-xs dp-t3">{size(file.size)}</span>}
        {dirty && <span className="dp-chip dp-warn">unsaved</span>}
        <span className="dp-sp" />
        {text && (editing ? <>
          <button type="button" className="dp-btn dp-sm dp-ghost" disabled={!dirty || saving} title="Drop your edits: back to the file on disk" onClick={reload}>Revert</button>
          <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(saving)}`} disabled={!dirty || saving} title="Write the file (⌘S)" onClick={() => void save()}><Icon name="check" size={12} />Save</button>
          <button type="button" className="dp-btn dp-sm dp-ghost" disabled={dirty} title={dirty ? 'Save or revert first' : 'Back to read-only'} onClick={() => setEditing(false)}>Done</button>
        </> : <button type="button" className="dp-btn dp-sm" title="Edit this file in place; Save (⌘S) writes it" onClick={() => setEditing(true)}><Icon name="pencil" size={12} />Edit</button>)}
        {onOpenTab && <button type="button" className="dp-ibtn" title="Open as tab" onClick={() => onOpenTab(path)}><Icon name="external-link" size={14} /></button>}
      </div>
      {disk && (
        <div className="dp-callout fx-banner">
          {disk === 'missing' ? <span>This file was deleted on disk.</span> : <>
            <span>Changed on disk since you opened it.</span>
            <button type="button" className="dp-btn dp-sm" onClick={reload}>Reload (drops your edits)</button>
            <button type="button" className="dp-btn dp-sm dp-ghost" disabled={saving} onClick={() => void save(disk.modifiedAt)}>Overwrite with mine</button>
          </>}
        </div>
      )}
      {error && !file ? <div className="dp-empty">{error}</div>
        : !file ? <div className="dp-empty">Reading…</div>
        : file.kind === 'text' ? <FileEditor ref={ed} path={path} text={file.content ?? ''} readOnly={!editing} onDirty={setDirty} onSave={onSave} />
        : file.kind === 'image' ? <div className="fx-image"><img src={file.dataUrl} alt={path} /></div>
        : <div className="dp-empty">{file.kind === 'binary' ? `Binary file (${size(file.size)}): not shown.` : `Larger than 2 MB (${size(file.size)}): not shown.`}</div>}
    </div>
  );
}

// in a work's tabs, a file opens as its own tab next to the view
export const openWorkspaceFile = (wsId: string) => (path: string) => {
  const s = useWorkbench.getState();
  s.open(wsFileTabId(wsId, path), { group: s.otherGroup() });
};

// wsfile-<workspace id>~<path>: one workspace file in a tab
export function WorkspaceFileTab({ tabId }: { tabId: string }) {
  const t = parseWsFileTab(tabId);
  return t ? <div className="dp-tabview fx-tab"><WorkspaceFile wsId={t.wsId} path={t.path} /></div> : <div className="dp-empty">Unknown file.</div>;
}
