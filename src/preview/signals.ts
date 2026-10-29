// What the works sidebar flags on a row: agents and jobs at work (each a line of the spinner's popover), what waits on you,
// failed jobs not dismissed yet, and PRs with changes requested or CI red. Each sits on the deepest row that shows: a folded
// repo, work, PR or fold row adds up everything under it.
import type { Job, WorkAgent, WorkSummary } from '../types.ts';

export type Activity = { id: string; kind: 'agent' | 'job'; label: string; work: string; pr: string | null; agentId: string | null; since: string | null };
export type Signal = { running: Activity[]; waiting: number; failed: number; attention: boolean };
export type WaitingRef = { work: string; pr: string | null };

export const NO_SIGNAL: Signal = { running: [], waiting: 0, failed: 0, attention: false };

export const addSignals = (list: Signal[]): Signal => list.reduce((a, s) => ({ running: [...a.running, ...s.running], waiting: a.waiting + s.waiting, failed: a.failed + s.failed, attention: a.attention || s.attention }), NO_SIGNAL);

export const isQuiet = (s: Signal) => !s.running.length && !s.waiting && !s.failed && !s.attention;

const isLive = (j: Job) => j.state === 'running' || j.state === 'needs-you';

// a work's signals by row: its PR keys, and '' for the work itself (its own agents and jobs)
export type WorkSignals = Map<string, Signal>;

export function workSignals(w: Pick<WorkSummary, 'slug' | 'rows'>, agents: WorkAgent[], waiting: WaitingRef[], jobs: Job[]): WorkSignals {
  const out: WorkSignals = new Map();
  const at = (pr: string | null) => {
    const k = pr ?? '';
    if (!out.has(k)) out.set(k, { running: [], waiting: 0, failed: 0, attention: false });
    return out.get(k) as Signal;
  };
  for (const a of agents) if (a.status === 'running') at(a.pr).running.push({ id: a.id, kind: 'agent', label: a.title, work: w.slug, pr: a.pr, agentId: a.agentId, since: a.updatedAt });
  // an agent job lists once its agent does: before that it is the agent starting
  const listed = new Set(agents.map((a) => a.agentId).filter(Boolean));
  for (const j of jobs) {
    if (j.work !== w.slug) continue;
    if (isLive(j) && !(j.kind === 'agent' && j.agentId && listed.has(j.agentId))) at(j.pr).running.push({ id: j.id, kind: 'job', label: j.label, work: w.slug, pr: j.pr, agentId: j.agentId, since: j.startedAt });
    else if (j.state === 'failed' || j.state === 'lost') at(j.pr).failed += 1;
  }
  for (const i of waiting) if (i.work === w.slug) at(i.pr).waiting += 1;
  for (const r of w.rows || []) if (r.state === 'changes' || r.ci === 'failure') at(r.key).attention = true;
  return out;
}

// everything under a work, for its folded row or its repo's
export const workTotal = (s: WorkSignals) => addSignals([...s.values()]);

// the rows a fold row holds, added up
export const rowsTotal = (s: WorkSignals, keys: string[]) => addSignals(keys.map((k) => s.get(k) ?? NO_SIGNAL));

// the step a running agent is on, from the tail of its `paseo logs`: its last tool line, e.g. "Shell · npm test"
export function lastStep(log: string): string | null {
  const lines = log.split('\n').filter((l) => /^\[[A-Za-z ]+\] /.test(l) && !l.startsWith('[Thought]'));
  const m = /^\[([A-Za-z ]+)\] (.*)$/.exec(lines.at(-1) ?? '');
  return m ? `${m[1]} · ${m[2].trim().slice(0, 80)}` : null;
}
