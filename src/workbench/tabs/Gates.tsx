import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { useAction, pendingClass } from '../../components/action.ts';

const POLL_MS = 60000;
const MARK = { done: '✓', running: '●', skipped: '–', todo: '○' };
// a gate skill is a name, or { name, ask } when it takes "<answer> <pr>" as arguments
const skillSpec = (s) => (typeof s === 'string' ? { name: s, ask: /review-as$/.test(s) ? 'Persona login' : '' } : { name: s.name, ask: s.ask || '' });

// the gates of one PR in order, a pill each; the picked one shows its skills, its command or its ticks
export default function GateRail({ slug, n, onOpen }) {
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState(null);
  const { pending, busy, run: go } = useAction();
  const [error, setError] = useState('');
  const load = () => api.gates(slug, n).then((d) => { setData(d); setError(''); }, (e) => setError(e.message));
  const running = data?.gates.some((g) => g.state === 'running');
  useEffect(() => {
    load();
    const t = setInterval(load, running ? POLL_MS / 6 : POLL_MS);
    return () => clearInterval(t);
  }, [slug, n, running]);

  const act = (id, body) => go(`${id}:${body.action}`, async () => { setData(await api.gateAction(slug, n, id, body)); setError(''); });
  const spin = (id, action) => pendingClass(pending === `${id}:${action}`);
  const run = (id, s) => {
    const { name, ask } = skillSpec(s);
    const answer = ask ? prompt(ask) : '';
    if (answer === null || (ask && !answer.trim())) return;
    act(id, { action: 'run', skill: name, ...(ask ? { args: `${answer.trim()} ${n}` } : {}) });
  };
  const skip = (id) => {
    const reason = prompt('Skip: one-line reason');
    if (reason) act(id, { action: 'skipped', reason });
  };

  if (!data) return error ? <div className="status danger">{error}</div> : null;
  const gate = data.gates.find((g) => g.id === picked);
  const next = data.gates.find((g) => g.state === 'todo');
  return (
    <div className="gates">
      <div className="gate-rail">
        {data.gates.map((g) => (
          <button key={g.id} type="button" className={`gate ${g.state} ${picked === g.id ? 'on' : ''} ${next === g ? 'next' : ''}`} title={`${g.label}: ${g.state}${g.reason ? ` (${g.reason})` : ''}${g.derived != null ? ' · derived from GitHub/git' : ''}`} onClick={() => setPicked(picked === g.id ? null : g.id)}>
            {g.state === 'running' ? <span className="spinner" aria-hidden /> : MARK[g.state]} {g.label}
          </button>
        ))}
      </div>
      {gate && (
        <div className="gate-detail">
          <div className="row">
            <b>{gate.label}</b>
            <span className="status">{gate.state}{gate.reason ? `: ${gate.reason}` : ''}{gate.at ? ` · ${gate.at.slice(0, 16).replace('T', ' ')}` : ''}{gate.derived != null ? ` · GitHub/git says ${gate.derived ? 'done' : 'not yet'}` : ''}</span>
          </div>
          {gate.command && <div className="row"><code className="gate-cmd">{gate.command}</code><button type="button" className="sm" onClick={() => navigator.clipboard?.writeText(gate.command)}>copy</button></div>}
          <div className="row">
            {gate.skills.map((s) => <button key={skillSpec(s).name} type="button" className={`sm primary${spin(gate.id, 'run')}`} disabled={busy || gate.state === 'running'} title="Starts the skill in the PR agent (or a new agent in the PR worktree)" onClick={() => run(gate.id, s)}>/{skillSpec(s).name}</button>)}
            {gate.tab && <button type="button" className="sm" onClick={() => onOpen(gate.tab)}>open {gate.tab} ▸</button>}
            {gate.state !== 'done' && <button type="button" className={`sm${spin(gate.id, 'done')}`} disabled={busy} onClick={() => act(gate.id, { action: 'done' })}>✓ done</button>}
            {gate.state !== 'skipped' && <button type="button" className={`sm${spin(gate.id, 'skipped')}`} disabled={busy} onClick={() => skip(gate.id)}>skip…</button>}
            {(gate.state === 'skipped' || (gate.state === 'done' && gate.at)) && <button type="button" className={`sm${spin(gate.id, 'todo')}`} disabled={busy} onClick={() => act(gate.id, { action: 'todo' })}>↺ reset</button>}
          </div>
        </div>
      )}
      {error && <div className="status danger">{error}</div>}
    </div>
  );
}
