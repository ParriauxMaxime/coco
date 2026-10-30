import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import Icon from './Icon.tsx';
import { SidebarSubagents, SubagentCount } from './Subagents.tsx';
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

// first click arms the button for a few seconds, the second one archives
export function useArchive(slug: string) {
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(null), ARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const run = async (ids: string[]) => {
    try {
      const r = await api.archiveAgents(slug, ids);
      if (r.failed.length) toast.error(`${r.failed.length} not archived: ${r.failed[0].error}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    void reloadWorkAgents(slug);
  };
  const click = (key: string, ids: string[]) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!ids.length) return;
    if (armed !== key) return setArmed(key);
    setArmed(null);
    void run(ids);
  };
  return { armed, click };
}
export type Archive = ReturnType<typeof useArchive>;

function ArchiveButton({ id, ids, title, armedTitle, arc }: { id: string; ids: string[]; title: string; armedTitle: string; arc: Archive }) {
  const on = arc.armed === id;
  return (
    <button type="button" className={`dp-ibtn dp-ag-bin${on ? ' dp-on' : ''}`} title={on ? armedTitle : title} aria-label={on ? armedTitle : title} onClick={arc.click(id, ids)}>
      {on ? <span className="dp-ag-bin-q">Archive?</span> : <Icon name="archive" size={12} />}
    </button>
  );
}

function AgentRow({ a, onOpen, arc }: { a: ListedAgent; onOpen: (id: string) => void; arc?: Archive }) {
  const busy = BUSY.includes(a.state);
  const subs = a.agentId && a.state !== 'archived' ? a.subagents?.running ?? 0 : 0;
  return (
    <>
      <div className={`dp-view dp-ag${arc?.armed === a.id ? ' dp-ag-armed' : ''}`} title={`${a.title} · ${a.kind} · ${STATE_LABEL[a.state]}`} onClick={() => onOpen(a.id)}>
        <AgentDot state={a.state} />
        <span className="dp-ell dp-grow">{a.title}</span>
        {subs > 0 && <SubagentCount n={subs} />}
        {a.state !== 'archived' && <ContextRing used={a.contextTokens} max={a.contextMax} size={12} />}
        <span className="dp-ag-ago">{ago(a.updatedAt)}</span>
        {arc && <ArchiveButton id={a.id} ids={[a.id]} arc={arc} title="Archive this agent" armedTitle={busy ? `It is ${STATE_LABEL[a.state]}: click again to archive it anyway` : 'Click again to archive'} />}
      </div>
      {subs > 0 && a.agentId && <SidebarSubagents agentId={a.agentId} />}
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

// a group's agents, live first then its archived fold; + opens a new agent tab on its PR or the work, the archive button archives its idle agents;
// starting: agent jobs whose agent is not listed yet (worktree, brief and deps come before it)
export function AgentList({ g, label, onOpen, onNew, arc, starting = [] }: { g: AgentGroup | undefined; label: string; onOpen: (id: string) => void; onNew: () => void; arc: Archive; starting?: Job[] }) {
  const [folded, setFolded] = useState(true);
  if (!starting.length && (!g || (!g.live.length && !g.archived.length))) return <div className="dp-view dp-ag-new" title={`New agent on ${label}`} onClick={onNew}><Icon name="plus" size={12} /><span>New agent</span></div>;
  const done = settled(g?.live ?? []);
  return (
    <div className="dp-ag-group">
      <div className="dp-ag-gh">
        <Icon name="bot" size={12} /><span className="dp-grow">Agents</span>
        {done.length > 0 && <ArchiveButton id={`group:${g?.pr ?? ''}`} ids={done.map((a) => a.id)} arc={arc} title={`Archive the ${done.length} idle agent${done.length === 1 ? '' : 's'} here`} armedTitle={`Click again to archive ${done.length}; working ones stay`} />}
        <button type="button" className="dp-ibtn dp-ag-add" title={`New agent on ${label}`} onClick={onNew}><Icon name="plus" size={12} /></button>
      </div>
      {starting.map((j) => <JobRow key={j.id} j={j} tip="Starting: its chat opens once the agent runs" />)}
      {g?.live.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpen} arc={arc} />)}
      {g && g.archived.length > 0 && (
        <>
          <div className="dp-view dp-ag-fold" onClick={() => setFolded((f) => !f)}>
            <span className={`dp-caret${folded ? '' : ' dp-open'}`}><Icon name="chevron-right" size={12} /></span>
            <span>{g.archived.length} archived</span>
          </div>
          <div className={`dp-collapse${folded ? '' : ' dp-open'}`}><div>{g.archived.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpen} />)}</div></div>
        </>
      )}
    </div>
  );
}
