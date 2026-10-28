import React, { Fragment, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import type { Gate, GateActionBody, GatesResponse } from '../../types.ts';
import { useAction, pendingClass } from '../../components/action.ts';
import Checks from '../../components/Checks.tsx';
import { KitRedo } from './DriftPanel.tsx';
import Icon from '../../preview/Icon.tsx';
import '../../components/parts.css';
import type { PrKey } from '../types.ts';

const POLL_MS = 60000;
const MARK: Record<string, string> = { done: '✓', running: '●', skipped: '–', todo: '○' };
const CHECKS = 'agent-checks';
const CHECK_MARK: Record<string, string> = { passed: '✓', failed: '✕', unavailable: '–' };
// a gate skill is a name, or { name, ask } when it takes "<answer> <pr>" as arguments
export const skillSpec = (s: Gate['skills'][number]) => (typeof s === 'string' ? { name: s, ask: /review-as$/.test(s) ? 'Persona login' : '' } : { name: s.name, ask: s.ask || '' });

// null: no PR to read milestones of
export function useGates(slug: string, n: PrKey | null) {
  const [data, setData] = useState<GatesResponse | null>(null);
  const [error, setError] = useState('');
  const { pending, busy, run: go } = useAction();
  const running = data?.gates.some((g) => g.state === 'running');
  useEffect(() => setData(null), [slug, n]);
  useEffect(() => {
    if (n === null) return undefined;
    const load = () => api.gates(slug, n).then((d) => { setData(d); setError(''); }, (e) => setError(errorMessage(e)));
    load();
    const t = setInterval(load, running ? POLL_MS / 6 : POLL_MS);
    return () => clearInterval(t);
  }, [slug, n, running]);
  const act = (id: string, body: GateActionBody) => n !== null && go(`${id}:${body.action}`, async () => { setData(await api.gateAction(slug, n, id, body)); setError(''); });
  const run = (id: string, s: Gate['skills'][number]) => {
    const { name, ask } = skillSpec(s);
    const answer = ask ? prompt(ask) : '';
    if (answer === null || (ask && !answer.trim())) return;
    act(id, { action: 'run', skill: name, ...(ask ? { args: `${answer.trim()} ${n}` } : {}) });
  };
  return { data, error, pending, busy, act, run };
}

export type Gates = ReturnType<typeof useGates>;

// the review skills of the self-reviewed milestone, behind the chevron of a split button
export function ReviewSplit({ gates, onReview }: { gates: Gates; onReview: () => void }) {
  const [open, setOpen] = useState(false);
  const skills = gates.data?.gates.find((g) => g.id === 'self-review')?.skills || [];
  return (
    <span className="dp-split-wrap">
      <button type="button" className="dp-btn dp-sm dp-primary dp-split-main" onClick={onReview}><Icon name="file" size={14} />Review code</button>
      {skills.length > 0 && <button type="button" className="dp-btn dp-sm dp-primary dp-split-more" aria-label="Run a review skill" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron-down" size={12} /></button>}
      {open && (
        <div className="dp-pop dp-on dp-split-pop">
          {skills.map((s) => <button key={skillSpec(s).name} type="button" className="dp-mi" disabled={gates.busy} title="Starts the skill in the PR agent (or a new agent in the PR worktree)" onClick={() => { setOpen(false); gates.run('self-review', s); }}>/{skillSpec(s).name}</button>)}
        </div>
      )}
    </span>
  );
}

// the PR's milestones in order; the current one is open with its action, any other opens on a click
export default function GateRail({ slug, gates, n, onOpen }: { slug: string; gates: Gates; n: PrKey; onOpen: (tab: string) => void }) {
  const { data, error, pending, busy, act, run } = gates;
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const spin = (id: string, action: string) => pendingClass(pending === `${id}:${action}`);
  const skip = (id: string) => {
    const reason = prompt('Skip: one-line reason');
    if (reason) act(id, { action: 'skipped', reason });
  };

  if (!data) return error ? <div className="dp-gt-err">{error}</div> : null;
  const shown = picked === undefined ? data.current : picked;
  const gate = data.gates.find((g) => g.id === shown);
  const checks = data.agentChecks;
  return (
    <div className="dp-gt">
      <div className="dp-gt-rail">
        {checks && (
          <button type="button" className={`dp-gt-p dp-gt-checks-${checks.state}${shown === CHECKS ? ' dp-on' : ''}`} aria-expanded={shown === CHECKS} title={`coco's checks on the last agent commit ${checks.head.slice(0, 7)}: ${checks.state}`} onClick={() => setPicked(shown === CHECKS ? null : CHECKS)}>
            {CHECK_MARK[checks.state] || '○'} checks
          </button>
        )}
        {data.gates.map((g, i) => (
          <Fragment key={g.id}>
            {i > 0 && <span className="dp-gt-sep" aria-hidden>›</span>}
            <button type="button" className={`dp-gt-p dp-gt-${g.state}${shown === g.id ? ' dp-on' : ''}${data.current === g.id ? ' dp-gt-next' : ''}`} aria-expanded={shown === g.id} title={[`${g.label}: ${g.state}`, g.reason && `(${g.reason})`, g.detail].filter(Boolean).join(' · ')} onClick={() => setPicked(shown === g.id ? null : g.id)}>
              {g.state === 'running' ? <span className="dp-ag-dot dp-ag-running dp-gt-spin" aria-hidden /> : MARK[g.state]} {g.label}
            </button>
          </Fragment>
        ))}
      </div>
      {checks && shown === CHECKS && (
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
            <span>{[gate.state + (gate.reason ? `: ${gate.reason}` : ''), gate.detail, gate.at?.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="dp-gt-f">
            {gate.skills.map((s) => <button key={skillSpec(s).name} type="button" className={`dp-btn dp-sm dp-primary${spin(gate.id, 'run')}`} disabled={busy || gate.state === 'running'} title="Starts the skill in the PR agent (or a new agent in the PR worktree)" onClick={() => run(gate.id, s)}>/{skillSpec(s).name}</button>)}
            {gate.id === 'kit' && gate.state !== 'done' && <KitRedo slug={slug} prKey={String(n)} />}
            {gate.canRun && <button type="button" className={`dp-btn dp-sm dp-primary${spin(gate.id, 'ready')}`} disabled={busy} title={`gh pr ready ${n}`} onClick={() => act(gate.id, { action: 'ready' })}>Mark ready for review</button>}
            {gate.tab && /^\d+$/.test(String(n)) && <button type="button" className="dp-btn dp-sm" onClick={() => onOpen(`${gate.tab}-${n}`)}>Open {gate.tab}<Icon name="chevron-right" size={12} /></button>}
            {gate.state !== 'done' && <button type="button" className={`dp-btn dp-sm${spin(gate.id, 'done')}`} disabled={busy} onClick={() => act(gate.id, { action: 'done' })}><Icon name="check" size={12} />Done</button>}
            {gate.state !== 'skipped' && <button type="button" className={`dp-btn dp-sm dp-ghost${spin(gate.id, 'skipped')}`} disabled={busy} onClick={() => skip(gate.id)}>Skip…</button>}
            {gate.at && <button type="button" className={`dp-btn dp-sm dp-ghost${spin(gate.id, 'todo')}`} disabled={busy} onClick={() => act(gate.id, { action: 'todo' })}><Icon name="refresh" size={12} />Reset</button>}
          </div>
        </div>
      )}
      {error && <div className="dp-gt-err">{error}</div>}
    </div>
  );
}
