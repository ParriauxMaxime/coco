import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { usePendingPermissions } from './chat/Permission.tsx';
import Icon from './Icon.tsx';
import { SidebarSubagents, SubagentCount } from './Subagents.tsx';
import { STATE_LABEL, groupAgents, reloadWorkAgents, useWorkAgents } from './agents.ts';
import type { AgentGroup, AgentState, ListedAgent } from './agents.ts';
import type { WorkPr } from '../workbench/types.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import { isLive, useJobs } from '../jobs.ts';

export const AgentDot = ({ state }: { state: AgentState }) => <span className={`dp-ag-dot dp-ag-${state}`} title={STATE_LABEL[state]} />;

const ARM_MS = 3000;
const BUSY: AgentState[] = ['running', 'waiting'];
const settled = (list: ListedAgent[]) => list.filter((a) => !BUSY.includes(a.state));

const ago = (at: string | null) => {
  const s = at ? (Date.now() - Date.parse(at)) / 1000 : NaN;
  if (!(s >= 0)) return '';
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

// first click arms the button for a few seconds, the second one archives
function useArchive(slug: string) {
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
type Archive = ReturnType<typeof useArchive>;

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
        <span className="dp-ag-ago">{ago(a.updatedAt)}</span>
        {arc && <ArchiveButton id={a.id} ids={[a.id]} arc={arc} title="Archive this agent" armedTitle={busy ? `It is ${STATE_LABEL[a.state]}: click again to archive it anyway` : 'Click again to archive'} />}
      </div>
      {subs > 0 && a.agentId && <SidebarSubagents agentId={a.agentId} />}
    </>
  );
}

function Group({ g, onOpen, onNew, arc }: { g: AgentGroup; onOpen: (id: string) => void; onNew: (pr: string | null) => void; arc: Archive }) {
  const [folded, setFolded] = useState(true);
  const done = settled(g.live);
  return (
    <div className="dp-ag-group">
      <div className="dp-ag-gh" title={g.title || undefined}>
        <span className="dp-ell dp-grow">
          {g.pr === null ? g.label : <button type="button" className="dp-ag-pr" title={`Open ${g.label} in coco`} onClick={() => useWorkbench.getState().open(`pr-${g.pr}`)}>{g.label}</button>}
          {g.title && <span className="dp-t3"> {g.title}</span>}
        </span>
        {done.length > 0 && <ArchiveButton id={`group:${g.pr ?? ''}`} ids={done.map((a) => a.id)} arc={arc} title={`Archive the ${done.length} idle agent${done.length === 1 ? '' : 's'} here`} armedTitle={`Click again to archive ${done.length}; working ones stay`} />}
        <button type="button" className="dp-ibtn dp-ag-add" title={g.pr === null ? 'New agent on the work' : `New agent on ${g.label}`} onClick={() => onNew(g.pr)}><Icon name="plus" size={12} /></button>
      </div>
      {g.live.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpen} arc={arc} />)}
      {g.archived.length > 0 && (
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

// the work's agents grouped Work then per PR, live first; a group's + opens a new agent tab on it, its archive button archives its idle agents
export default function AgentsSection({ slug, live, prs, onOpen }: { slug: string; live: boolean; prs: WorkPr[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const data = useWorkAgents(slug, live);
  const { pending } = usePendingPermissions();
  const arc = useArchive(slug);
  const groups = groupAgents(data?.agents || [], pending, prs);
  const all = groups.flatMap((g) => g.live);
  const waiting = all.filter((a) => a.state === 'waiting').length;
  const running = all.filter((a) => a.state === 'running').length;
  const done = settled(all);
  const onNew = (pr: string | null) => onOpen(pr === null ? 'ask' : `ask-new-${pr}`);
  // agents already list themselves; commands, syncs and setup steps show here while they run or after they failed
  const commands = useJobs(slug).filter((j) => j.kind !== 'agent' && (isLive(j) || j.state === 'failed' || j.state === 'lost'));
  return (
    <div className="dp-agents">
      <div className="dp-view dp-ag-head" onClick={() => setOpen((o) => !o)}>
        <span className={`dp-caret${open ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
        <Icon name="bot" size={14} /><span className="dp-grow">Agents</span>
        {running > 0 && <span className="dp-count" title={`${running} working`}>{running}</span>}
        {waiting > 0 && <span className="dp-count dp-acc" title={`${waiting} waiting on you`}>{waiting}</span>}
        {done.length > 0 && <ArchiveButton id="all" ids={done.map((a) => a.id)} arc={arc} title={`Archive the ${done.length} idle agent${done.length === 1 ? '' : 's'} of this work`} armedTitle={`Click again to archive ${done.length}; working ones stay`} />}
        <button type="button" className="dp-ibtn dp-ag-add" title="New agent  ⌘K" onClick={(e) => { e.stopPropagation(); onNew(null); }}><Icon name="plus" size={12} /></button>
      </div>
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}>
        <div className="dp-ag-list">
          {data?.error && !groups.length && <div className="dp-ag-note">{data.error}</div>}
          {data && !data.error && !groups.length && <div className="dp-ag-note">No agent yet: + starts one.</div>}
          {commands.length > 0 && (
            <div className="dp-ag-group">
              <div className="dp-ag-gh"><span className="dp-grow">Jobs</span></div>
              {commands.map((j) => (
                <div key={j.id} className="dp-view dp-ag" title={[j.label, j.error].filter(Boolean).join(' · ')}>
                  {isLive(j) ? <span className="dp-ag-dot dp-ag-running" /> : <span className="dp-ag-dot dp-ag-failed" />}
                  <span className="dp-ell dp-grow">{j.label}</span>
                  <span className="dp-ag-ago">{isLive(j) ? ago(j.startedAt) : j.state}</span>
                </div>
              ))}
            </div>
          )}
          {groups.map((g) => <Group key={g.pr ?? ''} g={g} onOpen={onOpen} onNew={onNew} arc={arc} />)}
        </div>
      </div>
    </div>
  );
}
