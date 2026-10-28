import React, { useEffect, useMemo, useRef, useState } from 'react';
import DiagramViewer from './DiagramViewer.tsx';
import { useCodeRefs } from './CodeRefs.tsx';
import { marked } from 'marked';
import type { Mermaid } from 'mermaid';
import { useTheme } from '../theme.ts';

marked.setOptions({ gfm: true, breaks: false });
let mermaidLib: Promise<Mermaid> | null = null;
const loadMermaid = () => (mermaidLib ??= import('mermaid').then((m) => m.default));
const initMermaid = (mermaid: Mermaid, resolved?: string) => mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: resolved === 'dark' ? 'dark' : 'neutral', fontFamily: 'Inter, sans-serif' });

const fontsReady = document.fonts ? Promise.all([document.fonts.load('400 14px Inter'), document.fonts.load('italic 400 14px Inter'), document.fonts.ready]).catch(() => {}) : Promise.resolve();

const renderer = new marked.Renderer();
const baseCode = renderer.code.bind(renderer);
renderer.code = function (token) {
  const lang = token.lang || '';
  if (lang === 'mermaid') return `<pre class="mermaid">${token.text.replace(/</g, '&lt;')}</pre>`;
  return baseCode(token);
};
const baseImage = renderer.image.bind(renderer);
// Paseo links images an agent read as file:// under its temp dir, which a browser won't load
const PASEO_ATTACHMENT = /^file:\/\/\/.+\/(paseo-attachments-[\w-]+)\/([a-f0-9]+\.\w+)$/;
renderer.image = function (token) {
  const m = PASEO_ATTACHMENT.exec(token.href);
  return baseImage(m ? { ...token, href: `/api/paseo-attachments/${m[1]}/${m[2]}` } : token);
};

// nodes styled by the author (classDef, style) keep their colors
const toneNodes = (root: HTMLElement) => Array.from(root.querySelectorAll('g.node'))
  .filter((g) => g.classList.length <= 2 && !/fill/.test(g.querySelector('.label-container')?.getAttribute('style') || ''))
  .forEach((g, i) => g.classList.add(`tone-${i % 6}`));

// a wide diagram in a narrow pane scrolls sideways at a readable scale instead of shrinking to a strip
const MIN_SCALE = 0.7;
const keepScale = (root: HTMLElement) => {
  const svg = root.querySelector('svg');
  const w = svg?.viewBox?.baseVal?.width;
  if (svg && w) svg.style.minWidth = `${Math.round(w * MIN_SCALE)}px`;
};

// one render at a time, each with its own id: mermaid's config is global and run() names every diagram by
// Date.now(), so two views (or two blocks of one post) rendering together drew into each other and lost their colors
let seq = 0;
let queue: Promise<void> = Promise.resolve();
const renderDiagrams = (nodes: HTMLElement[], resolved: string) => {
  nodes.forEach((n) => n.setAttribute('data-processed', 'true'));
  queue = queue.then(async () => {
    // mermaid sizes labels with the font loaded at run time; Inter arrives later from a webfont and clips them
    const [mermaid] = await Promise.all([loadMermaid(), fontsReady]);
    initMermaid(mermaid, resolved);
    for (const n of nodes) {
      if (!n.isConnected) continue;
      try {
        const { svg, bindFunctions } = await mermaid.render(`cc-mermaid-${++seq}`, (n.dataset.src || '').trim(), n);
        n.innerHTML = svg;
        bindFunctions?.(n);
        toneNodes(n);
        keepScale(n);
      } catch {}
    }
  }).catch(() => {});
};

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
    renderDiagrams(nodes, resolved);
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
