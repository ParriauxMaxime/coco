import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ritualFields, useConfig } from '../config.js';

export default function Rituals({ preset }) {
  const rituals = useConfig((s) => s.rituals);
  const model = useConfig((s) => s.models.default);
  const loaded = useConfig((s) => s.loaded);
  const [picked, setKind] = useState(preset?.split('/')[0] || '');
  const [form, setForm] = useState({ login: preset?.split('/')[1] || '', pr: '', paths: '', text: '' });
  const [personas, setPersonas] = useState([]);
  const [history, setHistory] = useState([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.personas().then(setPersonas);
    api.rituals().then((r) => setHistory(r.history));
  }, []);
  const spec = rituals.find((r) => r.kind === picked) || rituals[0];
  const kind = spec?.kind;
  const fields = spec ? ritualFields(spec) : [];
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const launch = async () => {
    setBusy(true);
    setStatus('launching Paseo agent…');
    try {
      const r = await api.launch({ kind, ...form });
      setStatus(r.ok ? `launched ${r.agentId ? r.agentId.slice(0, 8) : ''} — ${r.title}` : `failed: ${r.out || r.error}`);
      if (r.ts) setHistory([r, ...history]);
    } catch (e) {
      setStatus(`failed: ${e.message}`);
    }
    setBusy(false);
  };
  // login and paths together: either one names the persona
  const ready = fields.every((f) => (f === 'paths' && form.login) || (f === 'login' && fields.includes('paths') && form.paths) || form[f]);
  return (
    <>
      <h1>Rituals</h1>
      <p className="sub">Each button starts a fresh Paseo agent in your repo ({model || 'default model'}, auto mode) with the matching prompt or skill. You press the button; agents never push, post or send.</p>
      {loaded && !spec && <div className="card sub">No ritual configured. Add a <code>rituals</code> list to <code>coco.config.json</code>: <code>{'{ "kind": "review-as", "label": "Review a PR as a persona", "prompt": "/review-as {login} {pr}" }'}</code>.</div>}
      {spec && (
        <>
          <div className="tabs">
            {rituals.map((r) => <button key={r.kind} className={kind === r.kind ? 'on' : ''} onClick={() => { setKind(r.kind); setStatus(''); }}>{r.label || r.kind}</button>)}
          </div>
          <div className="card">
            <p className="sub">{spec.hint || (spec.prompt ? `Runs ${spec.prompt}` : '')}</p>
            <form className="ritual" onSubmit={(e) => { e.preventDefault(); launch(); }}>
              {fields.includes('login') && (
                <label>Persona login
                  <input list="logins" value={form.login} onChange={set('login')} placeholder="alice" style={{ width: '100%' }} />
                  <datalist id="logins">{personas.map((p) => <option key={p.login} value={p.login} />)}</datalist>
                </label>
              )}
              {fields.includes('pr') && <label>PR number<input value={form.pr} onChange={set('pr')} placeholder="1234" inputMode="numeric" style={{ width: '100%' }} /></label>}
              {fields.includes('paths') && <label>Paths or PR to find the owner of<input value={form.paths} onChange={set('paths')} placeholder="src/billing/invoices" style={{ width: '100%' }} /></label>}
              {fields.includes('text') && <label>Situation and recipient<textarea className="short" value={form.text} onChange={set('text')} placeholder="review ping to Alice on #1234, focus on the invoice rounding fix" /></label>}
              <div className="row">
                <button className="primary" type="submit" disabled={!ready || busy}>Launch</button>
                <span className="status">{status}</span>
              </div>
            </form>
          </div>
        </>
      )}
      <h2>History</h2>
      <div className="card">
        {history.length === 0 && <span className="sub">Nothing launched from here yet.</span>}
        {history.map((r, i) => (
          <div key={i} className="list-item">
            <span className={`chip ${r.ok ? 'c-green' : 'c-red'}`}>{r.kind}</span> <b>{r.title}</b> <span className="status">{r.ts.slice(0, 16).replace('T', ' ')}{r.agentId ? ` · ${r.agentId.slice(0, 8)}` : ''}</span>
            <div className="status"><code>{(r.prompt || '').slice(0, 160)}</code></div>
          </div>
        ))}
      </div>
    </>
  );
}
