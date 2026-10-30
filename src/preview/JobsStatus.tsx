import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api.ts';
import { RECENT_MS, isLive, unannounced, useJobs } from '../jobs.ts';
import { toast } from '../components/Toast.tsx';
import { notifyAway } from '../desktop.ts';
import Icon from './Icon.tsx';
import { ago } from './format.ts';
import type { Job } from '../types.ts';

const SHOWN = 12;
const STATE: Record<Job['state'], string> = { running: 'running', 'needs-you': 'needs you', done: 'done', failed: 'failed', lost: 'lost' };

// each job's end, said once, by the one status bar every page has: the ids outlive a re-render, so a failure batched next to its own running render still says why
function useEndToasts(jobs: Job[]) {
  const said = useRef(new Set<string>());
  useEffect(() => {
    const fresh = new Set(unannounced(jobs, said.current).map((j) => j.id));
    for (const j of jobs) {
      const key = isLive(j) ? `${j.id}:${j.state}` : j.id;
      if (said.current.has(key)) continue;
      said.current.add(key);
      // an end from before this page opened is settled, not replayed
      if (!isLive(j) && !fresh.has(j.id) && !(j.state === 'done' && j.endedAt && Date.now() - Date.parse(j.endedAt) < RECENT_MS)) continue;
      if (j.state === 'done') toast.success(`${j.label}: done`);
      else if (j.state === 'failed' || j.state === 'lost') toast.error(`${j.label}: ${j.error || j.state}`);
      else if (j.state === 'needs-you') toast.success(`${j.label} needs you: its agent waits on a permission`);
      if (j.state !== 'running') notifyAway(j.label, j.state === 'needs-you' ? 'Its agent waits on a permission' : j.state === 'done' ? 'Done' : j.error || j.state);
    }
    const listed = new Set(jobs.map((j) => j.id));
    for (const key of said.current) if (!listed.has(key.split(':')[0])) said.current.delete(key);
  }, [jobs]);
}

// "n jobs" in the status bar: every running action of every work, and the last ones that ended
// the Jobs list's open state, so a job line elsewhere (the sidebar's activity popover) opens it
export const useJobsPanel = create<{ open: boolean }>(() => ({ open: false }));
const setOpen = (open: boolean) => useJobsPanel.setState({ open });

export default function JobsStatus({ onOpenAgent }: { onOpenAgent: (job: Job) => void }) {
  const jobs = useJobs();
  const open = useJobsPanel((s) => s.open);
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
          <div className="dp-pop-h"><b>Jobs</b><span className="dp-count">{live.length}</span><span className="dp-sp" />{jobs.some((j) => !isLive(j)) && <button type="button" className="dp-btn dp-ghost dp-sm" onClick={() => api.clearJobs().catch((e) => toast.error(errorMessage(e)))}>Clear all</button>}<button type="button" className="dp-ibtn" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button></div>
          <div className="dp-pop-s">
            {shown.map((j) => {
              const why = j.state === 'failed' || j.state === 'lost' ? j.error || j.output : '';
              return (
                <div key={j.id} className={`dp-mi dp-job-row dp-job-${j.state}`} title={[j.error, j.output].filter(Boolean).join('\n\n') || j.label} onClick={() => j.agentId && onOpenAgent(j)}>
                  {isLive(j) ? <span className="dp-ag-dot dp-ag-running dp-thr-spin" aria-hidden /> : <Icon name={j.state === 'done' ? 'check' : 'x'} size={12} />}
                  <span className="dp-grow dp-job-lbl">
                    <span className="dp-ell">{j.label}</span>
                    {why && <span className="dp-ell dp-job-why">{why}</span>}
                  </span>
                  <span className="dp-r">{j.work ? `${j.work} · ` : ''}{STATE[j.state]} · {ago(j.endedAt || j.startedAt)}</span>
                  {!isLive(j) && <button type="button" className="dp-ibtn" title="Dismiss" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); api.dismissJob(j.id).catch((er) => toast.error(errorMessage(er))); }}><Icon name="x" size={12} /></button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
