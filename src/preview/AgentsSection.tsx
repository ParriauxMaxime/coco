import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { ModelMark, SidebarSubagents, SubagentCount } from './Subagents.tsx';
import { runsOf } from './runs.ts';
import { ContextRing } from './Ring.tsx';
import { STATE_LABEL, reloadWorkAgents } from './agents.ts';
import type { AgentGroup, AgentState, ListedAgent } from './agents.ts';
import { isLive } from '../jobs.ts';
import type { Job } from '../types.ts';

export const AgentDot = ({ state }: { state: AgentState }) => <span className={`dp-ag-dot dp-ag-${state}`} title={STATE_LABEL[state]} />;

const ARM_MS = 3000;
const BUSY: AgentState[] = ['running', 'waiting'];
const settled = (list: ListedAgent[]) => list.filter((a) => !BUSY.includes(a.state));

export const ago = (at: string | null) => {
  const s = at ? (Date.now() - Date.parse(at)) / 1000 : NaN;
  if (!(s >= 0)) return '';
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

// first click arms the button for a few seconds, the second one acts
function useTwoClick<T>(act: (what: T) => Promise<void>) {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const click = (key: string, what: T) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (armed !== key) return setArmed(key);
    setArmed(null);
    void act(what);
  };
  return { armed, click };
}

