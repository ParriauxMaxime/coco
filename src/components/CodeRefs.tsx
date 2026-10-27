import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { codeApi } from '../workbench/code/code-api.ts';
import { errorMessage } from '../api.ts';
import { useConfig } from '../config.ts';
import './parts.css';

// `path/to/file.ext:12-34` in rendered markdown becomes a link that opens the editor at that line, with a code peek on hover.
// The workbench sets the PR the paths are read at (the top stack row); a Review tab or a card tagged with `pr` narrows it.
type PrKey = number | string;
type OpenAt = (n: PrKey, path: string, line: number | null) => void;
type CodeRefValue = { n: PrKey; openAt: OpenAt; open: (path: string, line: number | null) => void; slug?: string; prs?: number[] };
type PeekTarget = { path: string; start: number | null; end: number | null; rect: DOMRect };
type PeekFile = { text?: string; tooLarge?: boolean; base?: boolean; error?: string };

export const CodeRefContext = createContext<CodeRefValue | null>(null);

export function CodeRefScope({ n, children }: { n?: PrKey; children?: React.ReactNode }) {
  const parent = useContext(CodeRefContext);
  const value = useMemo(() => (parent && n ? { ...parent, n, open: (path: string, line: number | null) => parent.openAt(n, path, line) } : null), [parent, n]);
  if (!value) return children;
  return <CodeRefContext.Provider value={value}>{children}</CodeRefContext.Provider>;
}

// the workbench root: openAt(n, path, line) opens the editor tab of a PR at a line
export function CodeRefRoot({ n, openAt, slug, prs, children }: { n?: PrKey | null; openAt: OpenAt; slug: string; prs: number[]; children?: React.ReactNode }) {
  const value = useMemo(() => (n ? { n, openAt, open: (path: string, line: number | null) => openAt(n, path, line), slug, prs } : null), [n, openAt, slug, prs]);
  return <CodeRefContext.Provider value={value}>{children}</CodeRefContext.Provider>;
}

const REF = /(?<![\w/.@-])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?(?![\w/])/g;
// a bare file name links only as a whole `code` element, once the repo tree knows a single file by that name
const BARE = /^([\w@.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|s?css|sh|ya?ml|html))(?::(\d+)(?:-(\d+))?)?$/;
const PR_REF = /(?<![\w&/#])#(\d{2,6})\b/g;
const isSha = (s: string) => /^[0-9a-f]{7,40}$/.test(s) && /\d/.test(s) && /[a-f]/.test(s);
const SKIP = 'a, pre, .code-ref';

const refLink = (doc: Document, path: string, start: string | undefined, end: string | undefined, text: string) => {
  const a = doc.createElement('a');
  a.className = 'code-ref';
  a.href = '#';
  a.dataset.path = path;
  if (start) a.dataset.start = start;
  if (end) a.dataset.end = end;
  a.textContent = text;
  return a;
};

const hrefLink = (doc: Document, href: string, text: string) => {
  const a = doc.createElement('a');
  a.href = href;
  if (!href.startsWith('#')) Object.assign(a, { target: '_blank', rel: 'noreferrer' });
  a.textContent = text;
  return a;
};

// whole inline `code` elements whose text makes a link
function wrapCode(root: HTMLElement, link: (text: string) => HTMLAnchorElement | null) {
  for (const code of root.querySelectorAll('code')) {
    if (code.closest(SKIP)) continue;
    const a = link((code.textContent ?? '').trim());
    if (!a) continue;
    code.replaceWith(a);
    a.appendChild(code);
  }
}

// matches of `re` in the text outside links and code
function wrapText(root: HTMLElement, hint: string, re: RegExp, link: (m: RegExpMatchArray) => HTMLAnchorElement | null) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement?.closest(`${SKIP}, code`) || !t.nodeValue?.includes(hint) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const texts: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text) texts.push(walker.currentNode);
  }
  for (const t of texts) {
    const value = t.nodeValue ?? '';
    const parts: (string | HTMLAnchorElement)[] = [];
    let last = 0;
    for (const m of value.matchAll(re)) {
      const a = link(m);
      if (!a) continue;
      parts.push(value.slice(last, m.index), a);
      last = (m.index ?? 0) + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(value.slice(last));
    t.replaceWith(...parts.filter((p) => p !== ''));
  }
}

// wraps code refs of a rendered markdown root in links: whole inline `code` elements, and refs inside text
export function linkCodeRefs(root: HTMLElement) {
  const doc = root.ownerDocument;
  wrapCode(root, (text) => {
    const m = new RegExp(`^${REF.source}$`).exec(text) || BARE.exec(text);
    return m && refLink(doc, m[1], m[2], m[3], '');
  });
  wrapText(root, '/', REF, (m) => refLink(doc, m[1], m[2], m[3], m[0]));
}

// #123 opens the PR tab when the work stacks it, GitHub otherwise; a commit sha in `code` opens on GitHub
export function linkGithubRefs(root: HTMLElement, github: string, work?: { slug?: string; prs?: number[] }) {
  const doc = root.ownerDocument;
  const prHref = (n: string) => (work?.slug && work.prs?.includes(Number(n)) ? `#/work/${work.slug}/pr-${n}` : github ? `https://github.com/${github}/pull/${n}` : null);
  wrapCode(root, (text) => {
    const href = isSha(text) && github ? `https://github.com/${github}/commit/${text}` : /^#\d+$/.test(text) ? prHref(text.slice(1)) : null;
    return href ? hrefLink(doc, href, '') : null;
  });
  wrapText(root, '#', PR_REF, (m) => {
    const href = prHref(m[1]);
    return href ? hrefLink(doc, href, m[0]) : null;
  });
}

