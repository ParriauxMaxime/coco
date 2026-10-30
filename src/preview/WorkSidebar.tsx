import React, { useEffect, useRef } from 'react';
import { useWaiting } from './waiting.ts';
import SignalBadges from './SignalBadges.tsx';
import { NO_SIGNAL, ownPart, rowsTotal, workSignals } from './signals.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { AgentList, useArchive, useStopRun } from './AgentsSection.tsx';
import { agentOf, groupAgents, prLabel, useWorkAgents } from './agents.ts';
import type { AgentGroup } from './agents.ts';
import { isDone, prKey, prState, prTitle, rowIds } from './data.ts';
import { useMilestones } from './milestones.ts';
import { usePersistedList, workHref } from './prefs.ts';
import { findingsKeyOfTab, prOfTab } from '../workbench/code/ids.ts';
import { isLive, useJobs } from '../jobs.ts';
import type { WorkPr } from '../workbench/types.ts';
import type { SummaryRow, WorkSummary } from '../types.ts';

export const VIEWS: { id: string; label: string; icon: IconName }[] = [
  { id: 'plan', label: 'Overview', icon: 'home' },
  { id: 'stack', label: 'Stack', icon: 'list' },
  { id: 'findings', label: 'Findings', icon: 'flag' },
  { id: 'decisions', label: 'Decisions', icon: 'scale' },
  { id: 'timeline', label: 'Timeline', icon: 'history' },
  { id: 'notes', label: 'Notes', icon: 'notebook' },
  { id: 'artifacts', label: 'Artifacts', icon: 'folder' },
];

// fold ids carry a colon so no PR key can take them
const MERGED = ':merged';
const PLANNED = ':planned';

// id: the row key unless a sibling row landed on the same branch (see rowIds), which React keys and the open state need apart
type Row = { id: string; key: string; pr: WorkPr | null; state: string; ci: string | null; label: string; title: string };
type RowSeed = Omit<Row, 'id'>;
const withIds = (rows: RowSeed[]): Row[] => {
  const ids = rowIds(rows.map((r) => r.key));
  return rows.map((r, i) => ({ ...r, id: ids[i] }));
};

// the PR a tab is about: its page, review, findings, code, new agent or brief tab, or the PR of the agent it shows
const prOfFocus = (slug: string, tab: string) => {
  const k = prOfTab(tab) ?? findingsKeyOfTab(tab);
  if (k !== null) return String(k);
  const m = /^(?:pr|ask-new|brief)-(.+)$/.exec(tab);
  return m ? m[1] : (tab && agentOf(slug, tab)?.pr) || null;
};

type Props = {
  w: WorkSummary;
  open?: (id: string) => void;
  isOpen?: (id: string) => boolean;
  prs?: WorkPr[];
  focused?: string;
};

// a stack row of a work not open, from the overview's summary
const summaryRow = (r: SummaryRow): RowSeed => ({ key: r.key, pr: null, state: r.state, ci: r.ci, label: r.number ? `#${r.number}` : prLabel(r.key), title: r.title });

