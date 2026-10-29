import React, { useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { callsLabel, countCalls, groupActivity, toolLabel } from '../../components/activity.ts';
import type { ActivityItem } from '../../components/activity.ts';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import PermissionCard from './Permission.tsx';
import SubagentCallRow from './SubagentCall.tsx';
import { elapsed, isSubagentCall, useNow } from '../subagents.ts';
import { openLauncher } from '../launcher.ts';
import type { ActivityEvent } from '../../types.ts';
import './chat.css';

const OUTPUT_MAX = 1500;

// a coco issue an agent flagged (cocopilot flag_coco_issue): its title, ask and the owner's words, and the finding's link once filed
type CocoIssue = { title: string; summary: string; quote: string; url: string | null };
export function cocoIssueOf(c: ActivityEvent): CocoIssue | null {
  if (!/(^|__)flag_coco_issue$/.test(c.name || '') || c.status !== 'completed') return null;
  let input: Partial<CocoIssue> = {};
  try {
    input = JSON.parse(c.input || c.summary || '{}');
  } catch {
    input = { title: /"title":"((?:[^"\\]|\\.)*)"/.exec(c.input || '')?.[1] };
  }
  const url = /"url":"([^"]+)"/.exec(c.output || '')?.[1] ?? null;
  return input.title ? { title: input.title, summary: input.summary || '', quote: input.quote || '', url } : null;
}
export const issueTask = (i: CocoIssue) => [`Fix this coco issue: ${i.title}`, i.summary, i.quote && `> ${i.quote.replace(/\n/g, '\n> ')}`, i.url && `Finding: ${i.url}`].filter(Boolean).join('\n\n');

function IssueRow({ issue }: { issue: CocoIssue }) {
  return (
    <div className="dp-cv-issue">
      <Icon name="flag" size={12} />
      <span className="dp-ell">Flagged on coco: {issue.url ? <a href={issue.url} title="Open the finding">{issue.title}</a> : issue.title}</span>
      <button type="button" className="dp-btn dp-sm" title="Open the New agent launcher on coco's checkout with this issue as its task; you still press Start" onClick={() => openLauncher({ place: 'app', text: issueTask(issue) })}><Icon name="bot" size={12} />Start an agent on it</button>
    </div>
  );
}
const Spin = () => <span className="dp-ag-dot dp-ag-running dp-cv-spin" aria-label="in progress" />;

type RowProps = { icon: IconName; label: string; running: boolean; open?: boolean; onToggle: () => void; children?: React.ReactNode };
function Row({ icon, label, running, open = false, onToggle, children }: RowProps) {
  return (
    <div className={`dp-cv-act${running ? ' dp-run' : ''}${open ? ' dp-open' : ''}`}>
      <button type="button" className="dp-cv-actrow" aria-expanded={open} onClick={onToggle}>
        <Icon name={icon} size={12} />
        <span className="dp-cv-actl">{label}</span>
        {running ? <Spin /> : <Icon name="chevron-right" size={12} className="dp-cv-caret" />}
      </button>
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}><div>{open && <div className="dp-cv-actb">{children}</div>}</div></div>
    </div>
  );
}

function Call({ c, active }: { c: ActivityEvent; active: boolean }) {
  const output = c.output && c.output.length > OUTPUT_MAX ? `${c.output.slice(0, OUTPUT_MAX)}…` : c.output;
  return (
    <div className="dp-cv-call">
      <div className="dp-cv-callh">
        <b>{toolLabel(c.name)}</b>
        {c.summary && <code className="dp-ell" title={c.summary}>{c.summary}</code>}
        {c.status === 'running' && active && <Spin />}
        {(c.status === 'failed' || c.status === 'canceled') && <span className={`dp-chip${c.status === 'failed' ? ' dp-bad' : ''}`}>{c.status}</span>}
      </div>
      {c.input && c.input !== c.summary && <pre className="dp-cv-pre">{c.input}</pre>}
      {output && <pre className="dp-cv-pre dp-cv-out">{output}</pre>}
    </div>
  );
}

// a run of tool calls with each subagent call taken out as its own row
function segments(calls: ActivityEvent[]) {
  const out: (ActivityEvent | ActivityEvent[])[] = [];
  for (const c of calls) {
    const last = out.at(-1);
    if (isSubagentCall(c)) out.push(c);
    else if (Array.isArray(last)) last.push(c);
    else out.push([c]);
  }
  return out;
}

const END_NOTE: Record<string, string> = { closed: 'conversation closed: a new message starts a new agent with the conversation so far', idle: 'agent archived after an idle hour: a new message starts a new one with the conversation so far' };

// what a turn shows besides its tool and thinking rows: its text, notes and the turn's end
export function defaultEvent(e: ActivityEvent) {
  if (e.type === 'text') return <div className="dp-cv-text"><Markdown text={e.text} /></div>;
  if (e.type === 'stderr') return <div className="dp-cv-note dp-cv-bad">{e.text}</div>;
  if (e.type === 'meta') return <div className="dp-cv-note dp-cv-faint">{e.text}</div>;
  if (e.type === 'step') return <div className="dp-cv-note dp-cv-faint dp-cv-step"><Icon name="clock" size={12} />{e.text}…</div>;
  if (e.type === 'end') return <div className="dp-cv-end"><span>{e.status}</span>{e.cost != null && <span className="dp-num">${Number(e.cost).toFixed(3)}</span>}{e.error && <span className="dp-cv-bad">{e.error}</span>}</div>;
  if (e.type === 'closed') return <div className="dp-cv-end"><span>{(e.reason && END_NOTE[e.reason]) || e.reason}</span></div>;
  return null;
}

