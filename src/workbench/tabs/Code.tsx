import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { codeApi, isDesktop, loadMonaco } from '../code/code-api.ts';
import { useComments, useReviewStore } from '../code/use-comments.ts';
import { parseCodeTab, codeTabId } from '../code/ids.ts';
import { registerLangProviders } from '../code/lang-providers.ts';
import DiffView from '../code/DiffView.tsx';
import CodeView from '../code/CodeView.tsx';
import LiteDiff from '../code/LiteDiff.tsx';
import { fileCommentProps } from '../code/CommentZone.tsx';
import FileList from '../code/FileList.tsx';
import { CodeRefScope } from '../../components/CodeRefs.tsx';
import { prUrl, useConfig } from '../../config.ts';
import type { Reveal } from '../code/DiffView.tsx';
import type { LineRange, PrKey, RefFile, Refs, ReviewComment, Side } from '../types.ts';
import type { ReactNode } from 'react';

type LangStatus = { cls: string; label: string; tip?: string };
type LangStats = { status: string; sha?: string; lastError?: string; programFiles?: number };
type TextsState = { loading?: boolean; error?: string; unified?: string; original?: string; modified?: string; text?: string; binary?: boolean; tooLarge?: boolean };
const NO_TAB = { kind: 'file', n: '', path: '' } as const;

const LANG_POLL_MS = 3000;
const railScroll = new Map<PrKey, number>();
let lastClick: { path: string | null; at: number } = { path: null, at: 0 };

export function useLocal<T>(key: string, initial: T): [T, (next: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw === null ? initial : JSON.parse(raw); } catch { return initial; }
  });
  const set = (next: T) => { setV(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch {} };
  return [v, set];
}