export function useArchive(slug: string) {
  return useTwoClick(async (ids: string[]) => {
    try {
      const r = await api.archiveAgents(slug, ids);
      if (r.failed.length) toast.error(`${r.failed.length} not archived: ${r.failed[0].error}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    void reloadWorkAgents(slug);
  });
}
export type Archive = ReturnType<typeof useArchive>;

// a run stops from its chief: every busy worker first, then the chief (Paseo agent ids)
type RunStop = { workers: string[]; chief: string | null };
export function useStopRun(slug: string) {
  return useTwoClick(async ({ workers, chief }: RunStop) => {
    const stop = (ids: string[]) => Promise.allSettled(ids.map((id) => api.agentStop(id)));
    const missed = [...(await stop(workers)), ...(await stop(chief ? [chief] : []))].filter((r) => r.status === 'rejected');
    if (missed.length) toast.error(`${missed.length} not stopped: ${errorMessage(missed[0].reason)}`);
    void reloadWorkAgents(slug);
  });
}
export type StopRun = ReturnType<typeof useStopRun>;

function ArmButton<T>({ id, what, icon, ask, title, armedTitle, ctl }: { id: string; what: T; icon: IconName; ask: string; title: string; armedTitle: string; ctl: { armed: string | null; click: (key: string, what: T) => (e: React.MouseEvent) => void } }) {
  const on = ctl.armed === id;
  return (
    <button type="button" className={`dp-ibtn dp-ag-bin${on ? ' dp-on' : ''}`} title={on ? armedTitle : title} aria-label={on ? armedTitle : title} onClick={ctl.click(id, what)}>
      {on ? <span className="dp-ag-bin-q">{ask}</span> : <Icon name={icon} size={12} />}
    </button>
  );
}

// a parent's subagents fold under it: unfolded while one runs, folded once all are done, unless folded or unfolded by hand since
function useSubFold(running: number) {
  const [hand, setHand] = useState<boolean | null>(null);
  const busy = running > 0;
  useEffect(() => setHand(null), [busy]);
  return [hand ?? busy, () => setHand(!(hand ?? busy))] as const;
}

// a folded chief's workers: how many, and the most pressing state among them (waiting on you before working)
function WorkerCount({ workers }: { workers: ListedAgent[] }) {
  const waiting = workers.filter((w) => w.state === 'waiting').length;
  const working = workers.filter((w) => w.state === 'running').length;
  const tip = [`${workers.length} worker${workers.length === 1 ? '' : 's'}`, waiting && `${waiting} ${STATE_LABEL.waiting}`, working && `${working} working`].filter(Boolean).join(', ');
  return <span className="dp-sa-count dp-ag-runc" title={tip}><Icon name="bot" size={12} />{workers.length}{waiting ? <AgentDot state="waiting" /> : working > 0 && <span className="dp-ag-dot dp-ag-running dp-thr-spin" />}</span>;
}

// an agent, its workers (a chief's run) and its subagents folded under it; a worker row also names its model
function AgentRow({ a, onOpen, arc, stop, workers = [], worker = false }: { a: ListedAgent; onOpen: (id: string) => void; arc?: Archive; stop?: StopRun; workers?: ListedAgent[]; worker?: boolean }) {
  const busy = BUSY.includes(a.state);
  const live = Boolean(a.agentId) && a.state !== 'archived';
  const subs = live ? a.subagents?.running ?? 0 : 0;
  const total = live ? a.subagents?.total ?? 0 : 0;
  const kids = total + workers.length;
  const [open, flip] = useSubFold(subs);
  const busyWorkers = workers.filter((w) => w.agentId && BUSY.includes(w.state)).map((w) => w.agentId as string);
  const run: RunStop = { workers: busyWorkers, chief: busy ? a.agentId : null };
  const armed = arc?.armed === a.id || stop?.armed === a.id;
  return (
    <>
      <div className={`dp-view dp-ag${armed ? ' dp-ag-armed' : ''}${kids ? ' dp-ag-parent' : ''}`} title={`${a.title} · ${a.kind} · ${STATE_LABEL[a.state]}`} onClick={() => onOpen(a.id)}>
        {kids > 0 && <button type="button" className={`dp-caret${open ? ' dp-open' : ''}`} aria-label={open ? 'Fold its run' : 'Show its run'} onClick={(e) => { e.stopPropagation(); flip(); }}><Icon name="chevron-right" size={12} /></button>}
        <AgentDot state={a.state} />
        <span className="dp-ell dp-grow">{a.title}</span>
        {workers.length > 0 && !open && <WorkerCount workers={workers} />}
        {total > 0 && (open ? subs > 0 && <SubagentCount n={subs} /> : <span className="dp-sa-count" title={`${total} subagent${total === 1 ? '' : 's'}${subs ? `, ${subs} working` : ''}`}>⑂ {total}{subs > 0 && <span className="dp-ag-dot dp-ag-running dp-thr-spin" />}</span>)}
        {worker && <ModelMark provider={a.provider} />}
        {a.state !== 'archived' && <ContextRing used={a.contextTokens} max={a.contextMax} size={12} />}
        <span className="dp-ag-ago">{ago(a.updatedAt)}</span>
        {stop && busyWorkers.length > 0 && <ArmButton id={a.id} what={run} ctl={stop} icon="square" ask="Stop run?" title={`Stop its run: ${busyWorkers.length} worker${busyWorkers.length === 1 ? '' : 's'}${run.chief ? ', then this agent' : ''}`} armedTitle="Click again to stop every worker, then this agent" />}
        {arc && <ArmButton id={a.id} what={[a.id]} ctl={arc} icon="archive" ask="Archive?" title="Archive this agent" armedTitle={busy ? `It is ${STATE_LABEL[a.state]}: click again to archive it anyway` : 'Click again to archive'} />}
      </div>
      {kids > 0 && (
        <div className={`dp-collapse${open ? ' dp-open' : ''}`}>
          <div className="dp-sa-kids">
            {open && workers.map((w) => <AgentRow key={w.id} a={w} onOpen={onOpen} arc={arc} worker />)}
            {open && total > 0 && a.agentId && <SidebarSubagents agentId={a.agentId} />}
          </div>
        </div>
      )}
    </>
  );
}

export function JobRow({ j, tip }: { j: Job; tip?: string }) {
  return (
    <div className="dp-view dp-ag" title={[j.label, j.error, tip].filter(Boolean).join(' · ')}>
      <span className={`dp-ag-dot dp-ag-${isLive(j) ? 'running' : 'failed'}`} />
      <span className="dp-ell dp-grow">{j.label}</span>
      <span className="dp-ag-ago">{isLive(j) ? ago(j.startedAt) : j.state}</span>
    </div>
  );
}

const ARCHIVED_SHOWN = 10;
const newest = (a: ListedAgent, b: ListedAgent) => (b.updatedAt || '').localeCompare(a.updatedAt || '');

// a group's agents: working, waiting and idle ones, then the last 10 archived folded; a new agent starts from the + on the PR or
// work row, the tab strip or ⌘K. starting: agent jobs whose agent is not listed yet (worktree, brief and deps come before it)
export function AgentList({ g, onOpen, arc, stop, starting = [] }: { g: AgentGroup | undefined; onOpen: (id: string) => void; arc: Archive; stop?: StopRun; starting?: Job[] }) {
  const [folded, setFolded] = useState(true);
  if (!starting.length && (!g || (!g.live.length && !g.archived.length))) return null;
  const archived = [...(g?.archived ?? [])].sort(newest);
  const shown = archived.slice(0, ARCHIVED_SHOWN);
  return (
    <div className="dp-ag-group">
      {starting.map((j) => <JobRow key={j.id} j={j} tip="Starting: its chat opens once the agent runs" />)}
      {runsOf(g?.live ?? []).map(({ chief, workers }) => <AgentRow key={chief.id} a={chief} workers={workers} onOpen={onOpen} arc={arc} stop={stop} />)}
      {shown.length > 0 && (
        <>
          <div className="dp-view dp-ag-fold" onClick={() => setFolded((f) => !f)} title={archived.length > shown.length ? `The ${shown.length} last archived; the Agents page lists all ${archived.length}` : undefined}>
            <span className={`dp-caret${folded ? '' : ' dp-open'}`}><Icon name="chevron-right" size={12} /></span>
            <span>{archived.length > shown.length ? `Last ${shown.length} of ${archived.length} archived` : `${archived.length} archived`}</span>
          </div>
          <div className={`dp-collapse${folded ? '' : ' dp-open'}`}><div>{!folded && shown.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpen} />)}</div></div>
        </>
      )}
    </div>
  );
}
