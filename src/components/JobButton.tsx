import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { RECENT_MS, isLive } from '../jobs.ts';
import { toast } from './Toast.tsx';
import Icon from '../preview/Icon.tsx';
import { useWorkbench } from '../workbench/workbench-store.ts';
import type { Job } from '../types.ts';
import './parts.css';

const elapsed = (from: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};
const ACTIVE: Record<string, string> = { Update: 'Updating', Redo: 'Redoing', Make: 'Making', Push: 'Pushing', Tidy: 'Tidying', Mark: 'Marking', Fix: 'Fixing' };
const active = (label: string) => label.replace(/^(\w+)/, (w) => ACTIVE[w] || w);

function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// an action button that stands for its job: the button, then a running chip opening the agent, a short ✓, or a failure with Retry
export function JobButton({ job, label, onRun, primary, disabled, title }: { job: Job | null; label: string; onRun: () => unknown; primary?: boolean; disabled?: boolean; title?: string }) {
  const now = useTick(Boolean(job && (isLive(job) || job.state === 'done')));
  const open = () => job?.agentId && useWorkbench.getState().open(`ag-${job.agentId}`);
  if (job && isLive(job)) {
    const waiting = job.state === 'needs-you';
    return (
      <button type="button" className={`dp-btn dp-sm dp-job${waiting ? ' dp-job-wait' : ''}`} title={job.agentId ? `${job.label}: open its agent` : job.label} onClick={open}>
        <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden />{active(label)}{waiting ? ' · needs you' : ''} · {elapsed(job.startedAt, now)}
      </button>
    );
  }
  if (job?.state === 'done' && job.endedAt && now - Date.parse(job.endedAt) < RECENT_MS) {
    return <button type="button" className="dp-btn dp-sm dp-job dp-job-ok" title={job.output || job.label} onClick={open}><Icon name="check" size={12} />{label} done</button>;
  }
  if (job && (job.state === 'failed' || job.state === 'lost')) {
    const dismiss = () => api.dismissJob(job.id).catch((e) => toast.error(errorMessage(e)));
    return (
      <span className="dp-job-fail">
        <button type="button" className="dp-btn dp-sm dp-job dp-job-bad" title={[job.error, job.output].filter(Boolean).join('\n\n')} onClick={open}><Icon name="x" size={12} />{label} {job.state === 'lost' ? 'lost' : 'failed'}</button>
        <button type="button" className="dp-btn dp-sm" disabled={disabled} onClick={() => { void dismiss(); onRun(); }}><Icon name="refresh" size={12} />Retry</button>
        <button type="button" className="dp-ibtn" title="Dismiss" aria-label="Dismiss" onClick={dismiss}><Icon name="x" size={12} /></button>
      </span>
    );
  }
  return <button type="button" className={`dp-btn dp-sm${primary ? ' dp-primary' : ''}`} disabled={disabled} title={title} onClick={onRun}>{label}</button>;
}
