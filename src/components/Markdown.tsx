import React, { useEffect, useMemo, useRef, useState } from 'react';
import DiagramViewer from './DiagramViewer.tsx';
import { useCodeRefs } from './CodeRefs.tsx';
import { marked } from 'marked';
import mermaid from 'mermaid';
import { useTheme } from '../theme.ts';

marked.setOptions({ gfm: true, breaks: false });
const initMermaid = (resolved?: string) => mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: resolved === 'dark' ? 'dark' : 'neutral', fontFamily: 'Inter, sans-serif' });
initMermaid(document.documentElement.dataset.theme);

const fontsReady = document.fonts ? Promise.all([document.fonts.load('400 14px Inter'), document.fonts.load('italic 400 14px Inter'), document.fonts.ready]).catch(() => {}) : Promise.resolve();

const renderer = new marked.Renderer();
const baseCode = renderer.code.bind(renderer);
renderer.code = function (token) {
  const lang = token.lang || '';
  if (lang === 'mermaid') return `<pre class="mermaid">${token.text.replace(/</g, '&lt;')}</pre>`;
  return baseCode(token);
};

// nodes styled by the author (classDef, style) keep their colors
const toneNodes = (root: HTMLElement) => Array.from(root.querySelectorAll('g.node'))
  .filter((g) => g.classList.length <= 2 && !/fill/.test(g.querySelector('.label-container')?.getAttribute('style') || ''))
  .forEach((g, i) => g.classList.add(`tone-${i % 6}`));

export default function Markdown({ text }: { text?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => marked.parse(text || '', { renderer, async: false }), [text]);
  const [open, setOpen] = useState<string | null>(null);
  const { resolved } = useTheme();
  useEffect(() => {
    const all = ref.current?.querySelectorAll<HTMLElement>('pre.mermaid');
    if (!all?.length) return;
    // keep the source so a theme change can re-render the diagram
    all.forEach((n) => {
      if (n.dataset.src === undefined) n.dataset.src = n.textContent;
      else if (n.dataset.theme !== resolved) { n.textContent = n.dataset.src; n.removeAttribute('data-processed'); }
    });
    const nodes = Array.from(all).filter((n) => !n.hasAttribute('data-processed'));
    if (!nodes.length) return;
    nodes.forEach((n) => { n.dataset.theme = resolved; });
    initMermaid(resolved);
    // mermaid sizes labels with the font loaded at run time; Inter arrives later from a webfont and clips them
    fontsReady.then(() => mermaid.run({ nodes })).then(() => nodes.forEach(toneNodes)).catch(() => {});
  }, [html, resolved]);
  useEffect(() => {
    const root = ref.current;
    const onClick = (e: MouseEvent) => {
      const pre = e.target instanceof Element ? e.target.closest('pre.mermaid') : null;
      const svg = pre?.querySelector('svg');
      if (svg) setOpen(svg.outerHTML);
    };
    root?.addEventListener('click', onClick);
    return () => root?.removeEventListener('click', onClick);
  }, [html]);
  const peek = useCodeRefs(ref, [html]);
  return <>
    <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />
    {open && <DiagramViewer svg={open} onClose={() => setOpen(null)} />}
    {peek}
  </>;
}
