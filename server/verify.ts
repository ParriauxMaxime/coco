// Verify before Approve: the owner's click runs the repo's configured checks (agent-worktree.ts) on the files of a group agent's commit, in its worktree.
// Dependencies are only looked at: linked when the lockfile is identical (prepare), never installed here; otherwise the run reports deps-pending.
import type { AgentWorktrees, CheckResult } from './agent-worktree.ts';

const TAIL_LINES = 40;
export type VerifyCheck = { name: string; ok: boolean; ms: number; tail?: string; skipped?: string };
// head: the worktree's HEAD when the run started; stale-head: it was past the commit, so nothing ran
export type VerifyRun = { commit: string; startedAt: string; finishedAt?: string; status: 'running' | 'pass' | 'fail' | 'deps-pending' | 'stale-head'; checks: VerifyCheck[]; note?: string; head?: string };
type Worktrees = Pick<AgentWorktrees, 'prepare' | 'verify'> & Partial<Pick<AgentWorktrees, 'head'>>;

export const checkOf = (r: CheckResult): VerifyCheck => ({
  name: r.label,
  ok: r.state !== 'failed',
  ms: r.ms ?? 0,
  ...(r.state === 'failed' ? { tail: (r.output || '(no output)').split('\n').slice(-TAIL_LINES).join('\n') } : {}),
  ...(r.state === 'skipped' ? { skipped: r.why || 'nothing to check' } : {}),
});

// a finished run is reusable for its sha; a running or deps-pending one is not
export const reusable = (r: VerifyRun | undefined, inflight: boolean): r is VerifyRun => Boolean(r && (r.status === 'pass' || r.status === 'fail' || (r.status === 'running' && inflight)));

export async function verifyCommit(wt: Worktrees, cwd: string, commit: string, update: (run: VerifyRun) => unknown): Promise<VerifyRun> {
  const run: VerifyRun = { commit, startedAt: new Date().toISOString(), status: 'running', checks: [] };
  const done = (patch: Partial<VerifyRun>) => Object.assign(run, { finishedAt: new Date().toISOString() }, patch);
  const head = (await wt.head?.(cwd)) ?? undefined;
  if (head) run.head = head;
  if (head && head !== commit) {
    await update(done({ status: 'stale-head', note: `agent committed past ${commit.slice(0, 7)}; Verify the newest ready commit` }));
    return run;
  }
  const r = await wt.prepare(cwd, { retrying: true, start: false });
  if (r.state === 'preparing' || r.state === 'failed') {
    const what = r.deps.filter((d) => d.mode !== 'linked' && d.mode !== 'own').map((d) => `${d.path} ${d.mode}${d.note ? ` (${d.note})` : ''}`);
    await update(done({ status: 'deps-pending', note: [r.state === 'preparing' ? 'coco is installing the dependencies' : r.error || 'the dependencies are not ready', ...what].join(': ') }));
    return run;
  }
  await update({ ...run });
  const seen: VerifyCheck[] = [];
  const v = await wt.verify(cwd, { base: `${commit}^`, head: commit, onCheck: (c) => (seen.push(checkOf(c)), void update({ ...run, checks: [...seen] })) });
  if (!v) await update(done({ status: 'pass', note: 'no checks are configured for this repo' }));
  else if (v.state === 'unavailable') await update(done({ status: 'deps-pending', note: v.why || 'the dependencies are not ready' }));
  else await update(done({ status: v.state === 'failed' ? 'fail' : 'pass', checks: v.results.map(checkOf) }));
  return run;
}
