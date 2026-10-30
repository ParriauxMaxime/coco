import React, { useState } from 'react';
import Markdown from '../../components/Markdown.tsx';
import { callsLabel, countCalls, groupActivity, groupCallsByTool, tallyLabel, toolLabel } from '../../components/activity.ts';
import type { ActivityItem } from '../../components/activity.ts';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import PermissionCard from './Permission.tsx';
import SubagentCallRow from './SubagentCall.tsx';
import { elapsed, isSubagentCall, useNow } from '../subagents.ts';
import { openLauncher } from '../launcher.ts';
import { usePrefs } from '../prefs.ts';
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

// what a row shows of a call: its summary cut short, a long path kept by its last two segments, a tool argument (JSON) left to the count
const brief = (s?: string) => {
  const t = (s ?? '').trim();
  if (!t || t.startsWith('{')) return '';
  if (t.length > 46 && t.includes('/')) return `…/${t.split('/').slice(-2).join('/')}`;
  return t.length > 52 ? `${t.slice(0, 52)}…` : t;
};

type RowProps = { icon: IconName; label: string; running: boolean; open?: boolean; onToggle: () => void; children?: React.ReactNode };
function Row({ icon, label, running, open = false, onToggle, children }: RowProps) {
  return (
    <div className={`dp-cv-act${running ? ' dp-run' : ''}${open ? ' dp-open' : ''}`}>
      <button type="button" className="dp-cv-actrow" aria-expanded={open} title={label} onClick={onToggle}>
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
// a permission, an error and the text the turn ends on stay out · a chat's turn (no from) splits its calls per tool, folds the narration in
// one notes row and keeps its closing words out
type Props = { events: ActivityEvent[]; active?: boolean; issues?: boolean; fold?: { from?: string; to?: string } };
// a chat drops the one-line chatter an agent emits between its calls (Emit., (Done.), Producing.): what it says at length stays
const CHATTER = 80;
export default function Activity({ events, active = false, issues: offer = false, fold }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const byTool = usePrefs((s) => s.calls) !== 'chrono';
  const now = useNow(1000, active && Boolean(fold?.from));
  const items = groupActivity(events, { active });
  const toggle = (i: number | string) => setOpen((o) => ({ ...o, [i]: !o[i] }));
  const last = items.at(-1);
  const settled = !(last && 'running' in last && last.running) && last?.kind !== 'live' && !(last?.kind === 'permission' && last.resolution === undefined);
  const threadTurn = fold?.from !== undefined;
  // the words a turn ends on, which always stay open
  const closing = items.findLast((it) => it.kind === 'live' || (it.kind === 'event' && it.event.type === 'text'));
  const shown = threadTurn ? items : items.filter((it) => it === closing || !(it.kind === 'event' && it.event.type === 'text' && (it.event.text ?? '').trim().length < CHATTER));
  const lastWork = shown.findLastIndex((it) => it.kind === 'tools' || it.kind === 'think');
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
    return <React.Fragment key={i}>{defaultEvent(it.event)}</React.Fragment>;
  };
  if (!fold || (lastWork < 0 && !active)) {
    return (
      <div className="dp-cv-acts">
        {shown.map(item)}
        {active && settled && <div className="dp-cv-act dp-run"><span className="dp-cv-actrow"><Spin /><span className="dp-cv-actl">Working…</span></span></div>}
      </div>
    );
  }
  // what a folded turn keeps in sight: a question no one answered yet, an error or a close, and the words it ends on; the narration above
  // them waits in a notes row, a thread's turn keeping only what it ends on
  const notes = new Set<ActivityItem>();
  if (!threadTurn) for (const it of shown) if (it !== closing && it.kind === 'event' && it.event.type === 'text') notes.add(it);
  const inSight = new Set(shown.filter((it, i) =>
    (it.kind === 'live' && (!threadTurn || i > lastWork)) ||
    (it.kind === 'permission' && it.resolution === undefined) ||
    (it.kind === 'event' && (
      it.event.type === 'closed' || it.event.type === 'end' || it.event.type === 'stderr' || Boolean(it.event.error) ||
      (it.event.type === 'text' && !notes.has(it) && (!threadTurn || i > lastWork))
    )),
  ));
  const calls = shown.flatMap((it) => (it.kind === 'tools' ? it.calls : []));
  const perTool = !threadTurn && byTool && calls.length > 1 && !shown.some((it) => it.kind === 'tools' && it.calls.some(isSubagentCall));
  const took = fold.from && (active || fold.to) ? elapsed(fold.from, active ? now : Date.parse(fold.to ?? '')) : '';
  const did = callsLabel(countCalls(calls));
  const step = lastWork >= 0 ? stepOf(shown[lastWork]) : '';
  const label = active ? [`Working${took && ` ${took}`}`, step].filter(Boolean).join(' · ') : [took && `Worked ${took}`, did].filter(Boolean).join(' · ') || 'Worked';
  // a turn is one summary row — its work opens on the rows per tool it used, or on its calls in order, and its thinking; then its narration, then the
  // words it ends on
  const thinks = shown.flatMap((it) => (it.kind === 'think' ? [it.text] : []));
  return (
    <div className="dp-cv-acts">
      <Row icon="activity" label={label} running={active} open={open.turn} onToggle={() => toggle('turn')}>
        <div className="dp-cv-acts">
          {perTool && groupCallsByTool(calls).map((g, gi) => {
            const summaries = g.mcp ? [] : g.calls.map((c) => brief(c.summary)).filter(Boolean).slice(0, 3);
            const more = g.calls.length - summaries.length;
            const count = g.mcp || g.name === 'browser' ? `${g.calls.length} call${g.calls.length > 1 ? 's' : ''}` : tallyLabel(g.counts);
            return (
              <Row key={`t${gi}`} icon="wrench" label={summaries.length ? `${g.name} · ${summaries.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : `${g.name} · ${count}`} running={active && g.calls.some((c) => c.status === 'running')} open={open[`t${gi}`]} onToggle={() => toggle(`t${gi}`)}>
                {g.calls.map((c, j) => <Call key={c.id || j} c={c} active={active} />)}
              </Row>
            );
          })}
          {perTool && thinks.length > 0 && (
            <Row icon="brain" label="Thinking" running={active && shown.some((it) => it.kind === 'think' && it.running)} open={open.thinking} onToggle={() => toggle('thinking')}>
              <div className="dp-cv-think">{thinks.join('\n\n')}</div>
            </Row>
          )}
          {shown.map((it, i) => (inSight.has(it) || notes.has(it) || (perTool && (it.kind === 'tools' || it.kind === 'think')) ? null : item(it, i)))}
        </div>
      </Row>
      {notes.size > 0 && (
        <Row icon="message-square" label={`${notes.size} note${notes.size > 1 ? 's' : ''}`} running={false} open={open.notes} onToggle={() => toggle('notes')}>
          {shown.map((it, i) => (notes.has(it) ? item(it, i) : null))}
        </Row>
      )}
      {shown.map((it, i) => (inSight.has(it) ? item(it, i) : null))}
    </div>
  );
}