// a work's tree: its agents, then its open PRs, merged and planned ones folded; the views, Timeline, Notes and Artifacts open from
// the work's Overview, its tabs and ⌘K. Off its page each entry opens the work on that tab
export function WorkViews({ w, open, isOpen = () => false, prs = [], focused = '' }: Props) {
  const live = Boolean(open);
  const go = (id: string) => (open ? open(id) : (location.hash = `${workHref(w.slug)}/${id}`));
  const data = useWorkAgents(w.slug, live);
  const queue = useWaiting();
  const arc = useArchive(w.slug);
  const stop = useStopRun(w.slug);
  const groups = groupAgents(data?.agents || [], queue?.byAgent ?? {}, prs);
  const byPr = new Map<string | null, AgentGroup>(groups.map((g) => [g.pr, g]));
  const jobs = useJobs(w.slug);
  const listed = new Set((data?.agents || []).map((a) => a.agentId));
  const starting = (key: string | null) => jobs.filter((j) => j.kind === 'agent' && isLive(j) && j.pr === key && !(j.agentId && listed.has(j.agentId)));
  const steps = useMilestones(live ? w.slug : null);
  const { list, toggle, set } = usePersistedList(`cc.dp.tree.${w.slug}`, (l) => l);

  const stack: RowSeed[] = prs.length ? prs.map((pr) => ({ key: prKey(pr), pr, state: prState(pr), ci: pr.ci ?? null, label: pr.number ? `#${pr.number}` : prLabel(prKey(pr)), title: prTitle(pr) })) : (w.rows || []).map(summaryRow);
  const rows: Row[] = withIds([...stack, ...groups.filter((g) => g.pr !== null && !stack.some((r) => r.key === g.pr)).map((g) => ({ key: g.pr || '', pr: null, state: '', ci: null, label: g.label, title: g.title }))]);
  const signals = workSignals({ slug: w.slug, rows }, data?.agents || [], queue?.items || [], jobs);
  const at = (key: string) => signals.get(key) ?? NO_SIGNAL;
  const opened = rows.filter((r) => !isDone(r.state) && r.state !== 'planned');
  const merged = rows.filter((r) => isDone(r.state));
  const planned = rows.filter((r) => r.state === 'planned');

  // the focused tab's PR opens, with its fold; what opened that way closes again when the focus leaves, unless toggled by hand
  const focusKey = live ? prOfFocus(w.slug, focused) : null;
  const focusFold = focusKey === null ? null : merged.some((r) => r.key === focusKey) ? MERGED : planned.some((r) => r.key === focusKey) ? PLANNED : null;
  const auto = useRef<string[]>([]);
  useEffect(() => {
    const keep = [focusKey, focusFold].filter((x): x is string => x !== null);
    const gone = auto.current.filter((x) => !keep.includes(x));
    const add = keep.filter((x) => !list.includes(x));
    auto.current = [...auto.current.filter((x) => keep.includes(x)), ...add];
    if (gone.length || add.length) set((l) => [...l.filter((x) => !gone.includes(x)), ...add.filter((x) => !l.includes(x))]);
  }, [focusKey, focusFold]);
  const flip = (id: string) => { auto.current = auto.current.filter((x) => x !== id); toggle(id); };

  const caret = (id: string, on: boolean) => (
    <button type="button" className={`dp-caret${on ? ' dp-open' : ''}`} aria-label={on ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); flip(id); }}><Icon name="chevron-right" size={12} /></button>
  );

  const prRow = (r: Row) => {
    const on = list.includes(r.key);
    const g = byPr.get(r.key);
    const step = steps[r.key];
    const tip = [r.label, r.title].filter(Boolean).join(' ');
    const kids = Boolean(g || starting(r.key).length);
    return (
      <React.Fragment key={r.id}>
        <div className={`dp-view dp-pr${isOpen(`pr-${r.key}`) ? ' dp-open' : ''}`} title={tip} onClick={() => go(`pr-${r.key}`)}>
          {kids ? caret(r.key, on) : <span className="dp-caret-sp" />}
          <span className={`dp-dot dp-st-${r.state || 'closed'}${r.state === 'planned' || !r.state ? ' dp-hollow' : ''}`} />
          <span className={`dp-pr-n${r.pr?.number ? '' : ' dp-ell'}`}>{r.label}</span>
          <span className="dp-ell dp-grow">{r.title}</span>
          {step && <span className={`dp-ms-chip dp-ms-${step}`} title={`Current milestone: ${step}`}>{step}</span>}
          {/* unfolded, its agents show on their rows; the dot already says changes requested, so CI red alone flags */}
          <SignalBadges s={on && kids ? ownPart(at(r.key)) : at(r.key)} attention={r.ci === 'failure'} />
          <button type="button" className="dp-ibtn dp-row-add" title={`New agent on ${r.label}`} aria-label={`New agent on ${r.label}`} onClick={(e) => { e.stopPropagation(); go(`ask-new-${r.key}`); }}><Icon name="plus" size={12} /></button>
        </div>
        <div className={`dp-collapse${on ? ' dp-open' : ''}`}>
          <div className="dp-pr-kids">
            <AgentList g={g} onOpen={go} arc={arc} stop={stop} starting={starting(r.key)} />
          </div>
        </div>
      </React.Fragment>
    );
  };
  const fold = (id: string, label: string, rs: Row[]) => {
    if (!rs.length) return null;
    const on = list.includes(id);
    return (
      <>
        <div className="dp-view dp-pr-fold" onClick={() => flip(id)}>
          {caret(id, on)}<span className="dp-grow">{label}</span>
          {!on && <SignalBadges s={rowsTotal(signals, rs.map((r) => r.key))} />}
        </div>
        <div className={`dp-collapse${on ? ' dp-open' : ''}`}><div>{rs.map(prRow)}</div></div>
      </>
    );
  };

  const closed = merged.filter((r) => r.state === 'closed').length;
  const landed = merged.filter((r) => r.state === 'landed').length;
  return (
    <div className="dp-views">
      {data?.error && !groups.length && <div className="dp-ag-note">{data.error}</div>}
      <AgentList g={byPr.get(null)} onOpen={go} arc={arc} stop={stop} starting={starting(null)} />
      {opened.map(prRow)}
      {fold(MERGED, [[merged.length - closed - landed, 'merged'], [landed, 'landed'], [closed, 'closed']].filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(' · '), merged)}
      {fold(PLANNED, `${planned.length} planned`, planned)}
    </div>
  );
}
