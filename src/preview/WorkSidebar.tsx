import React, { useEffect, useRef } from 'react';
import { itemsOf, useWaiting } from './waiting.ts';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { AgentList, JobRow, agentCounts, useArchive } from './AgentsSection.tsx';
import { agentOf, groupAgents, prLabel, useWorkAgents } from './agents.ts';
import type { AgentGroup } from './agents.ts';
import { isDone, prKey, prState, prTitle } from './data.ts';
import { useMilestones } from './milestones.ts';
import { usePersistedList, workHref } from './prefs.ts';
import { findingsKeyOfTab, prOfTab } from '../workbench/code/ids.ts';
import { isLive, useJobs } from '../jobs.ts';
import type { WorkPr } from '../workbench/types.ts';
import type { WorkSummary } from '../types.ts';
import { NavHead, NavRow } from './nav/NavLevels.tsx';
import { useWorkbench } from '../workbench/workbench-store.ts';

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
const OVERVIEW = ':overview';
const MERGED = ':merged';
const PLANNED = ':planned';

type Row = { key: string; pr: WorkPr | null; state: string; label: string; title: string };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// the PR a tab is about: its page, review, findings, code, new agent or brief tab, or the PR of the agent it shows
const prOfFocus = (slug: string, tab: string) => {
  const k = prOfTab(tab) ?? findingsKeyOfTab(tab);
  if (k !== null) return String(k);
  const m = /^(?:pr|ask-new|brief)-(.+)$/.exec(tab);
  return m ? m[1] : (tab && agentOf(slug, tab)?.pr) || null;
};

// the PR the open work's focused tab is about: the sidebar's PR level in a beta navigation mode
export function useFocusedPr(slug?: string) {
  const tab = useWorkbench((s) => (slug && s.slug === slug ? s.groups.find((g) => g.id === s.focused)?.active ?? '' : ''));
  return slug && tab ? prOfFocus(slug, tab) : null;
}

function Counts({ running, waiting, job }: { running: number; waiting: number; job?: boolean }) {
  return (
    <>
      {(job || running > 0) && <span className="dp-ag-dot dp-ag-running dp-thr-spin" title={[job && 'A job runs here', running > 0 && `${plural(running, 'agent')} working`].filter(Boolean).join(' · ')} />}
      {waiting > 0 && <span className="dp-count dp-acc" title={`${waiting} waiting on you`}>{waiting}</span>}
    </>
  );
}

// a beta navigation mode's sidebar level: 'work' lists the work's views and PRs, a PR key that PR's review, findings and agents; child is what Expand nests under a PR row
export type ViewsLevel = { part: string; child: (key: string) => React.ReactNode };

type Props = {
  w: WorkSummary;
  level?: ViewsLevel;
  open?: (id: string) => void;
  isOpen?: (id: string) => boolean;
  count?: (id: string) => number | undefined;
  prs?: WorkPr[];
  findings?: (key: string) => number;
  focused?: string;
};

