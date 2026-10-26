import React, { useState } from 'react';
import Markdown from './Markdown.tsx';
import PermissionCard from './PermissionCard.tsx';
import { groupActivity, toolLabel } from './activity.ts';
import type { ActivityEvent } from '../types.ts';

const ICONS: Record<string, string[]> = {
  wrench: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  brain: ['M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z', 'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z', 'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4'],
  chevron: ['m9 18 6-6-6-6'],
};
const OUTPUT_MAX = 1500;

const Icon = ({ name, className = '' }: { name: string; className?: string }) => (
  <svg className={`ico ${className}`} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {ICONS[name].map((d) => <path key={d} d={d} />)}
  </svg>
);

type RowProps = { icon: string; label: string; running: boolean; open?: boolean; onToggle: () => void; children?: React.ReactNode };
function Row({ icon, label, running, open, onToggle, children }: RowProps) {
  return (
    <div className={`act${running ? ' running' : ''}${open ? ' open' : ''}`}>
      <button type="button" className="act-row" aria-expanded={open} onClick={onToggle}>
        <Icon name={icon} />
        <span className="act-label">{label}</span>
        {running ? <span className="spinner act-spin" aria-label="in progress" /> : <Icon name="chevron" className="act-caret" />}
      </button>
      {open && <div className="act-body">{children}</div>}
    </div>
  );
}

function Call({ c, active }: { c: ActivityEvent; active: boolean }) {
  const output = c.output && c.output.length > OUTPUT_MAX ? `${c.output.slice(0, OUTPUT_MAX)}…` : c.output;
  return (
    <div className="act-call">
      <div className="act-call-head">
        <b>{toolLabel(c.name)}</b>
        {c.summary && <code title={c.summary}>{c.summary}</code>}
        {c.status === 'running' && active && <span className="spinner act-spin" aria-label="running" />}
        {(c.status === 'failed' || c.status === 'canceled') && <span className={`chip ${c.status === 'failed' ? 'c-red' : 'c-grey'}`}>{c.status}</span>}
      </div>
      {c.input && c.input !== c.summary && <pre>{c.input}</pre>}
      {output && <pre className="act-out">{output}</pre>}
    </div>
  );
}

const END_NOTE: Record<string, string> = { closed: 'conversation closed: a new message starts a new agent with the conversation so far', idle: 'agent archived after an idle hour: a new message starts a new one with the conversation so far' };

// what an agent turn shows besides its tool and thinking rows: its text through coco's Markdown (diagrams, code refs, inline HTML), notes and the turn's end
export function defaultEvent(e: ActivityEvent) {
  if (e.type === 'text') return <div className="act-text"><Markdown text={e.text} /></div>;
  if (e.type === 'stderr') return <div className="status danger">{e.text}</div>;
  if (e.type === 'meta') return <div className="status" style={{ opacity: 0.6 }}>{e.text}</div>;
  if (e.type === 'end') return <div className="status">— {e.status}{e.cost != null ? ` · $${Number(e.cost).toFixed(3)}` : ''}{e.error ? ` · ${e.error}` : ''}</div>;
  if (e.type === 'closed') return <div className="status">— {(e.reason && END_NOTE[e.reason]) || e.reason}</div>;
  return null;
}

// one agent's activity, the same on every surface: Paseo-style rows for tool calls and thinking (expandable), text as coco renders it.
// active: the agent is working on it, so running rows spin and an empty or settled tail says it is working
type Props = { events: ActivityEvent[]; active?: boolean; renderEvent?: (e: ActivityEvent) => React.ReactNode };
export default function AgentActivity({ events, active = false, renderEvent = defaultEvent }: Props) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const items = groupActivity(events, { active });
  const toggle = (i: number) => setOpen((o) => ({ ...o, [i]: !o[i] }));
  const last = items.at(-1);
  return (
    <div className="act-list">
      {items.map((it, i) => {
        if (it.kind === 'tools') return <Row key={i} icon="wrench" label={it.label} running={it.running} open={open[i]} onToggle={() => toggle(i)}>{it.calls.map((c, j) => <Call key={c.id || j} c={c} active={active} />)}</Row>;
        if (it.kind === 'think') return <Row key={i} icon="brain" label="Thinking" running={it.running} open={open[i]} onToggle={() => toggle(i)}><div className="act-think">{it.text}</div></Row>;
        if (it.kind === 'live') return <div key={i} className="act-text"><Markdown text={it.text} /></div>;
        if (it.kind === 'permission') return it.event.request ? <PermissionCard key={i} agentId={it.event.agentId} request={it.event.request} resolution={it.resolution} /> : null;
        return <React.Fragment key={i}>{renderEvent(it.event)}</React.Fragment>;
      })}
      {active && !(last && 'running' in last && last.running) && last?.kind !== 'live' && !(last?.kind === 'permission' && last.resolution === undefined) && <div className="act act-working running"><span className="act-row"><span className="spinner act-spin" aria-hidden /><span className="act-label">Working…</span></span></div>}
    </div>
  );
}
