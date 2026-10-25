import React, { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LineRange, ReviewComment } from '../types.ts';
import './code.css';

type DiffLine = { kind: 'hunk' | 'meta' | 'add' | 'del' | 'ctx'; text: string; oldNo?: number; newNo?: number };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnified(unified: string | null | undefined) {
  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of String(unified || '').split('\n')) {
    const hunk = raw.match(HUNK);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
    } else if (!inHunk) {
      if (raw) lines.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    else if (raw.startsWith('\\')) lines.push({ kind: 'meta', text: raw });
    else if (raw.startsWith(' ')) lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return lines;
}

const DefaultCard = ({ comment }: { comment: ReviewComment }) => (
  <div className="cc-zone">
    <span className={`chip ${comment.status === 'open' ? 'c-blue' : 'c-grey'}`}>{comment.status}</span> {comment.body}
  </div>
);

// Phone fallback: server-side unified diff, comments on head lines only (side 'head')
type Props = {
  unified?: string;
  comments?: ReviewComment[];
  onCreateComment?: (range: LineRange & { side: 'head' }) => void;
  renderZone?: (comment: ReviewComment) => ReactNode;
};

export default function LiteDiff({ unified, comments = [], onCreateComment, renderZone }: Props) {
  const lines = useMemo(() => parseUnified(unified), [unified]);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const card = renderZone || ((c: ReviewComment) => <DefaultCard comment={c} />);
  const headComments = comments.filter((c) => c.side === 'head');

  const tap = (no?: number) => {
    if (!no) return;
    setRange((r) => (!r || r.start !== r.end ? { start: no, end: no } : { start: Math.min(r.start, no), end: Math.max(r.start, no) }));
  };
  const selected = (no?: number) => Boolean(range && no !== undefined && no >= range.start && no <= range.end);
  const lastNo = new Set(lines.flatMap((l) => (l.newNo ? [l.newNo] : [])));
  const shown = new Set<string>();

  const cardsAfter = (no: number) =>
    headComments
      .filter((c) => c.endLine === no && !shown.has(c.id))
      .map((c) => {
        shown.add(c.id);
        return <div key={c.id} className="ld-card">{card(c)}</div>;
      });

  if (!lines.length) return <div className="cc-editor-status">No textual diff.</div>;
  const rows = lines.map((l, i) => {
    if (l.kind === 'hunk' || l.kind === 'meta') return <span key={i} className={`ld-line ld-${l.kind}`}>{l.text}</span>;
    return (
      <React.Fragment key={i}>
        <span className={`ld-line ld-${l.kind}${selected(l.newNo) ? ' ld-picked' : ''}`}>
          <button type="button" className="ld-no" disabled={!l.newNo} onClick={() => tap(l.newNo)}>{l.newNo ?? ''}</button>
          <span className="ld-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
          {l.text}
        </span>
        {l.newNo && range && range.end === l.newNo && (
          <span className="ld-action">
            <button type="button" className="sm primary" onClick={() => { onCreateComment?.({ side: 'head', startLine: range.start, endLine: range.end }); setRange(null); }}>
              {range.start === range.end ? `Comment line ${range.start}` : `Comment lines ${range.start}–${range.end}`}
            </button>
          </span>
        )}
        {l.newNo && cardsAfter(l.newNo)}
      </React.Fragment>
    );
  });
  const orphans = headComments.filter((c) => !shown.has(c.id) && !lastNo.has(c.endLine));
  return (
    <>
      <pre className="lite-diff">{rows}</pre>
      {orphans.length > 0 && (
        <div className="ld-orphans">
          <h3>Other comments on this file</h3>
          {orphans.map((c) => <div key={c.id} className="ld-card">{card(c)}</div>)}
        </div>
      )}
    </>
  );
}