export const sha256 = async (text: string) => {
  if (!globalThis.crypto?.subtle) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export function openCodeAt(slug: string, n: PrKey, path: string, line: number | null | undefined, { group, side = 'head' }: { group?: number; side?: string } = {}) {
  const files = useReviewStore.getState().prs[`${slug}:${n}`]?.refs?.files || [];
  const id = codeTabId(n, path, files);
  const s = useWorkbench.getState();
  if (line) s.setPendingLine(id, line, side);
  s.open(id, { preview: true, group });
  return id;
}

export function useLangStatus(n: PrKey, sha: string | null | undefined, path: string | undefined, desktop: boolean, on: boolean): LangStatus | null {
  const [stats, setStats] = useState<LangStats | null>(null);
  useEffect(() => {
    if (!sha || !desktop || !path) return;
    fetch(`/api/code/pr/${n}/open?${new URLSearchParams({ sha, path })}`).catch(() => {});
  }, [n, sha, path, desktop]);
  useEffect(() => {
    if (!on || !sha) return undefined;
    let live = true;
    const tick = () => fetch('/api/code/lang/stats').then((r) => r.json()).then((s) => live && setStats(s)).catch(() => {});
    tick();
    const t = setInterval(tick, LANG_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [on, sha]);
  if (!stats) return null;
  if (stats.status === 'error') return { cls: 'c-red', label: 'nav error', tip: stats.lastError };
  if (stats.sha !== sha) return { cls: 'c-grey', label: 'nav idle' };
  return stats.status === 'ready' ? { cls: 'c-green', label: 'ready', tip: `${stats.programFiles || 0} files in program` } : { cls: 'c-orange', label: 'indexing…' };
}

export function useTexts(n: PrKey, refs: Refs | null | undefined, path: string, file: RefFile | undefined, mode: 'diff' | 'file', desktop: boolean) {
  const [state, setState] = useState<TextsState>({ loading: true });
  const headSha = refs?.headSha;
  useEffect(() => {
    if (!refs) return undefined;
    let live = true;
    setState({ loading: true });
    const get = (sha: string, p: string) => codeApi.file(n, sha, p);
    const blank = Promise.resolve({ text: '' });
    let job: Promise<TextsState>;
    if (mode === 'diff' && !desktop) job = codeApi.diff(n, path, file?.previous).then((d) => ({ unified: d.unified }));
    else if (mode === 'diff') {
      job = Promise.all([file?.status === 'added' ? blank : get(refs.mergeBase, file?.previous || path).catch(() => ({ text: '' })), file?.status === 'removed' ? blank : get(refs.headSha, path)])
        .then(([b, h]) => ({ original: b.text, modified: h.text, binary: b.binary || h.binary, tooLarge: b.tooLarge || h.tooLarge }));
    } else job = get(refs.headSha, path).then((f) => ({ text: f.text, binary: f.binary, tooLarge: f.tooLarge }));
    job.then((r) => live && setState(r)).catch((e: Error) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [n, headSha, path, mode, desktop]);
  return state;
}

// groupFor() picks the group a definition target opens in, read at click time
export function useLangProviders(slug: string, n: PrKey, sha: string | null | undefined, on: boolean, groupFor: () => number) {
  const target = useRef(groupFor);
  target.current = groupFor;
  useEffect(() => {
    if (!on || !sha) return undefined;
    let live = true;
    loadMonaco().then((mod) => live && registerLangProviders(mod.monaco, { n, sha, languageFor: mod.languageFor, openTarget: (p, line) => openCodeAt(slug, n, p, line, { group: target.current() }) }));
    return () => { live = false; };
  }, [on, slug, n, sha]);
}

type DesktopBodyProps = {
  slug: string;
  n: PrKey;
  refs: Refs;
  mode: 'diff' | 'file';
  path: string;
  texts: TextsState;
  comments: ReviewComment[];
  zone: (comment: ReviewComment) => ReactNode;
  onCreate: (range: LineRange & { side: Side }) => void;
  reveal: Reveal | null;
  sbs: boolean;
  active: boolean;
  group: number;
};

function DesktopBody({ slug, n, refs, mode, path, texts, comments, zone, onCreate, reveal, sbs, active, group }: DesktopBodyProps) {
  useLangProviders(slug, n, refs?.headSha, active, () => group);
  if (mode === 'diff') return <DiffView original={texts.original} modified={texts.modified} path={path} sideBySide={sbs} comments={comments} onCreateComment={onCreate} renderZone={zone} reveal={reveal} />;
  return <CodeView text={texts.text} path={path} reveal={reveal} comments={comments.filter((c) => c.side === 'head')} onCreateComment={onCreate} renderZone={zone} />;
}

export default function CodeTab({ tabId, group }: { tabId: string; group: number }) {
  const { slug } = useWork();
  const { kind, n, path } = parseCodeTab(tabId) ?? NO_TAB;
  const rv = useComments(slug, n);
  const active = useWorkbench((s) => s.groups.some((g) => g.active === tabId));
  const pending = useWorkbench((s) => s.pendingLine[tabId]);
  const desktop = useMemo(isDesktop, []);
  const [rail, setRail] = useLocal(desktop ? 'cc.rail' : 'cc.rail.m', desktop);
  const [sbs, setSbs] = useLocal('cc.sbs', innerWidth >= 1300);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [anchor, setAnchor] = useState('');
  const github = useConfig((s) => s.repo.github);
  const railRef = useRef<HTMLElement>(null);
  const refs = rv.refs;
  const files = refs?.files || [];
  const file = files.find((f) => f.filename === path);
  const mode = kind === 'diff' && file ? 'diff' : 'file';
  const texts = useTexts(n, refs, path, file, mode, desktop);
  const lang = useLangStatus(n, refs?.headSha, path, desktop, desktop && active);

  useEffect(() => {
    if (!pending || !active) return;
    setReveal({ ...pending, at: Date.now() });
    useWorkbench.getState().takePendingLine(tabId);
  }, [pending, active]);
  useEffect(() => { sha256(path).then(setAnchor); }, [path]);
  useLayoutEffect(() => {
    if (rail && railRef.current) railRef.current.scrollTop = railScroll.get(n) || 0;
  }, [rail, n, files.length]);

  const { open, pin } = useWorkbench.getState();
  const openFile = (p: string, { preview }: { preview: boolean }) => {
    const id = `diff-${n}~${p}`;
    const now = Date.now();
    const dbl = !preview || (lastClick.path === p && now - lastClick.at < 450);
    lastClick = { path: p, at: now };
    open(id, { group, preview: !dbl });
    if (dbl) pin(id);
  };

  const { mine, onCreate, zone } = fileCommentProps(rv, path, file);

  let body;
  if (rv.error && !refs) body = <div className="cc-editor-status">{rv.error}</div>;
  else if (!refs || texts.loading) body = <div className="cc-editor-status">Loading {path}…</div>;
  else if (texts.error) body = <div className="cc-editor-status">{texts.error}</div>;
  else if (texts.binary || texts.tooLarge) body = <div className="cc-editor-status">{texts.binary ? 'Binary file.' : 'File too large to show.'}</div>;
  else if (desktop) body = <DesktopBody slug={slug} n={n} refs={refs} mode={mode} path={path} texts={texts} comments={mine} zone={zone} onCreate={onCreate} reveal={reveal} sbs={sbs} active={active} group={group} />;
  else if (mode === 'diff') body = <div className="ct-lite"><LiteDiff unified={texts.unified} comments={mine} onCreateComment={onCreate} renderZone={zone} /></div>;
  else body = <div className="ct-lite"><pre className="lite-diff">{texts.text}</pre></div>;

  return (
    <CodeRefScope n={n}>
    <div className="ct">
      <div className="ct-bar">
        <button className={`wb-act ${rail ? 'on' : ''}`} title="Changed files" onClick={() => setRail(!rail)}>⊞</button>
        <span className="ct-path" title={path}>{path}</span>
        {mode === 'file' && <span className="chip c-grey">head</span>}
        {file && <span className="ct-stat"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>}
        <span className="cc-spacer" />
        {desktop && mode === 'diff' && <button className="wb-act" onClick={() => setSbs(!sbs)}>{sbs ? 'inline' : 'side by side'}</button>}
        {lang && <span className={`chip ${lang.cls}`} title={lang.tip}>{lang.label}</span>}
        {mode === 'diff' && github && <a className="wb-act" href={prUrl(github, n, anchor) ?? undefined} target="_blank" rel="noreferrer">↗ GitHub</a>}
      </div>
      <div className="ct-main">
        {rail && files.length > 0 && (
          <aside className="ct-rail" ref={railRef} onScroll={(e) => railScroll.set(n, e.currentTarget.scrollTop)}>
            <FileList files={files} activePath={path} commentsByPath={rv.byPath} onOpen={openFile} />
          </aside>
        )}
        <div className="ct-body">{body}</div>
      </div>
    </div>
    </CodeRefScope>
  );
}
