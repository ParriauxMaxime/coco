import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaseoLink } from './paseo-link.ts';
import type { Req, Res, RowKey, Work } from './core-types.ts';

type ReviewRunFixture = { slug: string; number: RowKey; runId: string; agentId: string; status: string; startedAt?: string; commentIds: string[] };
type StackRunFixture = { id: string; slug: string; status: string; agentId: string; startedAt: string; cwd: string; rows: { key: RowKey; worktree: string; commentIds: string[] }[] };

const WORKS: Work[] = [
  { slug: 'invoices', title: 'Invoices', projectId: 'prj_a', stack: [{ number: 100 }, { number: 101 }] },
  { slug: 'old', title: 'Old', projectId: 'prj_b', archived: { at: '2026-01-01', reason: 'done' }, stack: [{ number: 200 }] },
];

function setup({ branch = 'feat/x', prNumber = 101, runs = [], stackRuns = [], stored = [], heads = {} }: { branch?: string; prNumber?: number | null; runs?: ReviewRunFixture[]; stackRuns?: StackRunFixture[]; stored?: { id: string; status: string }[]; heads?: Record<number, string> } = {}) {
  const calls: string[][] = [];
  const ingested: (string | number)[][] = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return { ok: true, stdout: `${branch}\n`, stderr: '' };
    return { ok: true, stdout: JSON.stringify(prNumber ? [{ number: prNumber }] : []), stderr: '' };
  };
  const works = { list: () => structuredClone(WORKS), prInfo: async (n: number) => (heads[n] ? { number: n, head: heads[n] } : { number: n, error: 'gh failed' }) };
  const comments = { list: () => ({ comments: stored }), follow: async () => [] };
  const code = { ensureRefs: async () => ({ headSha: 'abc' }) };
  const reviewAgent = {
    list: (slug: string, n: RowKey) => runs.filter((r) => r.slug === slug && r.number === n),
    ingest: async (slug: string, n: RowKey) => {
      ingested.push([slug, n]);
      return { runs: runs.filter((r) => r.slug === slug && r.number === n).map((r) => ({ ...r, status: 'done' })) };
    },
    sameDir: (a: string, b: string) => a === b,
  };
  const stackFix = {
    list: (slug: string) => stackRuns.filter((r) => r.slug === slug),
    ingest: async (slug: string) => {
      ingested.push([slug, 'stack']);
      return { runs: stackRuns.filter((r) => r.slug === slug).map((r) => ({ ...r, status: 'done' })) };
    },
  };
  return { link: createPaseoLink({ config: { repo: { github: 'acme/widgets' } }, works, comments, code, reviewAgent, stackFix, exec }), calls, ingested };
}

const stackRun = (over: Partial<StackRunFixture> = {}): StackRunFixture => ({
  id: 's1',
  slug: 'invoices',
  status: 'running',
  agentId: 'ag9',
  startedAt: '2026-10-20T10:00:00Z',
  cwd: '/wt-100',
  rows: [
    { key: 100, worktree: '/wt-100', commentIds: ['a'] },
    { key: 101, worktree: '/wt', commentIds: ['b'] },
  ],
  ...over,
});

test('resolve maps the worktree branch to its work and PR with comment counts', async () => {
  const stored = [{ id: 'a', status: 'open' }, { id: 'b', status: 'fixed' }, { id: 'c', status: 'open' }];
  const { link } = setup({ stored });
  const out = await link.resolve({ cwd: '/wt' });
  assert.equal(out.branch, 'feat/x');
  assert.deepEqual(out.work, { slug: 'invoices', title: 'Invoices', stack: [100, 101] });
  assert.deepEqual(out.pr?.comments, { total: 3, open: 2, fixed: 1 });
});

test('resolve lists the PR review runs and the stack fixes touching the workspace, newest first', async () => {
  const runs = [{ slug: 'invoices', number: 101, runId: 'r1', agentId: 'ag1', status: 'done', startedAt: '2026-10-19T10:00:00Z', commentIds: ['b'] }];
  const stackRuns = [stackRun(), stackRun({ id: 's2', rows: [{ key: 100, worktree: '/elsewhere', commentIds: ['a'] }], cwd: '/elsewhere' })];
  const { link } = setup({ runs, stackRuns, stored: [{ id: 'a', status: 'sent' }, { id: 'b', status: 'sent' }] });
  const out = await link.resolve({ cwd: '/wt' });
  assert.deepEqual(
    out.runs.map((r) => [r.kind, r.runId, r.agentId, r.comments.total]),
    [
      ['stack-fix', 's1', 'ag9', 2],
      ['review', 'r1', 'ag1', 1],
    ],
  );
});

test('resolve maps a local stack branch without PR to its work and its review runs', async () => {
  WORKS.push({ slug: 'local', title: 'Local', projectId: 'prj_c', stack: [{ planned: { branch: 'feat/local' } }] });
  try {
    const runs = [{ slug: 'local', number: 'b:feat:local', runId: 'r5', agentId: 'ag5', status: 'running', startedAt: '2026-10-20T10:00:00Z', commentIds: [] }];
    const { link } = setup({ branch: 'feat/local', prNumber: null, runs });
    const out = await link.resolve({ cwd: '/wt-local', projectId: 'prj_a' });
    assert.equal(out.work?.slug, 'local');
    assert.equal(out.pr, null);
    assert.deepEqual(out.runs.map((r) => [r.kind, r.pr, r.runId]), [['review', 'b:feat:local', 'r5']]);
  } finally {
    WORKS.pop();
  }
});

