import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import type { Gate, GateActionBody, GatesResponse } from '../../types.ts';
import { useAction, pendingClass } from '../../components/action.ts';
import Checks from '../../components/Checks.tsx';
import Icon from '../../preview/Icon.tsx';
import '../../components/parts.css';
import type { PrKey } from '../types.ts';

const POLL_MS = 60000;
const MARK: Record<string, string> = { done: '✓', running: '●', skipped: '–', todo: '○' };
const CHECKS = 'agent-checks';
const CHECK_MARK: Record<string, string> = { passed: '✓', failed: '✕', unavailable: '–' };
// a gate skill is a name, or { name, ask } when it takes "<answer> <pr>" as arguments
const skillSpec = (s: Gate['skills'][number]) => (typeof s === 'string' ? { name: s, ask: /review-as$/.test(s) ? 'Persona login' : '' } : { name: s.name, ask: s.ask || '' });

// the gates of one PR in order, a pill each; the picked one shows its skills, its command or its ticks
export default function GateRail({ slug, n, onOpen }: { slug: string; n: PrKey; onOpen: (tab: string) => void }) {
  const [data, setData] = useState<GatesResponse | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { pending, busy, run: go } = useAction();
  const [error, setError] = useState('');
  const load = () => api.gates(slug, n).then((d) => { setData(d); setError(''); }, (e) => setError(errorMessage(e)));
  const running = data?.gates.some((g) => g.state === 'running');
  useEffect(() => {
    load();
    const t = setInterval(load, running ? POLL_MS / 6 : POLL_MS);
    return () => clearInterval(t);
  }, [slug, n, running]);

  const act = (id: string, body: GateActionBody) => go(`${id}:${body.action}`, async () => { setData(await api.gateAction(slug, n, id, body)); setError(''); });
  const spin = (id: string, action: string) => pendingClass(pending === `${id}:${action}`);
  const run = (id: string, s: Gate['skills'][number]) => {
    const { name, ask } = skillSpec(s);
    const answer = ask ? prompt(ask) : '';
    if (answer === null || (ask && !answer.trim())) return;
    act(id, { action: 'run', skill: name, ...(ask ? { args: `${answer.trim()} ${n}` } : {}) });
  };
  const skip = (id: string) => {
    const reason = prompt('Skip: one-line reason');
    if (reason) act(id, { action: 'skipped', reason });
  };

  if (!data) return error ? <div className="dp-gt-err">{error}</div> : null;
  const gate = data.gates.find((g) => g.id === picked);
  const next = data.gates.find((g) => g.state === 'todo');
  const checks = data.agentChecks;
  return (
    <div className="dp-gt">
      <div className="dp-gt-rail">
        {checks && (
          <button type="button" className={`dp-gt-p dp-gt-checks-${checks.state}${picked === CHECKS ? ' dp-on' : ''}`} aria-expanded={picked === CHECKS} title={`coco's checks on the last agent commit ${checks.head.slice(0, 7)}: ${checks.state}`} onClick={() => setPicked(picked === CHECKS ? null : CHECKS)}>
            {CHECK_MARK[checks.state] || '○'} checks
          </button>
        )}
        {data.gates.map((g) => (
          <button key={g.id} type="button" className={`dp-gt-p dp-gt-${g.state}${picked === g.id ? ' dp-on' : ''}${next === g ? ' dp-gt-next' : ''}`} aria-expanded={picked === g.id} title={`${g.label}: ${g.state}${g.reason ? ` (${g.reason})` : ''}${g.derived != null ? ' · derived from GitHub/git' : ''}`} onClick={() => setPicked(picked === g.id ? null : g.id)}>
            {g.state === 'running' ? <span className="dp-ag-dot dp-ag-running dp-gt-spin" aria-hidden /> : MARK[g.state]} {g.label}
          </button>
        ))}
      </div>
      {checks && picked === CHECKS && (
        <div className="dp-gt-d">
          <div className="dp-gt-dh">
            <b>checks</b>
            <span>coco's run on agent {checks.agentId.slice(0, 8)}'s commits up to {checks.head.slice(0, 7)} · {checks.at.slice(0, 16).replace('T', ' ')}</span>
          </div>
          <Checks run={checks} />
        </div>
      )}
      {gate && (
        <div className="dp-gt-d">
          <div className="dp-gt-dh">
            <b>{gate.label}</b>
            <span>{gate.state}{gate.reason ? `: ${gate.reason}` : ''}{gate.at ? ` · ${gate.at.slice(0, 16).replace('T', ' ')}` : ''}{gate.derived != null ? ` · GitHub/git says ${gate.derived ? 'done' : 'not yet'}` : ''}</span>
          </div>
          {gate.command && <div className="dp-gt-cmd"><code className="dp-ell">{gate.command}</code><button type="button" className="dp-ibtn" title="Copy the command" aria-label="Copy the command" onClick={() => navigator.clipboard?.writeText(gate.command ?? '')}><Icon name="copy" size={12} /></button></div>}
          <div className="dp-gt-f">
            {gate.skills.map((s) => <button key={skillSpec(s).name} type="button" className={`dp-btn dp-sm dp-primary${spin(gate.id, 'run')}`} disabled={busy || gate.state === 'running'} title="Starts the skill in the PR agent (or a new agent in the PR worktree)" onClick={() => run(gate.id, s)}>/{skillSpec(s).name}</button>)}
            {gate.tab && <button type="button" className="dp-btn dp-sm" onClick={() => onOpen(gate.tab ?? '')}>Open {gate.tab}<Icon name="chevron-right" size={12} /></button>}
            {gate.state !== 'done' && <button type="button" className={`dp-btn dp-sm${spin(gate.id, 'done')}`} disabled={busy} onClick={() => act(gate.id, { action: 'done' })}><Icon name="check" size={12} />Done</button>}
            {gate.state !== 'skipped' && <button type="button" className={`dp-btn dp-sm dp-ghost${spin(gate.id, 'skipped')}`} disabled={busy} onClick={() => skip(gate.id)}>Skip…</button>}
            {(gate.state === 'skipped' || (gate.state === 'done' && gate.at)) && <button type="button" className={`dp-btn dp-sm dp-ghost${spin(gate.id, 'todo')}`} disabled={busy} onClick={() => act(gate.id, { action: 'todo' })}><Icon name="refresh" size={12} />Reset</button>}
          </div>
        </div>
      )}
      {error && <div className="dp-gt-err">{error}</div>}
    </div>
  );
}
