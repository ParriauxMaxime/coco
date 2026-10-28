import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import DispatchMenu from '../components/DispatchMenu.tsx';
import { isLive, useJobs } from '../jobs.ts';
import type { WorkPr } from '../workbench/types.ts';
import Icon from './Icon.tsx';
import PrChip from './PrChip.tsx';
import { Avatar, diffText, num } from './parts.tsx';
import { DevServerCell } from './widgets/DevServer.tsx';
import { agentsOf, devOf, findingsOf, pendingOf, prKey, prState, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import { usePrefs } from './prefs.ts';
import { reloadOverview } from './overview.ts';
import StackKeeper from './StackKeeper.tsx';
import { useMilestones } from './milestones.ts';
import './stack.css';

type Filter = 'all' | 'open' | 'merged' | 'planned';
type Item = { kind: 'pr'; pr: WorkPr; index: number } | { kind: 'more'; hidden: WorkPr[] } | { kind: 'fold' };

const NARROW_PX = 520;
const PLANNED_SHOWN = 2;
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'merged', label: 'Merged' }, { id: 'planned', label: 'Planned' }];
const isDone = (s: string) => s === 'merged' || s === 'closed';
const matches = (f: Filter, s: string) => f === 'all' || (f === 'open' ? !isDone(s) && s !== 'planned' : f === 'merged' ? isDone(s) : s === 'planned');

function CiCell({ pr }: { pr: WorkPr }) {
  if (!pr.number || isDone(prState(pr))) return <span className="dp-ci-none">{pr.number ? '–' : ''}</span>;
  if (pr.ci === 'success') return <span className="dp-ci-ok" title="CI passing"><Icon name="check" size={14} /></span>;
  if (pr.ci === 'failure') return <span className="dp-ci-bad" title="CI failing"><Icon name="x" size={14} /></span>;
  if (pr.ci === 'pending') return <span className="dp-ci-run" title="CI running"><Icon name="clock" size={14} /></span>;
  return <span className="dp-ci-none" title="No CI">–</span>;
}

function AgentsCell({ d, pr }: { d: PreviewData; pr: WorkPr }) {
  const agents = agentsOf(d, pr);
  const waiting = pendingOf(d, pr).length;
  const live = (id: string) => d.overview?.agents.find((a) => a.id === id)?.status === 'running';
  if (!pr.number && !agents.length) return <span className="dp-avs">{(pr.personas || []).slice(0, 3).map((p) => <Avatar key={p} login={p} />)}</span>;
  if (!agents.length) return <span className="dp-t4">–</span>;
  return (
    <>
      {agents.slice(0, waiting ? 1 : 2).map((a) => <span key={a.agentId} className={`dp-bot${live(a.agentId) ? ' dp-run' : ''}`} title={a.title || a.label}><Icon name="bot" size={12} /></span>)}
      {waiting > 0 && <span className="dp-count dp-acc" title={`${waiting} waiting on you`}>{waiting}</span>}
      {!waiting && agents.length > 2 && <span>+{agents.length - 2}</span>}
    </>
  );
}

