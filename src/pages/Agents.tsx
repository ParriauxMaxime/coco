import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

const statusChip = (s) => (s === 'running' ? 'c-green' : s === 'idle' ? 'c-grey' : s === 'error' ? 'c-red' : 'c-orange');

export default function Agents() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [log, setLog] = useState('');
  const refresh = () => api.agents().then(setData);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);
  const show = async (id) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setLog('loading…');
    const r = await api.agentActivity(id);
    setLog(r.ok ? r.out : r.err || 'no output');
  };
  if (!data) return <div className="sub">Loading…</div>;
  const byWs = Object.fromEntries((data.workspaces || []).map((w) => [w.cwd, w]));
  return (
    <>
      <h1>Agents <button onClick={refresh} style={{ marginLeft: 8 }}>Refresh</button></h1>
      <p className="sub">From <code>paseo ls --json</code>, refreshed every 15 s. Tap an agent for its recent log.</p>
      {data.error && <div className="card danger">{data.error}</div>}
      <div className="card">
        {(data.agents || []).map((a) => {
          const ws = byWs[a.cwd];
          return (
            <div key={a.id} className="list-item">
              <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => show(a.id)}>
                <span><span className={`chip ${statusChip(a.status)}`}>{a.status}</span> <b>{a.name}</b></span>
                <span className="status">{a.provider} · {a.thinking} · {a.created}</span>
              </div>
              <div className="status">{ws ? `${ws.project} / ${ws.name}` : a.cwd} · <code>{a.shortId}</code></div>
              {open === a.id && <pre style={{ maxHeight: 400, overflow: 'auto', marginTop: 6 }}>{log}</pre>}
            </div>
          );
        })}
      </div>
      <h2>Workspaces</h2>
      <div className="card">
        {(data.workspaces || []).map((w) => (
          <div key={w.workspaceId} className="list-item"><b>{w.project}</b> · {w.name} <span className="chip c-grey">{w.isolation}</span><div className="status">{w.cwd}</div></div>
        ))}
      </div>
    </>
  );
}
