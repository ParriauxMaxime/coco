import { useEffect, useState } from 'react';
import { subscribe, topic } from './live.ts';
import type { Job } from './types.ts';

// a finished job keeps its ✓ this long on its button
export const RECENT_MS = 60000;
export const isLive = (j: Job) => j.state === 'running' || j.state === 'needs-you';

// the jobs of a work, or of every work without one, live
export function useJobs(work?: string | null) {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => subscribe(work ? topic('jobs', work) : topic('jobs'), { message: (d: unknown) => setJobs((d as { jobs?: Job[] })?.jobs || []) }), [work]);
  return jobs;
}

// the job a button stands for: live, ended a moment ago, or failed and not dismissed yet
export function jobOf(jobs: Job[], pr: string | number | null, action: string) {
  const job = jobs.filter((j) => j.action === action && (pr == null || j.pr === String(pr))).at(-1);
  if (!job) return null;
  if (isLive(job) || job.state === 'failed' || job.state === 'lost') return job;
  return job.endedAt && Date.now() - Date.parse(job.endedAt) < RECENT_MS ? job : null;
}

// the failures nothing said yet: a job can be stamped failed before its own running render reaches the page, so its id decides, not a transition
export const unannounced = (jobs: Job[], said: ReadonlySet<string>, now = Date.now()) =>
  jobs.filter((j) => (j.state === 'failed' || j.state === 'lost') && !said.has(j.id) && j.endedAt && now - Date.parse(j.endedAt) < RECENT_MS);
