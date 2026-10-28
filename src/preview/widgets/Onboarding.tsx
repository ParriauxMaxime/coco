import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import { ErrorNote } from '../pages/Page.tsx';
import type { SetupStatus, StartedAgent } from '../../types.ts';
import './widgets.css';

const DISMISSED = 'cc.onboarded';
const dismissedIds = (): string[] => {
  try {
    const ids = JSON.parse(localStorage.getItem(DISMISSED) ?? 'null');
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
};

// setup checklist, first install or update: ticks derived by the server, a command to copy per step, or an agent that finishes the setup.
// Hide covers the steps open at that moment; a step that opens later, after an update, brings it back.
export default function Onboarding() {
  const [data, setData] = useState<SetupStatus | null>(null);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState<StartedAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedIds);
  const load = () => api.setup().then((d) => { setData(d); setError(''); }, (e) => setError(errorMessage(e)));
  useEffect(() => {
    load();
  }, []);
  if (!data) return error ? <div className="dp-ob-gap"><ErrorNote>Setup status: {error}</ErrorNote></div> : null;
  const open = data.steps.filter((s) => !s.done).map((s) => s.id);
  if (!data.restart && !open.some((id) => !dismissed.includes(id))) return null;

  const startAgent = async () => {
    setBusy(true);
    try {
      setAgent(await api.setupAgent());
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(DISMISSED, JSON.stringify(open));
    setDismissed(open);
  };
  const done = data.steps.length - open.length;
  return (
    <div className="dp-box dp-ob">
      <div className="dp-ob-h">
        <span className="dp-ob-ic"><Icon name="sparkles" size={14} /></span>
        <b>Get cocopilot ready</b>
        <span className="dp-chip">{done}/{data.steps.length}</span>
        <span className="dp-sp" />
        <button type="button" className="dp-btn dp-sm" onClick={load}><Icon name="refresh" size={12} />Recheck</button>
        <button type="button" className="dp-btn dp-ghost dp-sm" onClick={dismiss}>Hide</button>
      </div>
      {data.restart && <div className="dp-ob-restart"><Icon name="alert-triangle" size={12} /><span>The config changed since the server started: restart it (<code>npm start</code>) to apply it.</span></div>}
      <div className="dp-ob-steps">
        {data.steps.map((s) => (
          <div key={s.id} className={`dp-ob-step${s.done ? ' dp-ob-done' : ''}`}>
            <span className="dp-ob-tick">{s.done && <Icon name="check" size={12} />}</span>
            <span className="dp-rowi-b">
              <span>{s.label}{s.optional && <span className="dp-t3"> · optional</span>}</span>
              {!s.done && s.hint && <span className="dp-t3">{s.hint}</span>}
              {!s.done && s.command && <span className="dp-ob-cmd"><code className="dp-ell">{s.command}</code><button type="button" className="dp-btn dp-ghost dp-sm" onClick={() => navigator.clipboard?.writeText(s.command ?? '')}><Icon name="copy" size={12} />Copy</button></span>}
              {!s.done && s.id === 'work' && <span className="dp-row dp-g6 dp-ob-links"><a className="dp-btn dp-sm" href="#/projects">Attach a project</a><a className="dp-btn dp-sm" href="#/inbox">From a link</a></span>}
            </span>
          </div>
        ))}
      </div>
      <div className="dp-ob-f">
        <button type="button" className="dp-btn dp-sm" disabled={busy || Boolean(agent)} onClick={startAgent}><Icon name="bot" size={12} />Ask an agent to finish the setup</button>
        {error && <span className="dp-ob-err">{error}</span>}
        {agent && <span className="dp-t3 dp-sm">Agent started{agent.agentId ? ` (${agent.agentId.slice(0, 8)})` : ''}: follow it in <a href={agent.agentId ? `#/agents/${agent.agentId}` : '#/agents'}>Agents</a> or Paseo, then Recheck.</span>}
      </div>
    </div>
  );
}