function Row({ d, pr, index, step, working, selected, narrow, dispatching, onSelect, onOpen, onDispatch, onClose }: { d: PreviewData; pr: WorkPr; index: number; step: string | null; working: boolean; selected: boolean; narrow: boolean; dispatching: boolean; onSelect: () => void; onOpen: () => void; onDispatch: () => void; onClose: () => void }) {
  const state = prState(pr);
  const key = prKey(pr);
  const findings = findingsOf(d, pr).length;
  const threads = pr.unresolvedThreads || 0;
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!dispatching) return;
    const away = (e: MouseEvent) => { if (e.target instanceof Node && !pop.current?.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [dispatching]);
  return (
    <div className={`dp-srow dp-st-${state} dp-${state}${selected ? ' dp-sel' : ''}${dispatching ? ' dp-dispatching' : ''}`} data-key={key} onClick={onSelect} onDoubleClick={onOpen}>
      <span className="dp-ix">{index + 1}</span>
      <span className={`dp-dot${state === 'planned' ? ' dp-hollow' : ''}`} />
      <span><PrChip pr={pr} /></span>
      <span className="dp-ttl" title={prTitle(pr)}>{working && <span className="dp-ag-dot dp-ag-running dp-thr-spin dp-row-job" title="A job runs on this PR" />}{step &&<span className={`dp-ms-chip dp-ms-${step}`} title={`Current milestone: ${step}`}>{step}</span>}{prTitle(pr)}</span>
      {!narrow && <span className="dp-c-diff" title={diffText(pr)}>{pr.additions === undefined || !pr.number ? <span className="dp-t4">–</span> : <><span className="dp-add">+{num(pr.additions)}</span> <span className="dp-del">−{num(pr.deletions || 0)}</span></>}</span>}
      <span className="dp-c-ci"><CiCell pr={pr} /></span>
      <span className={`dp-c-th${threads ? ' dp-has' : ''}`} title="Unresolved threads">{pr.number && !isDone(state) ? (threads ? <><Icon name="message-square" size={12} />{threads}</> : <span className="dp-t4">–</span>) : null}</span>
      <span className={`dp-c-f${findings ? ' dp-has' : ''}`} title="Open findings">{findings ? <><Icon name="flag" size={12} />{findings}</> : null}</span>
      {!narrow && <span className="dp-c-ag"><AgentsCell d={d} pr={pr} /></span>}
      {!narrow && <span className="dp-c-dev">{d.dev.data?.on && <DevServerCell slug={d.slug} row={devOf(d, pr)} onChange={d.dev.reload} />}</span>}
      <span className="dp-c-go" ref={pop} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button type="button" className="dp-ibtn" title={state === 'planned' ? 'Open with an agent' : 'Start an agent'} onClick={onDispatch}><Icon name="play" size={14} /></button>
        {dispatching && (
          <div className="dp-pop dp-on">
            <DispatchMenu slug={d.slug} prKey={key} personas={pr.personas} onClose={onClose} />
          </div>
        )}
      </span>
    </div>
  );
}

