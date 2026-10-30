import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import Icon from './Icon.tsx';
import { prLabel } from './agents.ts';
import { ago } from './format.ts';
import { useJobsPanel } from './JobsStatus.tsx';
import { lastStep } from './signals.ts';
import type { Activity, Signal } from './signals.ts';
import { workHref } from './prefs.ts';

const STEP_MS = 10000;
// each read spawns `paseo logs` on the server: one in flight per agent, and a read younger than the poll is reused
const steps = new Map<string, { at: number; step: string | null }>();
const reading = new Map<string, Promise<string | null>>();
const readStep = (agentId: string) => {
  const hit = steps.get(agentId);
  if (hit && Date.now() - hit.at < STEP_MS - 1000) return Promise.resolve(hit.step);
  const running = reading.get(agentId);
  if (running) return running;
  const p = api.agentActivity(agentId).then((r) => (r.ok ? lastStep(r.out) : null), () => hit?.step ?? null).then((s) => {
    steps.set(agentId, { at: Date.now(), step: s });
    reading.delete(agentId);
    return s;
  });
  reading.set(agentId, p);
  return p;
};

// the step a running agent is on, read when its line shows and every 10 s while it does
function useStep(agentId: string | null) {
  const [step, setStep] = useState(() => (agentId ? steps.get(agentId)?.step ?? null : null));
  useEffect(() => {
    if (!agentId) return undefined;
    let live = true;
    const read = () => { void readStep(agentId).then((s) => { if (live) setStep(s); }); };
    read();
    const t = setInterval(read, STEP_MS);
    return () => { live = false; clearInterval(t); };
  }, [agentId]);
  return step;
}

const openActivity = (a: Activity) => {
  if (a.kind === 'agent') location.hash = `${workHref(a.work)}/${encodeURIComponent(a.id)}`;
  else if (a.agentId) location.hash = `${workHref(a.work)}/ag-${a.agentId}`;
  else useJobsPanel.setState({ open: true });
};

const since = (a: Activity) => {
  const t = ago(a.since ?? undefined);
  if (!t) return '';
  const verb = a.kind === 'job' ? 'started' : 'active';
  return t === 'now' ? `${verb} just now` : `${verb} ${t} ago`;
};

function Line({ a }: { a: Activity }) {
  const step = useStep(a.kind === 'agent' ? a.agentId : null);
  return (
    <button type="button" className="dp-sigl" onClick={(e) => { e.preventDefault(); e.stopPropagation(); openActivity(a); }} title={a.kind === 'agent' ? 'Open the agent' : a.agentId ? 'Open the agent it starts' : 'Open Jobs'}>
      <Icon name={a.kind === 'agent' ? 'bot' : 'activity'} size={14} />
      <span className="dp-sigl-b">
        <span className="dp-ell dp-sigl-t">{a.label}</span>
        <span className="dp-ell dp-sigl-s">{[a.pr ? prLabel(a.pr) : 'work', step, since(a)].filter(Boolean).join(' · ')}</span>
      </span>
    </button>
  );
}

// what runs under a row, one clickable line each, by work when they span several
function Pop({ running, at, titles, onEnter, onLeave }: { running: Activity[]; at: DOMRect; titles?: (slug: string) => string; onEnter: () => void; onLeave: () => void }) {
  const works = [...new Set(running.map((a) => a.work))];
  const left = Math.min(at.right + 8, innerWidth - 336);
  const top = Math.max(8, Math.min(at.top - 10, innerHeight - 40 - running.length * 44 - works.length * 24));
  return (
    <div className="dp-sigpop" style={{ left, top }} role="dialog" aria-label="Running" onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="dp-sigpop-h">{running.length} running</div>
      {works.map((w) => (
        <React.Fragment key={w}>
          {works.length > 1 && <div className="dp-sigpop-w dp-ell">{titles?.(w) ?? w}</div>}
          {running.filter((a) => a.work === w).map((a) => <Line key={a.id} a={a} />)}
        </React.Fragment>
      ))}
    </div>
  );
}

function Spinner({ running, titles }: { running: Activity[]; titles?: (slug: string) => string }) {
  const [at, setAt] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = () => { clearTimeout(timer.current); if (ref.current) setAt(ref.current.getBoundingClientRect()); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setAt(null), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  // gone under the pointer when the last one stops
  useEffect(() => { if (!running.length) setAt(null); }, [running.length]);
  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        className="dp-sigspin"
        aria-label={`${running.length} running`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); show(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') setAt(null); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); show(); } }}
      >
        <span className="dp-ag-dot dp-ag-running dp-thr-spin" />
        {running.length > 1 && <span className="dp-sigspin-n">{running.length}</span>}
      </span>
      {at && <Pop running={running} at={at} titles={titles} onEnter={show} onLeave={hide} />}
    </>
  );
}

// a row's signals in a fixed order: running, waiting on you, failed jobs, changes requested or CI red
export default function SignalBadges({ s, attention = s.attention, titles }: { s: Signal; attention?: boolean; titles?: (slug: string) => string }) {
  return (
    <>
      {s.running.length > 0 && <Spinner running={s.running} titles={titles} />}
      {s.waiting > 0 && <span className="dp-count dp-acc" title={`${s.waiting} waiting on you`}>{s.waiting}</span>}
      {s.failed > 0 && <span role="button" className="dp-sigfail" title={`${s.failed} failed job${s.failed === 1 ? '' : 's'}: open Jobs to read and dismiss`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); useJobsPanel.setState({ open: true }); }} />}
      {attention && <span className="dp-sigatt" title="Changes requested or CI red"><Icon name="alert-triangle" size={12} /></span>}
    </>
  );
}
