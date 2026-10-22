import React, { useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import Markdown from './Markdown.jsx';
import { useCodeRefs } from './CodeRefs.jsx';
import './blocks.css';

// typed blocks (server/blocks.mjs) drawn with cocopilot's tokens: one look for every finding, whoever wrote it
const KEEP = new Set(['STRONG', 'EM', 'CODE', 'DEL', 'BR']);
const MARKS = new Set(['RISK', 'WARN', 'OK', 'NOTE', 'MUTE']);
const TONE_LABEL = { risk: 'Risk', warn: 'Watch', ok: 'Fine', note: 'Note', mute: 'Aside' };

function clean(node) {
  for (const el of [...node.children]) {
    clean(el);
    if (MARKS.has(el.tagName)) {
      const mark = document.createElement('mark');
      mark.className = `bk-mark ${el.tagName.toLowerCase()}`;
      mark.append(...el.childNodes);
      el.replaceWith(mark);
    } else if (KEEP.has(el.tagName)) {
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
    } else {
      el.replaceWith(document.createTextNode(el.outerHTML));
    }
  }
}

// **bold**, *italic*, `code`, file refs and <risk|warn|ok|note|mute> marks; any other tag shows as text
export const inlineHtml = (text) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = marked.parseInline(String(text || ''));
  clean(tpl.content);
  return tpl.innerHTML;
};

export function Inline({ text, as: Tag = 'span', className }) {
  const html = useMemo(() => inlineHtml(text), [text]);
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

const Caption = ({ text }) => (text ? <Inline as="div" className="bk-caption" text={text} /> : null);
// every block opens on a section heading, so a long finding scans at a glance
const Heading = ({ text }) => (text ? <Inline as="div" className="bk-h" text={text} /> : null);
const where = (path, start, end) => `${path}${start ? `:${start}` : ''}${end && end !== start ? `-${end}` : ''}`;

function Suggestion({ b }) {
  const [copied, setCopied] = useState(false);
  const before = b.before == null ? [] : b.before.split('\n');
  const after = b.after.split('\n');
  const copy = () => navigator.clipboard?.writeText(b.after).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  return (
    <figure className="bk-suggest">
      <figcaption>
        <span className="bk-h">Suggested change</span>
        <code>{where(b.path, b.startLine, b.endLine)}</code>
        <span className="cc-spacer" />
        <button type="button" className="sm" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </figcaption>
      <pre>
        {before.map((l, i) => <div key={`b${i}`} className="del"><span className="gut">{b.startLine + i}</span><span className="sign">-</span>{l || ' '}</div>)}
        {after.map((l, i) => <div key={`a${i}`} className="add"><span className="gut" /><span className="sign">+</span>{l || ' '}</div>)}
      </pre>
      <Caption text={b.caption} />
    </figure>
  );
}

const cellText = (c) => (typeof c === 'string' ? c : c.text);
function Table({ b }) {
  const [sort, setSort] = useState(null);
  const rows = useMemo(() => {
    if (!sort) return b.rows;
    const dir = sort.desc ? -1 : 1;
    return [...b.rows].sort((x, y) => dir * cellText(x[sort.col]).localeCompare(cellText(y[sort.col]), undefined, { numeric: true }));
  }, [b.rows, sort]);
  const by = (col) => setSort(sort?.col === col ? (sort.desc ? null : { col, desc: true }) : { col, desc: false });
  return (
    <figure className="bk-table">
      <Heading text={b.caption} />
      <table>
        <thead><tr>{b.columns.map((c, i) => <th key={i} onClick={() => by(i)} title="sort">{c}{sort?.col === i ? (sort.desc ? ' ▾' : ' ▴') : ''}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={typeof c === 'string' ? '' : `bk-cell ${c.tone || ''}`}><Inline text={cellText(c)} /></td>)}</tr>)}</tbody>
      </table>
    </figure>
  );
}

function Block({ b }) {
  if (b.type === 'text') return <Inline as="p" className="bk-text" text={b.text} />;
  if (b.type === 'callout') return <div className={`bk-callout ${b.tone}`}><b>{b.title || TONE_LABEL[b.tone]}</b> <Inline text={b.text} /></div>;
  if (b.type === 'steps') return (
    <div className="bk-steps">
      <Heading text={b.title || 'Steps'} />
      <ol>{b.items.map((s, i) => <li key={i}><Inline text={s} /></li>)}</ol>
      {b.outcome && <div className="bk-outcome"><span>⟶</span> <Inline text={b.outcome} /></div>}
    </div>
  );
  if (b.type === 'diagram') return <figure className="bk-figure"><Heading text={b.caption || 'Flow'} /><Markdown text={`\`\`\`mermaid\n${b.mermaid}\n\`\`\``} /></figure>;
  if (b.type === 'code') return (
    <figure className="bk-figure">
      <Heading text={b.caption || 'Code'} />
      {b.path && <figcaption><code>{where(b.path, b.line)}</code></figcaption>}
      <Markdown text={`\`\`\`${b.lang || ''}\n${b.code}\n\`\`\``} />
    </figure>
  );
  if (b.type === 'suggestion') return <Suggestion b={b} />;
  if (b.type === 'table') return <Table b={b} />;
  if (b.type === 'media') return (
    <figure className="bk-media">
      {b.kind === 'video' ? <video src={b.src} controls preload="metadata" /> : <a href={b.src} target="_blank" rel="noreferrer"><img src={b.src} alt={b.caption || 'screenshot'} loading="lazy" /></a>}
      <Caption text={b.caption} />
    </figure>
  );
  return null;
}

export default function Blocks({ blocks }) {
  const ref = useRef(null);
  const peek = useCodeRefs(ref, [blocks]);
  return <div ref={ref} className="bk">{blocks.map((b, i) => <Block key={i} b={b} />)}{peek}</div>;
}

// a finding posted through the coco-findings skill: class and the fix up top, the evidence blocks, then where it came from
// "Existing bug on master (security, cross-team)" → the class, then one chip per qualifier; security reads red
function Category({ text }) {
  const [, main = text, rest = ''] = /^(.*?)\s*\((.*)\)\s*$/.exec(text) || [];
  const tags = rest.split(/\s*,\s*/).filter(Boolean);
  return (
    <div className="bk-cat">
      <span className={/security/i.test(text) ? 'risk' : ''}>{main}</span>
      {tags.map((t) => <span key={t} className={`bk-tag ${/security/i.test(t) ? 'risk' : ''}`}>{t}</span>)}
    </div>
  );
}

export function FindingBody({ r }) {
  return (
    <div className="bk-finding">
      {r.summary && <Inline as="p" className="bk-lede" text={r.summary} />}
      {(r.category || r.recommendation) && (
        <div className="bk-head">
          {r.category && <Category text={r.category} />}
          {r.recommendation && <div className="bk-fix"><span className="bk-fix-label">Fix</span><Inline text={r.recommendation} /></div>}
        </div>
      )}
      <Blocks blocks={r.blocks} />
      {r.sources?.length > 0 && <div className="bk-sources">from {r.sources.map((s, i) => <span key={i}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a> : s.label}{s.path && <> <code>{s.path}</code></>}</span>)}</div>}
    </div>
  );
}
