import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobConflict, createJobs, deferredJob } from './jobs.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
const meta = { work: 'w', pr: 7, action: 'drift:7:unpushed', label: 'Push #7', kind: 'command' as const };

test('a command job runs at once, refuses its duplicate while live, and ends done with its output or failed with its error', async () => {
  const jobs = createJobs({ DATA: tmp() });
  let release: (v: { output: string }) => void = () => {};
  const { job, done } = jobs.start(meta, () => new Promise<{ output: string }>((r) => (release = r)));
  assert.equal(job.state, 'running');
  assert.throws(() => jobs.start(meta, async () => ({})), (e) => e instanceof JobConflict && e.job.id === job.id && e.status === 409);
  release({ output: 'pushed' });
  await done;
  assert.deepEqual([job.state, job.output], ['done', 'pushed']);
  const failed = jobs.start(meta, async () => { throw Object.assign(new Error('pre-push: check-ts failed'), { output: 'src/a.ts error' }); });
  await failed.done.catch(() => {});
  assert.deepEqual([failed.job.state, failed.job.error, failed.job.output], ['failed', 'pre-push: check-ts failed', 'src/a.ts error']);
});

test('an agent job follows its agent: needs you on a pending permission, done once its turn ends, failed on an error', async () => {
  const jobs = createJobs({ DATA: tmp() });
  const { job, done } = jobs.start({ ...meta, action: 'gate:kit-body:pr', kind: 'agent' }, async () => ({ agentId: 'a1' }));
  await done;
  assert.deepEqual([job.state, job.agentId], ['running', 'a1']);
  jobs.onAgent({ id: 'a1', status: 'running', pendingPermissions: [{ id: 'p' } as never] });
  assert.equal(job.state, 'needs-you');
  jobs.onAgent({ id: 'a1', status: 'running' });
  assert.equal(job.state, 'running');
  jobs.onAgent({ id: 'a1', status: 'idle' });
  assert.equal(job.state, 'done');
  const other = jobs.start({ ...meta, action: 'gate:kit-video:demo', kind: 'agent' }, async () => ({ agentId: 'a2' }));
  await other.done;
  jobs.onAgent({ id: 'a2', status: 'idle' });
  assert.equal(other.job.state, 'running', 'an agent idle before its first turn is not done yet');
  jobs.onAgent({ id: 'a2', status: 'error' });
  assert.equal(other.job.state, 'failed');
});

test('a deferred job (review plan, Notion sync) ends when its work says so, not at its agent first idle turn', () => {
  const jobs = createJobs({ DATA: tmp() });
  const t = deferredJob(jobs, { ...meta, action: 'review-plan', kind: 'agent', settle: 'promise' });
  assert.ok(t.job);
  jobs.link(t.job, 'a1');
  jobs.onAgent({ id: 'a1', status: 'idle' });
  assert.equal(t.job.state, 'running');
  t.reject(new Error('the agent ended without a plan'));
  return new Promise((r) => setImmediate(r)).then(() => assert.deepEqual([t.job?.state, t.job?.error, t.job?.agentId], ['failed', 'the agent ended without a plan', 'a1']));
});

test('wrap hands its caller the value, fails the job on a throw, and runs a duplicate untracked instead of refusing it', async () => {
  const jobs = createJobs({ DATA: tmp() });
  const sync = { work: 'w', action: 'github-refresh', label: 'GitHub refresh', kind: 'sync' as const };
  let release: () => void = () => {};
  const first = jobs.wrap(sync, () => new Promise<string>((r) => (release = () => r('board'))));
  assert.equal(await jobs.wrap(sync, async () => 'again'), 'again');
  assert.equal(jobs.list('w').length, 1);
  release();
  assert.equal(await first, 'board');
  await assert.rejects(jobs.wrap({ ...sync, action: 'restack' }, async () => { throw new Error('conflict in a.ts'); }), /conflict in a.ts/);
  assert.deepEqual(jobs.list('w').map((j) => [j.action, j.state]), [['github-refresh', 'done'], ['restack', 'failed']]);
});

test('a restart loses the commands that ran and keeps following the agents; a dismissed job leaves the list', async () => {
  const DATA = tmp();
  const first = createJobs({ DATA });
  first.start(meta, () => new Promise<void>(() => {}));
  const agent = first.start({ ...meta, action: 'fix-findings', kind: 'agent' }, async () => ({ agentId: 'a1' }));
  await agent.done;
  const again = createJobs({ DATA });
  assert.deepEqual(again.list('w').map((j) => [j.action, j.state]), [['drift:7:unpushed', 'lost'], ['fix-findings', 'running']]);
  again.dismiss(again.list('w')[0].id);
  assert.deepEqual(again.list('w').map((j) => j.action), ['fix-findings']);
});
