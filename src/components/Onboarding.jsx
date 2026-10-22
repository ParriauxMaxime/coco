import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const DISMISSED = 'cc.onboarded';
const dismissedIds = () => {
  try {
    const ids = JSON.parse(localStorage.getItem(DISMISSED));
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
};

// setup checklist on the Dashboard, first install or update: ticks derived by the server, a command to copy per step, or an agent that finishes the setup.
// Hide covers the steps open at that moment; a step that opens later, after an update, brings the card back.
export default function Onboarding() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedIds);
  const load = () => api.setup().then((d) => { setData(d); setError(''); }, (e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!data) return error ? <div className="card danger">Setup status: {error}</div> : null;
  const open = data.steps.filter((s) => !s.done).map((s) => s.id);
  if (!data.restart && !open.some((id) => !dismissed.includes(id))) return null;

  const startAgent = async () => {
    setBusy(true);
    try {
      setAgent(await api.setupAgent());
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(DISMISSED, JSON.stringify(open));
    setDismissed(open);
  };
  return (
    <div className="card onboarding">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Get cocopilot ready</b>
        <span className="row">
          <button type="button" className="sm" onClick={load}>Recheck</button>
          <button type="button" className="sm" onClick={dismiss}>Hide</button>
        </span>
      </div>
      {data.restart && <div className="sub">The config changed since the server started: restart it (<code>npm start</code>) to apply it.</div>}
      {data.steps.map((s) => (
        <div key={s.id} className="list-item">
          <span className={`gate ${s.done ? 'done' : ''}`}>{s.done ? '✓' : '○'} {s.label}{s.optional ? ' · optional' : ''}</span>
          {!s.done && <div className="sub" style={{ margin: '4px 0 0' }}>{s.hint}</div>}
          {!s.done && s.command && <div className="row" style={{ marginTop: 4 }}><code className="gate-cmd">{s.command}</code><button type="button" className="sm" onClick={() => navigator.clipboard?.writeText(s.command)}>copy</button></div>}
          {!s.done && s.id === 'work' && <div className="row" style={{ marginTop: 4 }}><a href="#/projects"><button type="button" className="sm">Attach a project</button></a><a href="#/inbox"><button type="button" className="sm">From a link</button></a></div>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={busy || Boolean(agent)} onClick={startAgent}>Ask an agent to finish the setup</button>
        {error && <span className="danger">{error}</span>}
        {agent && <span className="sub">Agent started{agent.agentId ? ` (${agent.agentId.slice(0, 8)})` : ''}: follow it in <a href="#/agents">Agents</a> or Paseo, then Recheck.</span>}
      </div>
    </div>
  );
}
