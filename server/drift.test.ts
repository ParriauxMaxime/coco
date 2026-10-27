import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrift } from './drift.ts';
import type { PrInfo, RowKey, Work } from './core-types.ts';

type Piece = { id: string; label: string; state: string; madeFor: string | null; at: string | null; source: string | null };
const piece = (id: string, state: string, extra: Partial<Piece> = {}): Piece => ({ id, label: id, state, madeFor: null, at: null, source: null, ...extra });
type Setup = { stack?: Work['stack']; prs?: Record<number, Partial<PrInfo>>; tips?: Record<string, string>; ahead?: Record<string, number | 'diverged'>; pieces?: Piece[]; comments?: { author: string; sha: string }[]; planHead?: string; open?: { number: number; baseRefName: string; headRefName: string }[]; personas?: string[] };

const make = ({ stack, prs = {}, tips = {}, ahead = {}, pieces = [], comments = [], planHead, open = [], personas }: Setup = {}) => {
  const work = { slug: 'w', title: 'W', stack: stack || [{ number: 1, personas: ['alice'] }], personas } as unknown as Work;
  const info = (n: number): PrInfo => ({ number: n, state: 'OPEN', head: `b${n}`, base: 'main', headOid: `remote${n}`, ...prs[n] });
  return createDrift({
    config: { repo: { github: 'o/r', defaultBranch: 'main' }, kitKinds: ['body', 'diagram', 'video'], gateSkills: { 'kit-body': ['lem-pr'], 'kit-video': ['lem-demo-video'] } } as never,
    works: { get: () => work, prInfo: async (n) => info(n as number) },
    kit: { view: async () => ({ pieces }) },
    reviewAgent: {
      branchSha: async (b) => tips[b] ?? null,
      exec: async (cmd, args) => {
        if (cmd === 'gh') return { ok: true, stdout: JSON.stringify(open), stderr: '' };
        if (args.includes('rev-list')) return { ok: true, stdout: String(ahead[args.at(-1)?.split('..')[0] ?? ''] ?? 0), stderr: '' };
        const [a, b] = args.slice(-2);
        const n = ahead[a];
        return { ok: args.includes('merge-base') && (n === 'diverged' ? false : typeof n === 'number' && b !== a), stdout: '', stderr: '' };
      },
    },
    comments: { list: () => ({ comments }) },
    reviewPlan: { planOf: (_s: string, _n: RowKey) => (planHead ? { headSha: planHead } : null) },
  });
};
const kinds = async (d: ReturnType<typeof make>, list: 'drift' | 'next' = 'drift') => (await d.view('w', true))[list].map((i) => i.kind);

test('local commits ahead of the PR head are flagged with a push to copy; a level head is not', async () => {
  const r = await (await make({ tips: { b1: 'tip1' }, ahead: { remote1: 3 } }).view('w', true)).drift[0];
  assert.deepEqual([r.kind, r.text, r.action], ['unpushed', '3 local commits not pushed', { type: 'copy', command: 'git push origin b1', label: 'Copy push' }]);
  assert.deepEqual(await kinds(make({ tips: { b1: 'remote1' } })), []);
});

test('a local branch that diverged from GitHub is flagged without a count', async () => {
  const [i] = (await make({ tips: { b1: 'tip1' }, ahead: { remote1: 'diverged' } }).view('w', true)).drift;
  assert.equal(i.text, 'local branch differs from GitHub (rebased?)');
});

test('a stale body or video offers the kit gate skill; a stale diagram with no skill opens artifacts; notion is ignored', async () => {
  const d = await make({ pieces: [piece('body', 'stale', { madeFor: 'abcdef123' }), piece('diagram', 'stale'), piece('video', 'fresh'), piece('notion', 'stale')] }).view('w', true);
  assert.deepEqual(d.drift.map((i) => [i.kind, i.action]), [['kit-body', { type: 'dispatch', entry: 'gate:kit-body:lem-pr', label: 'Update PR body' }], ['kit-diagram', { type: 'tab', tab: 'artifacts', label: 'Artifacts' }]]);
  const video = await make({ pieces: [piece('video', 'stale')] }).view('w', true);
  assert.equal((video.drift[0].action as { entry: string }).entry, 'gate:kit-video:lem-demo-video');
});