// a work's tree: the Overview group (views, jobs, work agents), then its open PRs, merged and planned ones folded; off its page each entry opens the work on that tab
export function WorkViews({ w, level, open, isOpen = () => false, count, prs = [], findings, focused = '' }: Props) {
  const live = Boolean(open);
  const go = (id: string) => (open ? open(id) : (location.hash = `${workHref(w.slug)}/${id}`));
  const data = useWorkAgents(w.slug, live);
  const queue = useWaiting();
  const arc = useArchive(w.slug);
  const groups = groupAgents(data?.agents || [], queue?.byAgent ?? {}, prs);
  const byPr = new Map<string | null, AgentGroup>(groups.map((g) => [g.pr, g]));
  // agents working from the agent list, what waits on you from the waiting queue, by PR (null: the work itself)
  const countsAt = (key: string | null) => ({ running: agentCounts(byPr.get(key)).running, waiting: itemsOf(queue, w.slug, key).length });
  const jobs = useJobs(w.slug);
  const working = new Set(jobs.filter(isLive).map((j) => j.pr));
  // agents already list themselves; commands, syncs and setup steps show while they run or after they failed
  const commands = jobs.filter((j) => j.kind !== 'agent' && (isLive(j) || j.state === 'failed' || j.state === 'lost'));
  const listed = new Set((data?.agents || []).map((a) => a.agentId));
  const starting = (key: string | null) => jobs.filter((j) => j.kind === 'agent' && isLive(j) && j.pr === key && !(j.agentId && listed.has(j.agentId)));
  const steps = useMilestones(live ? w.slug : null);
  const { list, toggle, set } = usePersistedList(`cc.dp.tree.${w.slug}`, (l) => l);

  const rows: Row[] = [
    ...prs.map((pr) => ({ key: prKey(pr), pr, state: prState(pr), label: pr.number ? `#${pr.number}` : prLabel(prKey(pr)), title: prTitle(pr) })),
    ...groups.filter((g) => g.pr !== null && !prs.some((p) => prKey(p) === g.pr)).map((g) => ({ key: g.pr || '', pr: null, state: '', label: g.label, title: g.title })),
  ];
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
  const sum = (rs: Row[]) => rs.reduce((a, r) => { const c = countsAt(r.key); return { running: a.running + c.running, waiting: a.waiting + c.waiting, job: a.job || working.has(r.key) }; }, { running: 0, waiting: 0, job: false });

  const prRow = (r: Row) => {
    const on = list.includes(r.key);
    const g = byPr.get(r.key);
    const step = steps[r.key];
    const n = findings?.(r.key) || 0;
    const tip = [r.label, r.title].filter(Boolean).join(' ');
    return (
      <React.Fragment key={r.key}>
        <div className={`dp-view dp-pr${isOpen(`pr-${r.key}`) ? ' dp-open' : ''}`} title={tip} onClick={() => go(`pr-${r.key}`)}>
          {caret(r.key, on)}
          <span className={`dp-dot dp-st-${r.state || 'closed'}${r.state === 'planned' || !r.state ? ' dp-hollow' : ''}`} />
          <span className={`dp-pr-n${r.pr?.number ? '' : ' dp-ell'}`}>{r.label}</span>
          <span className="dp-ell dp-grow">{r.title}</span>
          {step && <span className={`dp-ms-chip dp-ms-${step}`} title={`Current milestone: ${step}`}>{step}</span>}
          <Counts {...countsAt(r.key)} job={working.has(r.key)} />
        </div>
        <div className={`dp-collapse${on ? ' dp-open' : ''}`}>
          <div className="dp-pr-kids">
            <div className={`dp-view${isOpen(`review-${r.key}`) ? ' dp-open' : ''}`} onClick={() => go(`review-${r.key}`)}><Icon name="file" size={14} /><span>Review code</span></div>
            <div className={`dp-view${isOpen(`findings-${r.key}`) ? ' dp-open' : ''}`} onClick={() => go(`findings-${r.key}`)}><Icon name="flag" size={14} /><span>Findings</span>{n > 0 && <span className="dp-count" title={`${n} open`}>{n}</span>}</div>
            <AgentList g={g} label={r.label} onOpen={go} onNew={() => go(`ask-new-${r.key}`)} arc={arc} starting={starting(r.key)} />
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
          {!on && <Counts {...sum(rs)} />}
        </div>
        <div className={`dp-collapse${on ? ' dp-open' : ''}`}><div>{rs.map(prRow)}</div></div>
      </>
    );
  };

  const ovOn = !list.includes(OVERVIEW);
  const closed = merged.filter((r) => r.state === 'closed').length;
  const landed = merged.filter((r) => r.state === 'landed').length;

  if (level?.part === 'work') {
    const prNav = (r: Row) => (
      <React.Fragment key={r.key}>
        <NavRow
          on={focusKey === r.key}
          onOpen={() => go(focusKey === r.key ? 'plan' : `pr-${r.key}`)}
          icon={<span className={`dp-dot dp-st-${r.state || 'closed'}${r.state === 'planned' || !r.state ? ' dp-hollow' : ''}`} />}
          title={r.title}
          sub={[r.label, steps[r.key]].filter(Boolean).join(' · ')}
          meta={<Counts {...countsAt(r.key)} job={working.has(r.key)} />}
        />
        {level.child(r.key)}
      </React.Fragment>
    );
    const group = (label: string, rs: Row[]) => rs.length > 0 && <><NavHead>{label}<span className="dp-count">{rs.length}</span></NavHead>{rs.map(prNav)}</>;
    return (
      <div className="dp-views dp-nlist">
        {VIEWS.map((v) => {
          const c = count ? count(v.id) : v.id === 'stack' ? w.stack || undefined : undefined;
          return <NavRow key={v.id} on={isOpen(v.id) && focused === v.id} onOpen={() => go(v.id)} icon={<Icon name={v.icon} size={14} />} title={v.label} meta={c !== undefined && <span className="dp-count">{c}</span>} />;
        })}
        {commands.length > 0 && <div className="dp-ag-group"><div className="dp-ag-gh"><span className="dp-grow">Jobs</span></div>{commands.map((j) => <JobRow key={j.id} j={j} />)}</div>}
        <AgentList g={byPr.get(null)} label="the work" onOpen={go} onNew={() => go('ask')} arc={arc} starting={starting(null)} />
        {group('Open PRs', opened)}
        {group('Done', merged)}
        {group('Planned', planned)}
      </div>
    );
  }
  if (level) {
    const r = rows.find((x) => x.key === level.part);
    const n = findings?.(level.part) || 0;
    return (
      <div className="dp-views dp-nlist">
        {r && <NavHead>{r.label} · {r.title}</NavHead>}
        <NavRow on={isOpen(`review-${level.part}`) && focused === `review-${level.part}`} onOpen={() => go(`review-${level.part}`)} icon={<Icon name="file" size={14} />} title="Review code" />
        <NavRow on={isOpen(`findings-${level.part}`) && focused === `findings-${level.part}`} onOpen={() => go(`findings-${level.part}`)} icon={<Icon name="flag" size={14} />} title="Findings" meta={n > 0 && <span className="dp-count" title={`${n} open`}>{n}</span>} />
        <AgentList g={byPr.get(level.part)} label={r?.label || level.part} onOpen={go} onNew={() => go(`ask-new-${level.part}`)} arc={arc} starting={starting(level.part)} />
      </div>
    );
  }
  return (
    <div className="dp-views">
      <div className={`dp-view dp-ov-head${isOpen('plan') ? ' dp-open' : ''}`} onClick={() => go('plan')}>
        {caret(OVERVIEW, ovOn)}
        <Icon name="home" size={14} /><span className="dp-grow">Overview</span>
        {!ovOn && <Counts {...countsAt(null)} job={commands.some(isLive)} />}
      </div>
      <div className={`dp-collapse${ovOn ? ' dp-open' : ''}`}>
        <div className="dp-ov-kids">
          {VIEWS.slice(1).map((v) => {
            const c = count ? count(v.id) : v.id === 'stack' ? w.stack || undefined : undefined;
            return (
              <div key={v.id} className={`dp-view${isOpen(v.id) ? ' dp-open' : ''}`} onClick={() => go(v.id)}>
                <Icon name={v.icon} size={14} /><span>{v.label}</span>
                {c !== undefined && <span className="dp-count">{c}</span>}
              </div>
            );
          })}
          {commands.length > 0 && (
            <div className="dp-ag-group">
              <div className="dp-ag-gh"><span className="dp-grow">Jobs</span></div>
              {commands.map((j) => <JobRow key={j.id} j={j} />)}
            </div>
          )}
          {data?.error && !groups.length && <div className="dp-ag-note">{data.error}</div>}
          <AgentList g={byPr.get(null)} label="the work" onOpen={go} onNew={() => go('ask')} arc={arc} starting={starting(null)} />
        </div>
      </div>
      {opened.map(prRow)}
      {fold(MERGED, [[merged.length - closed - landed, 'merged'], [landed, 'landed'], [closed, 'closed']].filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(' · '), merged)}
      {fold(PLANNED, `${planned.length} planned`, planned)}
    </div>
  );
}