test('resolve falls back to the Paseo project when the branch has no PR in a work', async () => {
  const { link } = setup({ prNumber: null });
  const out = await link.resolve({ cwd: '/wt', projectId: 'prj_a' });
  assert.equal(out.work?.slug, 'invoices');
  assert.equal(out.pr, null);
});

test('resolve skips archived works', async () => {
  const { link } = setup({ prNumber: 200 });
  assert.equal((await link.resolve({ cwd: '/wt', projectId: 'prj_b' })).work, null);
});

test('resolve caches the PR lookup per branch', async () => {
  const { link, calls } = setup();
  await link.resolve({ cwd: '/wt' });
  await link.resolve({ cwd: '/wt' });
  assert.equal(calls.filter(([cmd]) => cmd === 'gh').length, 1);
});

test('run finds a review run by its label PR key and a stack fix by id', () => {
  const runs = [{ slug: 'invoices', number: 101, runId: 'r1', agentId: 'ag1', status: 'running', commentIds: ['a'] }];
  const { link } = setup({ runs, stackRuns: [stackRun()], stored: [{ id: 'a', status: 'sent' }] });
  assert.equal(link.run({ kind: 'review', slug: 'invoices', runId: 'r1', pr: '101' })?.status, 'running');
  assert.equal(link.run({ kind: 'stack-fix', slug: 'invoices', runId: 's1' })?.comments.total, 1);
  assert.equal(link.run({ kind: 'stack-fix', slug: 'invoices', runId: 'nope' }), null);
  assert.equal(link.run({ kind: 'review', slug: 'old', runId: 'r1', pr: '200' }), null);
});

test('turnEnded ingests only PRs with a running run for that agent', async () => {
  const runs = [
    { slug: 'invoices', number: 101, runId: 'r1', agentId: 'ag1', status: 'running', commentIds: ['a', 'b'] },
    { slug: 'invoices', number: 101, runId: 'r0', agentId: 'ag1', status: 'done', commentIds: ['a'] },
    { slug: 'invoices', number: 100, runId: 'r2', agentId: 'ag2', status: 'running', commentIds: ['c'] },
  ];
  const stored = [{ id: 'a', status: 'fixed' }, { id: 'b', status: 'declined' }, { id: 'c', status: 'sent' }];
  const { link, ingested } = setup({ runs, stored });
  const out = await link.turnEnded({ agentId: 'ag1' });
  assert.deepEqual(ingested, [['invoices', 101]]);
  assert.deepEqual(
    out.runs.map(({ kind, pr, runId, status, comments }) => ({ kind, pr, runId, status, comments })),
    [{ kind: 'review', pr: 101, runId: 'r1', status: 'done', comments: { total: 2, fixed: 1, declined: 1 } }],
  );
});

test('turnEnded settles the stack fix run of that agent', async () => {
  const { link, ingested } = setup({ stackRuns: [stackRun()], stored: [{ id: 'a', status: 'fixed' }, { id: 'b', status: 'declined' }] });
  const out = await link.turnEnded({ agentId: 'ag9' });
  assert.deepEqual(ingested, [['invoices', 'stack']]);
  assert.deepEqual(
    out.runs.map(({ kind, runId, status, comments }) => ({ kind, runId, status, comments })),
    [{ kind: 'stack-fix', runId: 's1', status: 'done', comments: { total: 2, fixed: 1, declined: 1 } }],
  );
});

test('stack lists the rows of the work holding a PR branch in merge order, with each PR head branch', async () => {
  const { link } = setup({ branch: 'feat/x', prNumber: 101, heads: { 100: 'feat/base' } });
  assert.deepEqual(await link.stack({ branch: 'feat/x' }), {
    work: { slug: 'invoices', title: 'Invoices' },
    rows: [
      { key: 100, branch: 'feat/base' },
      { key: 101, branch: 'feat/x' },
    ],
  });
});

test('stack finds a work by a planned branch without PR; a PR head gh cannot read falls back to its planned branch', async () => {
  WORKS.push({
    slug: 'gadgets',
    title: 'Gadgets',
    stack: [{ number: 300, planned: { branch: 'feat/g1' } }, { planned: { branch: 'feat/g2' } }, { planned: {} }],
  });
  try {
    const { link } = setup({ prNumber: null });
    assert.deepEqual(await link.stack({ branch: 'feat/g2' }), {
      work: { slug: 'gadgets', title: 'Gadgets' },
      rows: [
        { key: 300, branch: 'feat/g1' },
        { key: 'b:feat:g2', branch: 'feat/g2' },
      ],
    });
  } finally {
    WORKS.pop();
  }
});

test('stack answers no work for an unknown branch and for a branch of an archived work', async () => {
  assert.deepEqual(await setup({ prNumber: null }).link.stack({ branch: 'feat/nowhere' }), { work: null, rows: [] });
  assert.deepEqual(await setup({ prNumber: 200 }).link.stack({ branch: 'feat/old' }), { work: null, rows: [] });
});

test('GET /api/paseo-link/stack needs a branch', async () => {
  const { link } = setup({ heads: { 100: 'feat/base' } });
  const call = async (url: string) => {
    const sent: [number, unknown][] = [];
    const send = (_res: Res, code: number, body: unknown) => sent.push([code, body]);
    await link.handle({ method: 'GET', url } as Req, {} as Res, ['paseo-link', 'stack'], async () => '', send);
    return sent[0];
  };
  assert.deepEqual(await call('/api/paseo-link/stack'), [400, { error: 'branch required' }]);
  const [code, body] = (await call('/api/paseo-link/stack?branch=feat%2Fx')) ?? [];
  assert.equal(code, 200);
  assert.deepEqual(
    (body as { rows: { branch: string }[] }).rows.map((r) => r.branch),
    ['feat/base', 'feat/x'],
  );
});
