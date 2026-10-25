import React, { useEffect, useRef, useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { FindingBody } from '../../components/Blocks.tsx';
import Thread, { ThreadToggle, threadKey } from '../../components/Thread.tsx';
import { Confidence } from '../../components/Signals.tsx';
import { CodeRefScope } from '../../components/CodeRefs.tsx';
import { useAction, pendingClass } from '../../components/action.ts';
import { decisionBullet, isLive, validChoice } from '../../../server/decisions.ts';
import { useWork } from '../use-work.ts';
import type { ReactNode } from 'react';
import type { Decision, WorkDetail } from '../../types.ts';
import type { DecisionChoice, DecisionView } from '../types.ts';

export const decisionCounts = (w: Pick<WorkDetail, 'decisions'>) => {
  const live = (w.decisions || []).filter(isLive);
  return { taken: live.filter((d) => d.status === 'taken').length, total: live.length };
};

const takenMarkdown = (decisions: Decision[]) => decisions.filter((d) => d.status === 'taken' && isLive(d)).map(decisionBullet).join('\n');
const inFilter = (d: Decision, filter: string) => (filter === 'archived' ? !isLive(d) : isLive(d) && (filter === 'all' || (filter === 'taken') === (d.status === 'taken')));

const initialChoice = (d: DecisionView): DecisionChoice => d.choice || (d.rows ? Object.fromEntries(d.rows.flatMap((r): [string, string][] => (r.recommended ? [[r.key, r.recommended]] : []))) : d.recommended || '');

// content cut at `max` px with a "show more" toggle once it grows past it (mermaid diagrams render late)
function Clamp({ text, max = 140, children }: { text?: string; max?: number; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const inner = ref.current?.firstElementChild;
    if (!inner) return;
    const ro = new ResizeObserver(() => setLong(inner.scrollHeight > max + 40));
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text, max]);
  const closed = long && !open;
  return (
    <div className="decision-md">
      <div ref={ref} className={closed ? 'decision-clamp' : ''} style={closed ? { maxHeight: max } : undefined}>{children || <Markdown text={text} />}</div>
      {long && <button type="button" className="decision-more" onClick={() => setOpen(!open)}>{open ? 'show less' : 'show more'}</button>}
    </div>
  );
}

// typed blocks as on finding cards; a pending card shows its evidence open, a taken one folds it
function Evidence({ d, taken }: { d: DecisionView; taken: boolean }) {
  if (!d.blocks) return d.details ? <Clamp text={d.details} /> : null;
  return taken ? <Clamp max={160}><FindingBody r={d} /></Clamp> : <FindingBody r={d} />;
}

// an option's own explanation: shown for the highlighted option, behind a toggle for the others
function OptionDetails({ text, initial }: { text?: string; initial: boolean }) {
  const [open, setOpen] = useState<'' | 'clamped' | 'full'>(initial ? 'clamped' : '');
  if (!text) return null;
  if (open === 'clamped') return <Clamp text={text} max={100} />;
  if (open) return <div className="decision-md"><Markdown text={text} /></div>;
  return <button type="button" className="decision-more" onClick={() => setOpen('full')}>▸ details</button>;
}