export default function StackView({ d, selected, onSelect, onOpen }: { d: PreviewData; selected: string | null; onSelect: (key: string) => void; onOpen: (key: string) => void }) {
  const { planned: plannedPref, narrow: narrowPref } = usePrefs();
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState(false);
  const [dispatching, setDispatching] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [keeping, setKeeping] = useState(false);
  const restack = d.overview?.works.find((x) => x.slug === d.slug)?.progress.restack;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = narrowPref === 'drop' && width > 0 && width < NARROW_PX;
  const steps = useMilestones(d.slug);
  const jobs = useJobs(d.slug);
  const working = new Set(jobs.filter(isLive).map((j) => j.pr));

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    d.prs.forEach((pr) => { const s = prState(pr); c[s] = (c[s] || 0) + 1; });
    return c;
  }, [d.prs]);
  const done = (counts.merged || 0) + (counts.closed || 0);
  const planned = counts.planned || 0;
  const open = d.prs.length - done - planned;
  const foldable = plannedPref === 'fold' && filter !== 'planned' && planned > PLANNED_SHOWN;

  const items = useMemo(() => {
    const list: Item[] = [];
    const rows = d.prs.map((pr, index) => ({ pr, index })).filter(({ pr }) => matches(filter, prState(pr)));
    const hidden = foldable && !expanded ? rows.filter(({ pr }) => prState(pr) === 'planned').slice(PLANNED_SHOWN) : [];
    let more = false;
    rows.forEach(({ pr, index }) => {
      if (hidden.some((h) => h.pr === pr)) {
        if (!more) { list.push({ kind: 'more', hidden: hidden.map((h) => h.pr) }); more = true; }
        return;
      }
      list.push({ kind: 'pr', pr, index });
    });
    if (foldable && expanded) list.push({ kind: 'fold' });
    return list;
  }, [d.prs, filter, foldable, expanded]);

  const keys = items.flatMap((i) => (i.kind === 'pr' ? [prKey(i.pr)] : []));
  useEffect(() => {
    if (selected) root.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = selected ? keys.indexOf(selected) : -1;
      const next = keys[e.key === 'ArrowDown' ? Math.min(keys.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)];
      if (next !== undefined) onSelect(next);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && selected) {
      e.preventDefault();
      onOpen(selected);
    } else if (e.key === 'Escape') setDispatching(null);
  };

  const base = d.prs.find((p) => p.base)?.base;
  const title = d.work.w?.title;
  return (
    <div className={`dp-stack dp-fcol${narrow ? ' dp-narrow' : ''}`} ref={root} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="dp-vbar">
        <span className="dp-title dp-ell">{title || 'Stack'}</span>
        <div className="dp-filters">
          {FILTERS.map((f) => <button key={f.id} type="button" className={filter === f.id ? 'dp-on' : ''} onClick={() => setFilter(f.id)}>{f.label} <span>{f.id === 'all' ? d.prs.length : f.id === 'open' ? open : f.id === 'merged' ? done : planned}</span></button>)}
        </div>
        <span className="dp-sp" />
        {!narrow && <span className="dp-xs dp-t3 dp-num dp-counts">{[done && `${done} merged`, open && `${open} open`, planned && `${planned} planned`].filter(Boolean).join(' · ')}</span>}
        {restack && <button type="button" className="dp-btn dp-sm dp-restack" title="A parent PR merged: its children still sit on the old base" onClick={() => setKeeping(true)}><Icon name="git-branch" size={12} />Restack…</button>}
      </div>
      {keeping && <StackKeeper slug={d.slug} onClose={() => setKeeping(false)} onChange={() => { d.work.load(); void reloadOverview(); }} />}
      <div className="dp-stack-head">
        <div className="dp-grow">
          <div className="dp-segs dp-thin">{d.prs.map((pr, i) => <i key={i} className={`dp-st-${prState(pr)}`} />)}</div>
        </div>
      </div>
      <div className="dp-shead">
        <span /><span /><span>PR</span><span>Title</span>
        {!narrow && <span className="dp-c-diff">Diff</span>}
        <span title="CI">CI</span><span title="Unresolved threads"><Icon name="message-square" size={12} /></span><span title="Open findings"><Icon name="flag" size={12} /></span>
        {!narrow && <span className="dp-c-ag">Agents</span>}
        {!narrow && <span className="dp-c-dev" title={d.dev.data?.on === false ? d.dev.data.reason : 'Dev server'}>Dev</span>}
        <span />
      </div>
      {base && <div className="dp-sdiv">On {base}<span className="dp-t4">·</span><span style={{ fontWeight: 400 }}>stack order, base first</span></div>}
      {items.map((item) => {
        if (item.kind === 'fold') return <div key="fold" className="dp-srow dp-more" onClick={() => setExpanded(false)}><span className="dp-ix"><Icon name="chevron-down" size={12} /></span><span>Fold planned</span></div>;
        if (item.kind === 'more') return <div key="more" className="dp-srow dp-more" onClick={() => setExpanded(true)}><span className="dp-ix"><Icon name="chevron-right" size={12} /></span><span className="dp-ell">+{item.hidden.length} planned <span className="dp-t4">· {item.hidden.slice(0, 3).map(prTitle).join(', ')}{item.hidden.length > 3 ? ', …' : ''}</span></span></div>;
        const key = prKey(item.pr);
        return <Row key={`${key}-${item.index}`} d={d} pr={item.pr} index={item.index} step={steps[key] ?? null} working={working.has(key)} selected={key === selected} narrow={narrow} dispatching={dispatching === key} onSelect={() => onSelect(key)} onOpen={() => onOpen(key)} onDispatch={() => setDispatching(dispatching === key ? null : key)} onClose={() => setDispatching(null)} />;
      })}
      {items.length === 0 && <div className="dp-sdiv">{d.work.w ? 'Nothing here' : 'Loading…'}</div>}
    </div>
  );
}
