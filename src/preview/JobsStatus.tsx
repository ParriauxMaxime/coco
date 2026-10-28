import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { isLive, useJobs } from '../jobs.ts';
import { toast } from '../components/Toast.tsx';
import Icon from './Icon.tsx';
import { ago } from './format.ts';
import type { Job } from '../types.ts';

const SHOWN = 12;
const STATE: Record<Job['state'], string> = { running: 'running', 'needs-you': 'needs you', done: 'done', failed: 'failed', lost: 'lost' };

// each job's end, said once, by the one status bar every page has
function useEndToasts(jobs: Job[]) {
  const seen = useRef<Map<string, Job['state']> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(jobs.map((j) => [j.id, j.state]));
    if (!before) return;
    for (const j of jobs) {
      const was = before.get(j.id);
      if (was === j.state || (was === undefined && !isLive(j))) continue;
      if (j.state === 'done') toast.success(`${j.label}: done`);
      else if (j.state === 'failed' || j.state === 'lost') toast.error(`${j.label}: ${j.error || j.state}`);
      else if (j.state === 'needs-you') toast.success(`${j.label} needs you: its agent waits on a permission`);
    }
  }, [jobs]);
}

// "n jobs" in the status bar: every running action of every work, and the last ones that ended
export default function JobsStatus({ onOpenAgent }: { onOpenAgent: (job: Job) => void }) {
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  useEndToasts(jobs);
  const live = jobs.filter(isLive);
  const failed = jobs.filter((j) => j.state === 'failed' || j.state === 'lost');
  const shown = [...jobs].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt.localeCompare(a.startedAt)).slice(0, SHOWN);
  if (!jobs.length) return null;
  return (
    <>
      <span className={`dp-sbi${failed.length ? ' dp-jobs-bad' : ''}`} title="Background actions" onClick={() => setOpen(!open)}>
        {live.length ? <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden /> : <Icon name="activity" />}
        {live.length ? `${live.length} job${live.length > 1 ? 's' : ''} running` : 'Jobs'}{failed.length ? ` · ${failed.length} failed` : ''}
      </span>
      {open && (
        <div className="dp-pop dp-on dp-jobspop">
          <div className="dp-pop-h"><b>Jobs</b><span className="dp-count">{live.length}</span><span className="dp-sp" /><button type="button" className="dp-ibtn" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button></div>
          <div className="dp-pop-s">
            {shown.map((j) => (
              <div key={j.id} className={`dp-mi dp-job-row dp-job-${j.state}`} title={[j.error, j.output].filter(Boolean).join('\n\n') || j.label} onClick={() => j.agentId && onOpenAgent(j)}>
                {isLive(j) ? <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden /> : <Icon name={j.state === 'done' ? 'check' : 'x'} size={12} />}
                <span className="dp-ell dp-grow">{j.label}</span>
                <span className="dp-r">{j.work ? `${j.work} · ` : ''}{STATE[j.state]} · {ago(j.endedAt || j.startedAt)}</span>
                {!isLive(j) && <button type="button" className="dp-ibtn" title="Dismiss" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); api.dismissJob(j.id).catch((er) => toast.error(errorMessage(er))); }}><Icon name="x" size={12} /></button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
