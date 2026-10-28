// Jobs: every background action the owner starts (an agent, a command, a sync, a setup step), registered at once and followed to its end,
// so each button can say "running", "done" or "failed" on every page. A live job refuses its duplicate (same work, PR and action).
// GET /api/jobs?work=<slug> · POST /api/jobs/<id>/dismiss · topic `jobs` (optional work arg).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Sink } from './events.ts';
import type { AgentSnapshot } from './permissions.ts';

const KEEP = 50;
const SETTLE_MS = 15000;
const TAIL = 4000;
const GLOBAL = '_global';

export type JobKind = 'agent' | 'command' | 'sync' | 'setup';
export type JobState = 'running' | 'needs-you' | 'done' | 'failed' | 'lost';
// settle: agent (an agent job ends with its agent's first turn) or promise (it ends when run resolves, its agent only linked)
export type Job = { id: string; work: string | null; pr: string | null; action: string; label: string; kind: JobKind; state: JobState; agentId: string | null; startedAt: string; endedAt: string | null; output: string; error: string; settle?: 'promise'; dismissed?: boolean; ran?: boolean };
export type JobMeta = { work?: string | null; pr?: string | number | null; action: string; label: string; kind: JobKind; settle?: 'promise' };
export type JobResult = { agentId?: string | null; output?: string } | void;

const live = (j: Job) => j.state === 'running' || j.state === 'needs-you';
const tail = (s: string) => s.slice(-TAIL);

export class JobConflict extends HttpError {
  job: Job;
  constructor(job: Job) {
    super(409, `${job.label} is already running`);
    this.job = job;
  }
}