// sub-decisions: one row each, the card options as columns
function RowsTable({ d, choice, onPick }: { d: DecisionView; choice?: DecisionChoice | null; onPick?: (choice: Record<string, string>) => void }) {
  const picked = typeof choice === 'object' && choice ? choice : {};
  return (
    <table className="decision-rows">
      <thead><tr><th />{d.options.map((o) => <th key={o.key}>{o.label}</th>)}</tr></thead>
      <tbody>
        {(d.rows || []).map((r) => (
          <tr key={r.key}>
            <td><div>{r.label} <Confidence value={r.confidence} label="confidence in the recommended pick" /></div><OptionDetails text={r.details} initial={false} /></td>
            {d.options.map((o) => (
              <td key={o.key} className={`pick ${r.recommended === o.key ? 'rec' : ''}`} title={r.recommended === o.key ? 'recommended' : ''}>
                <input type="radio" name={`${d.id}-${r.key}`} checked={picked[r.key] === o.key} disabled={!onPick} onChange={() => onPick?.({ ...picked, [r.key]: o.key })} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// reviewer opinions fold behind one line: the card leads with the question and the evidence
function Positions({ positions }: { positions?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const count = Object.keys(positions || {}).length;
  if (!count) return null;
  if (!open) return <button type="button" className="decision-more" onClick={() => setOpen(true)}>▸ {count} reviewer {count === 1 ? 'opinion' : 'opinions'}</button>;
  return (
    <div className="decision-positions">
      {Object.entries(positions || {}).map(([who, text]) => (
        <div key={who} className="decision-position"><strong>{who}</strong><Markdown text={text} /></div>
      ))}
    </div>
  );
}

type DecisionCardProps = { d: DecisionView; slug: string; onDecide: (body: Record<string, unknown>) => unknown; onReply?: () => unknown; talk?: boolean };

export function DecisionCard({ d, slug, onDecide, onReply, talk = false }: DecisionCardProps) {
  const [choice, setChoice] = useState<DecisionChoice>(() => initialChoice(d));
  const [rationale, setRationale] = useState(d.rationale || '');
  const { pending, busy, run: act } = useAction();
  const [talking, setTalking] = useState(talk);
  const key = threadKey.decision(d.id);
  const taken = d.status === 'taken';
  const chosen = d.options.find((o) => o.key === d.choice);
  const run = (what: string, body: Record<string, unknown>) => act(what, async () => onDecide(body));
  const archived = !isLive(d);
  const archive = <button className={`sm${pendingClass(pending === 'archive')}`} disabled={busy} title={archived ? 'back to the live cards' : 'overtaken by later work: out of counts, briefs and the review feed'} onClick={() => run('archive', { id: d.id, archived: !archived })}>{archived ? 'Unarchive' : 'Archive'}</button>;
  return (
    <CodeRefScope n={d.pr ?? undefined}>
    <div className={`card decision ${taken ? 'taken' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{d.title}</strong>
        <span className="row">
          {archived && <span className="chip">archived {d.archivedAt?.slice(0, 10)}</span>}
          <span className={`chip ${taken ? 'c-green' : 'c-orange'}`}>{taken ? `taken ${d.decidedAt?.slice(0, 10)}` : 'pending'}</span>
        </span>
      </div>
      <p className="sub" style={{ margin: '6px 0' }}>{d.question} <Confidence value={d.confidence} label="confidence in the recommendation" /></p>
      <Evidence d={d} taken={taken} />
      <Positions positions={d.positions} />
      {taken ? (
        <>
          {d.rows ? <RowsTable d={d} choice={d.choice} /> : (
            <>
              <div className="decision-choice">✓ {chosen?.label || (typeof d.choice === 'string' ? d.choice : '')}</div>
              <OptionDetails text={chosen?.details} initial={false} />
            </>
          )}
          {d.rationale && <div className="decision-rationale"><Markdown text={d.rationale} /></div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className={`sm${pendingClass(pending === 'reopen')}`} disabled={busy} onClick={() => run('reopen', { id: d.id, status: 'pending' })}>Reopen</button>
            {archive}
            <ThreadToggle slug={slug} threadKey={key} open={talking} onClick={() => setTalking(!talking)} />
            {d.source && <span className="status">source: {d.source}</span>}
          </div>
        </>
      ) : (
        <>
          {d.rows ? <RowsTable d={d} choice={choice} onPick={setChoice} /> : <div className="decision-options">
            {d.options.map((o) => (
              <div key={o.key} className={`decision-option ${choice === o.key ? 'on' : ''} ${o.key === d.recommended ? 'rec' : ''}`}>
                <label>
                  <input type="radio" name={d.id} value={o.key} checked={choice === o.key} onChange={() => setChoice(o.key)} />
                  <span>{o.label}</span>
                  {o.key === d.recommended && <span className="chip c-blue">recommended</span>}
                  <Confidence value={o.confidence} label="confidence this option is right" />
                </label>
                <OptionDetails text={o.details} initial={o.key === d.recommended} />
              </div>
            ))}
          </div>}
          <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="why (optional, markdown, goes to the notes and the timeline)" style={{ minHeight: 48, marginTop: 6 }} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className={`primary sm${pendingClass(pending === 'take')}`} disabled={busy || !validChoice(d, choice)} onClick={() => run('take', { id: d.id, choice, rationale })}>Take decision</button>
            {archive}
            <ThreadToggle slug={slug} threadKey={key} open={talking} onClick={() => setTalking(!talking)} />
            {d.source && <span className="status">source: {d.source}</span>}
          </div>
        </>
      )}
      {talking && <Thread slug={slug} threadKey={key} onSettled={onReply} />}
    </div>
    </CodeRefScope>
  );
}

export default function Decisions() {
  const { slug, w, decide, load } = useWork();
  const [filter, setFilter] = useState('pending');
  const [status, setStatus] = useState('');
  const all = w.decisions || [];
  const { taken, total } = decisionCounts(w);
  const shown = all.filter((d) => inFilter(d, filter));
  const copy = async () => {
    await navigator.clipboard.writeText(takenMarkdown(all));
    setStatus('taken decisions copied as markdown');
  };
  if (!total) return <div className="sub">No decision yet. Add a <code>decisions</code> array to the work JSON, or ask coco to propose some.</div>;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div className="row">
          <strong>{taken} / {total} taken</strong>
          {['pending', 'taken', 'all', 'archived'].map((f) => <button key={f} className={`sm ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f}</button>)}
        </div>
        <div className="row"><button className="sm" disabled={!taken} onClick={copy}>Copy taken as markdown</button><span className="status">{status}</span></div>
      </div>
      {shown.length === 0 && <div className="sub">Nothing {filter}.</div>}
      {shown.map((d) => <DecisionCard key={`${d.id}-${d.status}-${d.decidedAt || ''}`} d={d} slug={slug} onDecide={decide} onReply={load} />)}
    </>
  );
}
