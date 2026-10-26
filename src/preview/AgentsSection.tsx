import React, { useState } from 'react';
import { usePendingPermissions } from './chat/Permission.tsx';
import Icon from './Icon.tsx';
import { STATE_LABEL, groupAgents, useWorkAgents } from './agents.ts';
import type { AgentGroup, AgentState, ListedAgent } from './agents.ts';
import type { WorkPr } from '../workbench/types.ts';

export const AgentDot = ({ state }: { state: AgentState }) => <span className={`dp-ag-dot dp-ag-${state}`} title={STATE_LABEL[state]} />;

const ago = (at: string | null) => {
  const s = at ? (Date.now() - Date.parse(at)) / 1000 : NaN;
  if (!(s >= 0)) return '';
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

function AgentRow({ a, onOpen }: { a: ListedAgent; onOpen: (id: string) => void }) {
  return (
    <div className="dp-view dp-ag" title={`${a.title} · ${a.kind} · ${STATE_LABEL[a.state]}`} onClick={() => onOpen(a.id)}>
      <AgentDot state={a.state} />
      <span className="dp-ell dp-grow">{a.title}</span>
      <span className="dp-ag-ago">{ago(a.updatedAt)}</span>
    </div>
  );
}

function Group({ g, onOpen, onNew }: { g: AgentGroup; onOpen: (id: string) => void; onNew: (pr: string | null) => void }) {
  const [folded, setFolded] = useState(true);
  return (
    <div className="dp-ag-group">
      <div className="dp-ag-gh" title={g.title || undefined}>
        <span className="dp-ell dp-grow">{g.label}{g.title && <span className="dp-t3"> {g.title}</span>}</span>
        <button type="button" className="dp-ibtn dp-ag-add" title={g.pr === null ? 'New agent on the work' : `New agent on ${g.label}`} onClick={() => onNew(g.pr)}><Icon name="plus" size={12} /></button>
      </div>
      {g.live.map((a) => <AgentRow key={a.id} a={a} onOpen={onOpen} />)}
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

// the work's agents grouped Work then per PR, live first; a group's + opens a new agent tab on it
export default function AgentsSection({ slug, live, prs, onOpen }: { slug: string; live: boolean; prs: WorkPr[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const data = useWorkAgents(slug, live);
  const { pending } = usePendingPermissions();
  const groups = groupAgents(data?.agents || [], pending, prs);
  const all = groups.flatMap((g) => g.live);
  const waiting = all.filter((a) => a.state === 'waiting').length;
  const running = all.filter((a) => a.state === 'running').length;
  const onNew = (pr: string | null) => onOpen(pr === null ? 'ask' : `ask-new-${pr}`);
  return (
    <div className="dp-agents">
      <div className="dp-view dp-ag-head" onClick={() => setOpen((o) => !o)}>
        <span className={`dp-caret${open ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
        <Icon name="bot" size={14} /><span className="dp-grow">Agents</span>
        {running > 0 && <span className="dp-count" title={`${running} working`}>{running}</span>}
        {waiting > 0 && <span className="dp-count dp-acc" title={`${waiting} waiting on you`}>{waiting}</span>}
        <button type="button" className="dp-ibtn dp-ag-add" title="New agent  ⌘K" onClick={(e) => { e.stopPropagation(); onNew(null); }}><Icon name="plus" size={12} /></button>
      </div>
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}>
        <div className="dp-ag-list">
          {data?.error && !groups.length && <div className="dp-ag-note">{data.error}</div>}
          {data && !data.error && !groups.length && <div className="dp-ag-note">No agent yet: + starts one.</div>}
          {groups.map((g) => <Group key={g.pr ?? ''} g={g} onOpen={onOpen} onNew={onNew} />)}
        </div>
      </div>
    </div>
  );
}