test('GitHub bases that differ from the work order are flagged with the gh command; a PR stacked on a row but missing from the work too', async () => {
  const stack = [{ number: 1 }, { number: 2 }];
  const d = await make({ stack, prs: { 2: { base: 'main' } }, open: [{ number: 9, baseRefName: 'b2', headRefName: 'b9' }, { number: 1, baseRefName: 'main', headRefName: 'b1' }] }).view('w', true);
  assert.deepEqual(d.drift.map((i) => [i.kind, i.key]), [['stack', 2], ['stack-missing', 9]]);
  assert.deepEqual(d.drift[0].action, { type: 'copy', command: 'gh pr edit 2 --repo o/r --base b1', label: 'Copy base fix' });
  assert.deepEqual(await kinds(make({ stack, prs: { 2: { base: 'b1' } }, open: [{ number: 2, baseRefName: 'b1', headRefName: 'b2' }] })), []);
});

test('a merged parent does not count as the base: the next open PR is expected on the default branch', async () => {
  const stack = [{ number: 1 }, { number: 2 }];
  assert.deepEqual(await kinds(make({ stack, prs: { 1: { state: 'MERGED' }, 2: { base: 'main' } } })), []);
});

test('a video newer than the body suggests updating the body once; a stale body already has its own button', async () => {
  const body = piece('body', 'fresh', { at: '2026-10-20T10:00:00Z', source: 'PR body' });
  const video = piece('video', 'fresh', { at: '2026-10-21T10:00:00Z', source: 'demo.mp4' });
  const reviewed = [{ author: 'as-alice', sha: 'remote1' }];
  const [n] = (await make({ pieces: [body, video], comments: reviewed }).view('w', true)).next;
  assert.deepEqual([n.kind, n.action], ['body-after-video', { type: 'dispatch', entry: 'gate:kit-body:lem-pr', label: 'Update PR body' }]);
  assert.deepEqual(await kinds(make({ pieces: [{ ...body, at: '2026-10-22T10:00:00Z' }, video], comments: reviewed }), 'next'), []);
  assert.deepEqual(await kinds(make({ pieces: [{ ...body, state: 'stale' }, video], comments: reviewed }), 'next'), []);
  assert.deepEqual(await kinds(make({ pieces: [body, { ...video, source: 'PR body' }], comments: reviewed }), 'next'), []);
});

test('a pushed head with no persona review suggests the row persona; a review, a plan, a ticked gate or unpushed commits silence it', async () => {
  const [n] = (await make({}).view('w', true)).next;
  assert.deepEqual([n.kind, n.action], ['persona-review', { type: 'dispatch', entry: 'persona-review', persona: 'alice', label: 'Persona review as alice' }]);
  assert.deepEqual(await kinds(make({ comments: [{ author: 'as-alice', sha: 'remote1' }] }), 'next'), []);
  assert.deepEqual(await kinds(make({ comments: [{ author: 'as-alice', sha: 'older' }] }), 'next'), ['persona-review']);
  assert.deepEqual(await kinds(make({ planHead: 'remote1' }), 'next'), []);
  assert.deepEqual(await kinds(make({ stack: [{ number: 1, personas: ['alice'], gates: { 'review-pr': { state: 'skipped', at: '' } } }] }), 'next'), []);
  assert.deepEqual(await kinds(make({ tips: { b1: 'tip1' }, ahead: { remote1: 1 } }), 'next'), []);
  assert.deepEqual(await kinds(make({ stack: [{ number: 1 }] }), 'next'), []);
  assert.deepEqual(await kinds(make({ stack: [{ number: 1 }], personas: ['bob'] }), 'next'), ['persona-review']);
});