export function createJobs({ DATA }: { DATA?: string } = {}) {
  const dir = DATA ? path.join(DATA, 'jobs') : '';
  const byWork = new Map<string, Job[]>();
  const listeners = new Set<(job: Job) => void>();
  const fileOf = (work: string) => path.join(dir, `${work}.json`);

  const load = (work: string): Job[] => {
    const hit = byWork.get(work);
    if (hit) return hit;
    let jobs: Job[] = [];
    try {
      jobs = dir ? JSON.parse(fs.readFileSync(fileOf(work), 'utf8')) : [];
    } catch {}
    // a command cut by a restart cannot be followed again; an agent keeps running and reports through its events
    for (const j of jobs) if (live(j) && (j.kind !== 'agent' || j.settle === 'promise')) Object.assign(j, { state: 'lost', endedAt: new Date().toISOString(), error: 'coco restarted while it ran' });
    byWork.set(work, jobs);
    return jobs;
  };
  if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) load(f.slice(0, -5));

  const save = (work: string) => {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${fileOf(work)}.tmp`, JSON.stringify(load(work)));
    fs.renameSync(`${fileOf(work)}.tmp`, fileOf(work));
  };
  const changed = (job: Job) => {
    save(job.work || GLOBAL);
    listeners.forEach((l) => l(job));
  };
  const all = () => [...byWork.values()].flat();
  const find = (id: string) => all().find((j) => j.id === id);

  function end(job: Job, state: JobState, { output, error }: { output?: string; error?: string } = {}) {
    if (!live(job)) return;
    Object.assign(job, { state, endedAt: new Date().toISOString(), ...(output !== undefined ? { output: tail(output) } : {}), ...(error !== undefined ? { error: tail(error) } : {}) });
    changed(job);
  }

  // registers the job and starts it; done settles with what run returned, after its agent's first turn for an agent job
  function start<T extends JobResult>(meta: JobMeta, run: (job: Job) => Promise<T>) {
    const work = meta.work || null;
    const pr = meta.pr == null ? null : String(meta.pr);
    const running = load(work || GLOBAL).find((j) => live(j) && j.pr === pr && j.action === meta.action);
    if (running) throw new JobConflict(running);
    const job: Job = { id: randomUUID(), work, pr, action: meta.action, label: meta.label, kind: meta.kind, state: 'running', agentId: null, startedAt: new Date().toISOString(), endedAt: null, output: '', error: '', ...(meta.settle ? { settle: meta.settle } : {}) };
    const list = load(work || GLOBAL);
    list.push(job);
    list.splice(0, Math.max(0, list.length - KEEP));
    changed(job);
    const done = (async () => run(job))()
      .then(
        (r) => {
          if (r?.agentId && job.kind === 'agent' && job.settle !== 'promise') {
            job.agentId = r.agentId;
            changed(job);
          } else end(job, 'done', { output: r?.output ?? '' });
          return r;
        },
        (e) => {
          end(job, 'failed', { error: errorMessage(e), output: (e as { output?: string })?.output });
          throw e;
        },
      );
    done.catch(() => {});
    return { job, done };
  }

  // an agent job: needs you while a permission waits, done once its turn ends
  function onAgent(agent: AgentSnapshot | null) {
    if (!agent) return;
    for (const job of all().filter((j) => j.agentId === agent.id && live(j) && j.settle !== 'promise')) {
      if (agent.archivedAt) { end(job, 'done'); continue; }
      if (agent.status === 'error') { end(job, 'failed', { error: 'the agent stopped on an error' }); continue; }
      const waiting = (agent.pendingPermissions || []).length > 0;
      if (agent.status === 'running' || waiting) {
        const state: JobState = waiting ? 'needs-you' : 'running';
        if (job.state !== state || !job.ran) {
          Object.assign(job, { state, ran: true });
          changed(job);
        }
        continue;
      }
      if (job.ran || Date.now() - Date.parse(job.startedAt) > SETTLE_MS) end(job, 'done');
    }
  }

  // a job around work its caller waits on; while the same one runs, fn runs untracked rather than refused
  async function wrap<T>(meta: JobMeta, fn: () => Promise<T>, output: (v: T) => string = () => ''): Promise<T> {
    let value: T | undefined;
    let started;
    try {
      started = start(meta, async () => {
        value = await fn();
        return { output: output(value) };
      });
    } catch (e) {
      if (e instanceof JobConflict) return fn();
      throw e;
    }
    await started.done;
    return value as T;
  }

  // the agent a promise job runs, for its chip to open
  function link(job: Job, agentId: string | null | undefined) {
    if (!agentId || job.agentId === agentId) return;
    job.agentId = agentId;
    changed(job);
  }

  const list = (work?: string | null) => (work ? load(work) : all()).filter((j) => !j.dismissed).slice(-KEEP);
  function dismiss(id: string) {
    const job = find(id);
    if (!job) throw new HttpError(404, 'no such job');
    job.dismissed = true;
    changed(job);
    return job;
  }

  function watch(sink: Sink, work?: string) {
    const send = () => sink.send(JSON.stringify({ jobs: list(work || null) }));
    send();
    const l = (job: Job) => (!work || job.work === work) && send();
    listeners.add(l);
    sink.onClose(() => listeners.delete(l));
  }

  async function handle(req: Req, res: Res, parts: string[], _readBody: ReadBody, send: Send) {
    try {
      const [, id, verb] = parts;
      if (!id && req.method === 'GET') return send(res, 200, { jobs: list(new URL(req.url ?? '', 'http://x').searchParams.get('work')) });
      if (id && verb === 'dismiss' && req.method === 'POST') return send(res, 200, dismiss(id));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { start, wrap, link, onAgent, list, dismiss, watch, handle, onChange: (l: (job: Job) => void) => (listeners.add(l), () => listeners.delete(l)) };
}

export type Jobs = ReturnType<typeof createJobs>;

// a job for work that settles elsewhere (callbacks, not a promise of its own): resolve or reject it when that work ends
export function deferredJob(jobs: Pick<Jobs, 'start'> | null | undefined, meta: JobMeta) {
  let settle: { resolve: (r: JobResult) => void; reject: (e: unknown) => void } = { resolve: () => {}, reject: () => {} };
  const started = jobs?.start(meta, () => new Promise<JobResult>((resolve, reject) => (settle = { resolve, reject })));
  return { job: started?.job ?? null, resolve: (r?: JobResult) => settle.resolve(r), reject: (e: unknown) => settle.reject(e) };
}
// the reply to a refused duplicate: the running job, for the page to show its chip
export const conflictBody = (e: unknown) => (e instanceof JobConflict ? { error: e.message, job: e.job } : null);
