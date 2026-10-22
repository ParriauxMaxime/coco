import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { codeApi } from '../workbench/code/code-api.js';

// `path/to/file.ext:12-34` in rendered markdown becomes a link that opens the editor at that line, with a code peek on hover.
// The workbench sets the PR the paths are read at (the top stack row); a Review tab or a card tagged with `pr` narrows it.
export const CodeRefContext = createContext(null);

export function CodeRefScope({ n, children }) {
  const parent = useContext(CodeRefContext);
  const value = useMemo(() => parent && n && { ...parent, n, open: (path, line) => parent.openAt(n, path, line) }, [parent, n]);
  if (!value) return children;
  return <CodeRefContext.Provider value={value}>{children}</CodeRefContext.Provider>;
}

// the workbench root: openAt(n, path, line) opens the editor tab of a PR at a line
export function CodeRefRoot({ n, openAt, children }) {
  const value = useMemo(() => (n ? { n, openAt, open: (path, line) => openAt(n, path, line) } : null), [n, openAt]);
  return <CodeRefContext.Provider value={value}>{children}</CodeRefContext.Provider>;
}

const REF = /(?<![\w/.@-])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?(?![\w/])/g;
const SKIP = 'a, pre, .code-ref';

const refLink = (doc, path, start, end, text) => {
  const a = doc.createElement('a');
  a.className = 'code-ref';
  a.href = '#';
  a.dataset.path = path;
  if (start) a.dataset.start = start;
  if (end) a.dataset.end = end;
  a.textContent = text;
  return a;
};

// wraps code refs of a rendered markdown root in links: whole inline `code` elements, and refs inside text
export function linkCodeRefs(root) {
  const doc = root.ownerDocument;
  for (const code of root.querySelectorAll('code')) {
    if (code.closest(SKIP)) continue;
    const m = new RegExp(`^${REF.source}$`).exec(code.textContent.trim());
    if (!m) continue;
    const a = refLink(doc, m[1], m[2], m[3], '');
    code.replaceWith(a);
    a.appendChild(code);
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement?.closest(`${SKIP}, code`) || !t.nodeValue.includes('/') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const t of texts) {
    const parts = [];
    let last = 0;
    for (const m of t.nodeValue.matchAll(REF)) {
      parts.push(t.nodeValue.slice(last, m.index), refLink(doc, m[1], m[2], m[3], m[0]));
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    parts.push(t.nodeValue.slice(last));
    t.replaceWith(...parts.filter((p) => p !== ''));
  }
}

const files = new Map();
const fileAt = (n, path) => {
  const key = `${n}:${path}`;
  if (!files.has(key)) files.set(key, codeApi.file(n, 'head', path).catch(() => codeApi.file(n, 'base', path).then((f) => ({ ...f, base: true }))).catch((e) => ({ error: e.message })));
  return files.get(key);
};
const CONTEXT = 4;

function Peek({ n, at: target, onEnter, onLeave }) {
  const [file, setFile] = useState(null);
  const box = useRef(null);
  const [pos, setPos] = useState(null);
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
    <div ref={box} className="code-peek card" style={pos || { visibility: 'hidden' }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="code-peek-h"><b>{path}</b>{start && <span className="status">L{start}{end ? `–${end}` : ''}</span>}<span className="status">{typeof n === 'number' ? `#${n}` : String(n).slice(2).replaceAll(':', '/')} {file?.base ? 'base (not at head)' : 'head'} · click opens the editor</span></div>
      {!file && <div className="status">Loading…</div>}
      {file?.error && <div className="status">Not found in this PR ({file.error.replace(/^\d+ /, '').slice(0, 120)}).</div>}
      {file?.tooLarge && <div className="status">File too large to preview.</div>}
      {lines.length > 0 && (
        <pre className="code-peek-body">
          {lines.slice(from - 1, to).map((l, i) => {
            const no = from + i;
            const on = start && no >= start && no <= (end || start);
            return <div key={no} className={on ? 'on' : ''}><span className="code-peek-no">{no}</span>{l || ' '}</div>;
          })}
        </pre>
      )}
    </div>,
    document.body,
  );
}

// click and hover handling for the code refs of one markdown root
export function useCodeRefs(rootRef, deps) {
  const ctx = useContext(CodeRefContext);
  const [peek, setPeek] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!ctx || !root) return undefined;
    linkCodeRefs(root);
    const refOf = (e) => e.target.closest?.('a.code-ref');
    const onClick = (e) => {
      const a = refOf(e);
      if (!a) return;
      e.preventDefault();
      setPeek(null);
      ctx.open(a.dataset.path, Number(a.dataset.start) || null);
    };
    const onOver = (e) => {
      const a = refOf(e);
      if (!a) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setPeek({ path: a.dataset.path, start: Number(a.dataset.start) || null, end: Number(a.dataset.end) || null, rect: a.getBoundingClientRect() }), 250);
    };
    const onOut = (e) => {
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
  }, [ctx, ...deps]);
  if (!ctx || !peek) return null;
  return <Peek n={ctx.n} at={peek} onEnter={() => clearTimeout(timer.current)} onLeave={() => setPeek(null)} />;
}