// the step a folded turn is on
function stepOf(it: ActivityItem | undefined) {
  if (it?.kind === 'tools') {
    const c = it.calls.at(-1);
    return [toolLabel(c?.name), c?.summary].filter(Boolean).join(' ');
  }
  return it?.kind === 'think' ? 'Thinking' : 'Starting';
}

// one agent's activity, Paseo style: a row per run of tool calls or thinking (expandable), its text rendered.
// active: the agent is working on it, so running rows spin and an empty or settled tail says it is working
// issues: an Ask coco transcript, where a flagged coco issue offers to start an agent on it
// fold: one turn of a thread, its work (calls, thinking, narration) under one row timed from..to, naming the step under way;
// a permission, an error and the text the turn ends on stay out
type Props = { events: ActivityEvent[]; active?: boolean; issues?: boolean; renderEvent?: (e: ActivityEvent) => React.ReactNode; fold?: { from?: string; to?: string } };
export default function Activity({ events, active = false, issues: offer = false, renderEvent = defaultEvent, fold }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const now = useNow(1000, active && Boolean(fold?.from));
  const items = groupActivity(events, { active });
  const toggle = (i: number | string) => setOpen((o) => ({ ...o, [i]: !o[i] }));
  const tools = (calls: ActivityEvent[], key: number | string, label: string, running: boolean) => {
    const issues = offer ? calls.flatMap((c) => cocoIssueOf(c) ?? []) : [];
    const row = <Row key={key} icon="wrench" label={label} running={running} open={open[key]} onToggle={() => toggle(key)}>{calls.map((c, j) => <Call key={c.id || j} c={c} active={active} />)}</Row>;
    return issues.length ? <React.Fragment key={key}>{row}{issues.map((x) => <IssueRow key={x.title} issue={x} />)}</React.Fragment> : row;
  };
  const item = (it: ActivityItem, i: number) => {
    if (it.kind === 'tools' && !it.calls.some(isSubagentCall)) return tools(it.calls, i, it.label, it.running);
    if (it.kind === 'tools') return <React.Fragment key={i}>{segments(it.calls).map((s, j) => (Array.isArray(s) ? tools(s, `${i}.${j}`, callsLabel(countCalls(s)), active && s.some((c) => c.status === 'running')) : <SubagentCallRow key={s.id || `${i}.${j}`} c={s} active={active} />))}</React.Fragment>;
    if (it.kind === 'think') return <Row key={i} icon="brain" label="Thinking" running={it.running} open={open[i]} onToggle={() => toggle(i)}><div className="dp-cv-think">{it.text}</div></Row>;
    if (it.kind === 'live') return <div key={i} className="dp-cv-text"><Markdown text={it.text} /></div>;
    if (it.kind === 'permission') return it.event.request ? <PermissionCard key={i} agentId={it.event.agentId} request={it.event.request} resolution={it.resolution} /> : null;
    return <React.Fragment key={i}>{renderEvent(it.event)}</React.Fragment>;
  };
  const last = items.at(-1);
  const settled = !(last && 'running' in last && last.running) && last?.kind !== 'live' && !(last?.kind === 'permission' && last.resolution === undefined);
  const lastWork = items.findLastIndex((it) => it.kind === 'tools' || it.kind === 'think');
  if (!fold || (lastWork < 0 && !active)) {
    return (
      <div className="dp-cv-acts">
        {items.map(item)}
        {active && settled && <div className="dp-cv-act dp-run"><span className="dp-cv-actrow"><Spin /><span className="dp-cv-actl">Working…</span></span></div>}
      </div>
    );
  }
  const stays = (it: ActivityItem, i: number) => it.kind === 'permission' || (it.kind === 'event' && (it.event.type === 'closed' || it.event.type === 'stderr' || Boolean(it.event.error))) || (i > lastWork && (it.kind === 'live' || (it.kind === 'event' && it.event.type === 'text')));
  const took = fold.from && (active || fold.to) ? elapsed(fold.from, active ? now : Date.parse(fold.to ?? '')) : '';
  const did = callsLabel(countCalls(items.flatMap((it) => (it.kind === 'tools' ? it.calls : []))));
  const label = active ? `Working${took && ` ${took}`} · ${stepOf(items[lastWork])}` : [took && `Worked ${took}`, did].filter(Boolean).join(' · ') || 'Worked';
  return (
    <div className="dp-cv-acts">
      <Row icon="activity" label={label} running={active} open={open.turn} onToggle={() => toggle('turn')}>
        <div className="dp-cv-acts">{items.map((it, i) => (stays(it, i) ? null : item(it, i)))}</div>
      </Row>
      {items.map((it, i) => (stays(it, i) ? item(it, i) : null))}
    </div>
  );
}
