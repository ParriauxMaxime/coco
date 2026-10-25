import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PaseoResponse } from '../types.ts';

const statusChip = (s: string) => (s === 'running' ? 'c-green' : s === 'idle' ? 'c-grey' : s === 'error' ? 'c-red' : 'c-orange');
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

export default function Projects() {
  const [data, setData] = useState<PaseoResponse | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const refresh = () => api.paseo().then(setData);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20000);
    return () => clearInterval(t);
  }, []);
  if (!data) return <div className="sub">Loading Paseo…</div>;
  const projects = [...data.projects].sort((a, b) => b.running - a.running || b.agentCount - a.agentCount || a.name.localeCompare(b.name));
  return (
    <>
      <h1>Projects <button onClick={refresh} style={{ marginLeft: 8 }}>Refresh</button></h1>
      <p className="sub">Synced from your local Paseo (<code>paseo project ls</code>, <code>workspace ls</code>, <code>ls</code>). A project with a <b>work</b> carries long-term context: stack, artifacts, personas, notes.</p>
      {data.error && <div className="card danger">{data.error}</div>}
      {projects.map((p) => (
        <div key={p.projectId} className="card">
          <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen({ ...open, [p.projectId]: !open[p.projectId] })}>
            <span>
              <b>{p.name}</b> <span className="chip c-grey">{p.kind}</span>
              {p.running > 0 && <span className="chip c-green">{p.running} running</span>}
              {p.agentCount > 0 && <span className="chip c-grey">{p.agentCount} agents</span>}
              <span className="chip c-blue">{p.workspaces.length} workspaces</span>
            </span>
            <span>
              {p.work ? (
                <a href={`#/work/${p.work.slug}`} onClick={(e) => e.stopPropagation()}><button className="primary">Work: {p.work.title}</button></a>
              ) : (
                <a href={`#/work/new/${p.projectId}/${encodeURIComponent(p.name)}`} onClick={(e) => e.stopPropagation()}><button>Attach a work</button></a>
              )}
            </span>
          </div>
          <div className="status">{short(p.path)}</div>
          {open[p.projectId] && (
            <div style={{ marginTop: 8 }}>
              {p.workspaces.map((w) => (
                <div key={w.workspaceId} className="list-item">
                  <b>{w.name}</b> <span className="chip c-grey">{w.isolation}</span>
                  <div className="status">{short(w.cwd)}</div>
                  {w.agents.map((a) => (
                    <div key={a.id} className="row" style={{ marginTop: 4, justifyContent: 'space-between' }}>
                      <span><span className={`chip ${statusChip(a.status)}`}>{a.status}</span> {a.name}</span>
                      <span className="status">{a.provider} · {a.created}</span>
                    </div>
                  ))}
                </div>
              ))}
              {p.workspaces.length === 0 && <span className="sub">No workspace.</span>}
            </div>
          )}
        </div>
      ))}
      {data.orphanAgents.length > 0 && (
        <>
          <h2>Agents outside a workspace</h2>
          <div className="card">
            {data.orphanAgents.map((a) => (
              <div key={a.id} className="list-item"><span className={`chip ${statusChip(a.status)}`}>{a.status}</span> {a.name} <span className="status">{short(a.cwdAbs)}</span></div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
