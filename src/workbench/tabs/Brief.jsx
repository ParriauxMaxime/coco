import React, { useEffect, useState } from 'react';
import Markdown from '../../components/Markdown.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import { api } from '../../api.js';
import { useAction, pendingClass } from '../../components/action.js';
import { useWork } from '../use-work.js';
import { useWorkbench } from '../workbench-store.js';
import { keyLabel } from '../code/ids.js';

export const briefKeyOfTab = (id) => {
  const raw = id.slice('brief-'.length);
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

// the PR agent tab: the agent sitting in the PR worktree, the brief rendered from the work, start or hand off in the same workspace
export default function Brief({ tabId, group }) {
  const { slug, load } = useWork();
  const n = briefKeyOfTab(tabId);
  const open = useWorkbench((s) => s.open);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const { pending, busy, run } = useAction();
  const [handoff, setHandoff] = useState(false);
  const refresh = () => api.brief(slug, n, handoff).then((d) => { setData(d); setError(''); }, (e) => setError(e.message));
  useEffect(() => { refresh(); }, [slug, n, handoff]);

  const act = (action, ask) => (!ask || confirm(ask)) && run(action, async () => {
    const r = await api.briefAction(slug, n, action);
    await refresh();
    load();
    if (r.name) open(`artifact-${r.name}`, { preview: true, group });
  });

  if (error) return <div className="card danger">{error}</div>;
  if (!data) return <div className="sub">Rendering the brief…</div>;
  const { agent } = data;
  return (
    <div className="wb-plan">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Agent · {keyLabel(n)}</h2>
        <button className="sm" onClick={refresh}>↻</button>
      </div>
      <div className="card">
        <div className="status">{data.worktree ? <>Worktree <code>{data.worktree}</code></> : 'Branch not checked out: Start lets Paseo check it out in a new worktree.'}</div>
        <div className="row" style={{ marginTop: 6 }}>
          {agent ? <><span className={`chip ${agent.status === 'running' ? 'c-blue' : 'c-grey'}`}>{agent.status}</span><b>{agent.name || agent.shortId}</b><span className="status">{agent.shortId} · {agent.created}</span></> : <span className="status">No agent in this worktree.</span>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className={`sm${pendingClass(pending === 'save')}`} disabled={busy} onClick={() => act('save')}>Save brief</button>
          <button className={`sm primary${pendingClass(pending === 'start')}`} disabled={busy} onClick={() => act('start', agent ? `An agent already sits in this worktree (${agent.shortId}). Start another one with this brief?` : null)}>Start agent with this brief</button>
          {agent && <button className={`sm${pendingClass(pending === 'handoff')}`} disabled={busy || !data.worktree} title="Brief + branch state (heads, base, what landed, what is open, rebase commands) for a fresh agent in the same worktree" onClick={() => act('handoff', `Start a fresh agent in ${data.worktree} with a handoff from ${agent.shortId}? The old agent keeps running until you archive it.`)}>Handoff</button>}
        </div>
      </div>
      {data.stored.length > 0 && (
        <Collapsible level="pm" title={`Stored briefs · ${data.stored.length}`}>
          {data.stored.map((name) => <div key={name} className="list-item row" style={{ justifyContent: 'space-between' }}><code>{name}</code><button className="sm" onClick={() => open(`artifact-${name}`, { preview: true, group })}>view ▸</button></div>)}
        </Collapsible>
      )}
      {data.worktree && <span className="rv-seg">{[[false, 'brief'], [true, 'handoff preview']].map(([v, label]) => <button key={label} type="button" className={handoff === v ? 'on' : ''} onClick={() => setHandoff(v)}>{label}</button>)}</span>}
      <div className="card" style={{ marginTop: 8 }}><Markdown text={data.text} /></div>
    </div>
  );
}