const trees = new Map<PrKey, Promise<string[]>>();
const treeAt = (n: PrKey) => {
  const hit = trees.get(n);
  if (hit) return hit;
  const loaded = codeApi.tree(n).then((r: { files?: string[] }) => r.files || []).catch(() => []);
  trees.set(n, loaded);
  return loaded;
};

// module-relative or bare paths get their repo path; a path no file of the repo ends with stops being a link
async function resolveCodeRefs(root: HTMLElement, n: PrKey) {
  const refs = [...root.querySelectorAll<HTMLAnchorElement>('a.code-ref:not([data-resolved])')];
  if (!refs.length) return;
  const tree = await treeAt(n);
  if (!tree.length) return;
  const known = new Set(tree);
  for (const a of refs) {
    a.dataset.resolved = '1';
    const path = a.dataset.path ?? '';
    if (known.has(path)) continue;
    const hits = tree.filter((f) => f.endsWith(`/${path}`));
    if (hits.length === 1) {
      a.dataset.path = hits[0];
      a.title = hits[0];
    } else a.replaceWith(...a.childNodes);
  }
}

const files = new Map<string, Promise<PeekFile>>();
const fileAt = (n: PrKey, path: string): Promise<PeekFile> => {
  const key = `${n}:${path}`;
  const cached = files.get(key);
  if (cached) return cached;
  const loaded: Promise<PeekFile> = codeApi.file(n, 'head', path).catch(() => codeApi.file(n, 'base', path).then((f) => ({ ...f, base: true }))).catch((e) => ({ error: errorMessage(e) }));
  files.set(key, loaded);
  return loaded;
};
const CONTEXT = 4;

type PeekProps = { n: PrKey; at: PeekTarget; onEnter: () => void; onLeave: () => void };
function Peek({ n, at: target, onEnter, onLeave }: PeekProps) {
  const [file, setFile] = useState<PeekFile | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { path, start, end } = target;
  useEffect(() => {
    let live = true;
    fileAt(n, path).then((f) => live && setFile(f));
    return () => { live = false; };
  }, [n, path]);
  useLayoutEffect(() => {
    const r = target.rect;
    const h = box.current?.offsetHeight || 0;
    const below = r.bottom + 6 + h < innerHeight;
    setPos({ left: Math.max(8, Math.min(r.left, innerWidth - 668)), top: below ? r.bottom + 6 : Math.max(8, r.top - 6 - h) });
  }, [target, file]);
  const lines = file?.text?.split('\n') || [];
  const from = start ? Math.max(1, start - CONTEXT) : 1;
  const to = Math.min(lines.length, start ? (end || start) + CONTEXT : 2 * CONTEXT + 4);
  return createPortal(
    <div className="dp dp-float">
      <div ref={box} className="dp-cpeek" style={pos || { visibility: 'hidden' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
        <div className="dp-cpeek-h"><b>{path}</b>{start && <span>L{start}{end ? `–${end}` : ''}</span>}<span className="dp-cpeek-at">{typeof n === 'number' ? `#${n}` : String(n).slice(2).replaceAll(':', '/')} {file?.base ? 'base (not at head)' : 'head'} · click opens the editor</span></div>
        {!file && <div className="dp-cpeek-note">Loading…</div>}
        {file?.error && <div className="dp-cpeek-note">Not found in this PR ({file.error.replace(/^\d+ /, '').slice(0, 120)}).</div>}
        {file?.tooLarge && <div className="dp-cpeek-note">File too large to preview.</div>}
        {lines.length > 0 && (
          <pre className="dp-cpeek-body">
            {lines.slice(from - 1, to).map((l, i) => {
              const no = from + i;
              const on = start && no >= start && no <= (end || start);
              return <div key={no} className={on ? 'dp-on' : undefined}><span className="dp-cpeek-no">{no}</span>{l || ' '}</div>;
            })}
          </pre>
        )}
      </div>
    </div>,
    document.body,
  );
}

// click and hover handling for the code refs of one markdown root
export function useCodeRefs(rootRef: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const ctx = useContext(CodeRefContext);
  const github = useConfig((s) => s.repo.github);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const root = rootRef.current;
    if (root) linkGithubRefs(root, github, ctx ?? undefined);
    if (!ctx || !root) return undefined;
    linkCodeRefs(root);
    resolveCodeRefs(root, ctx.n);
    const refOf = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a.code-ref') : null);
    const onClick = (e: MouseEvent) => {
      const a = refOf(e);
      if (!a) return;
      e.preventDefault();
      setPeek(null);
      ctx.open(a.dataset.path ?? '', Number(a.dataset.start) || null);
    };
    const onOver = (e: MouseEvent) => {
      const a = refOf(e);
      if (!a) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setPeek({ path: a.dataset.path ?? '', start: Number(a.dataset.start) || null, end: Number(a.dataset.end) || null, rect: a.getBoundingClientRect() }), 250);
    };
    const onOut = (e: MouseEvent) => {
      if (!refOf(e)) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setPeek(null), 200);
    };
    root.addEventListener('click', onClick);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    return () => {
      clearTimeout(timer.current);
      root.removeEventListener('click', onClick);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
    };
  }, [ctx, github, ...deps]);
  if (!ctx || !peek) return null;
  return <Peek n={ctx.n} at={peek} onEnter={() => clearTimeout(timer.current)} onLeave={() => setPeek(null)} />;
}
