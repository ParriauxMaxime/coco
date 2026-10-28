import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrift } from './drift.ts';
import type { Artifact, PrInfo, RowKey, Work } from './core-types.ts';

type Piece = { id: string; label: string; state: string; madeFor: string | null; at: string | null; source: string | null };
const piece = (id: string, state: string, extra: Partial<Piece> = {}): Piece => ({ id, label: id, state, madeFor: null, at: null, source: null, ...extra });
type Setup = { stack?: Work['stack']; prs?: Record<number, Partial<PrInfo>>; tips?: Record<string, string>; ahead?: Record<string, number | 'diverged'>; pieces?: Piece[]; comments?: { author: string; sha: string }[]; planHead?: string; open?: { number: number; baseRefName: string; headRefName: string }[]; personas?: string[]; artifacts?: Artifact[]; calls?: { cmd: string; args: string[]; opts?: unknown }[]; events?: string[]; worktrees?: Record<string, string>; fail?: string; archived?: boolean; missing?: boolean; trees?: Record<string, string>; rowDirs?: Record<number, string> };

const make = ({ stack, prs = {}, tips = {}, ahead = {}, pieces = [], comments = [], planHead, open = [], personas, artifacts = [], calls = [], events = [], worktrees = {}, fail, archived, missing, trees, rowDirs }: Setup = {}) => {
  const work = { slug: 'w', title: 'W', stack: stack || [{ number: 1, personas: ['alice'] }], personas, ...(archived && { archived: { at: 'x', reason: 'y' } }) } as unknown as Work;
  const info = (n: number): PrInfo => ({ number: n, state: 'OPEN', head: `b${n}`, base: 'main', headOid: `remote${n}`, ...prs[n] });
  return createDrift({
    config: { repo: { path: '/repo', github: 'o/r', defaultBranch: 'main' }, kitKinds: ['body', 'diagram', 'video'], gateSkills: { 'kit-body': ['lem-pr'], 'kit-video': ['lem-demo-video'] } } as never,
    works: { get: () => (missing ? null : work), prInfo: async (n) => info(n as number), listArtifacts: () => artifacts, changed: (slug, what) => void events.push(`${slug}:${what}`), dropPr: (n) => void events.push(`drop:${n}`) },
    kit: { view: async () => ({ pieces }) },
    reviewAgent: {
      branchSha: async (b) => tips[b] ?? null,
      worktreeFor: async (b) => worktrees[b] ?? null,
      exec: async (cmd, args, opts) => {
        if (args.includes('push') || args.slice(0, 2).join() === 'pr,edit') {
          calls.push({ cmd, args, opts });
          return fail ? { ok: false, stdout: '', stderr: fail } : { ok: true, stdout: 'done', stderr: '' };
        }
        if (cmd === 'gh') return { ok: true, stdout: JSON.stringify(open), stderr: '' };
        assert.deepEqual(args.slice(0, 2), ['-C', '/repo']);
        if (args[2] === 'worktree') return { ok: true, stdout: Object.entries(trees || {}).map(([p, b]) => `worktree ${p}\nHEAD abc\nbranch refs/heads/${b}`).join('\n\n'), stderr: '' };
        if (args.includes('rev-list')) return { ok: true, stdout: String(ahead[args.at(-1)?.split('..')[0] ?? ''] ?? 0), stderr: '' };
        const [a, b] = args.slice(-2);
        const n = ahead[a];
        return { ok: args.includes('merge-base') && (n === 'diverged' ? false : typeof n === 'number' && b !== a), stdout: '', stderr: '' };
      },
    },
    comments: { list: () => ({ comments }) },
    reviewPlan: { planOf: (_s: string, _n: RowKey) => (planHead ? { headSha: planHead } : null) },
    ...(rowDirs ? { rowDir: async (_s: string, key: RowKey) => rowDirs[key as number] ?? null } : {}),
  });
};
const kinds = async (d: ReturnType<typeof make>, list: 'drift' | 'next' = 'drift') => (await d.view('w', true))[list].map((i) => i.kind);

test('local commits ahead of the PR head are flagged with a push to run and to copy; a level head is not', async () => {
  const r = await (await make({ tips: { b1: 'tip1' }, ahead: { remote1: 3 } }).view('w', true)).drift[0];
  assert.deepEqual([r.kind, r.text, r.action, r.also], ['unpushed', '3 local commits not pushed', { type: 'run', command: 'git push origin b1', label: 'Push' }, { type: 'copy', command: 'git push origin b1', label: 'Copy push' }]);
  assert.deepEqual(await kinds(make({ tips: { b1: 'remote1' } })), []);
});

test('a local branch that diverged from GitHub is flagged without a push to run or copy', async () => {
  const [i] = (await make({ tips: { b1: 'tip1' }, ahead: { remote1: 'diverged' } }).view('w', true)).drift;
  assert.deepEqual([i.text, i.action, i.also, i.run], ['local branch and GitHub diverged: rebase or reset it before pushing', null, undefined, undefined]);
});

test('each open PR reports its local head against GitHub: pushed, commits ahead or behind, diverged, or no local branch', async () => {
  const heads = async (tips: Record<string, string>, ahead: Setup['ahead'] = {}) => (await make({ tips, ahead }).view('w', true)).heads.map(({ state, count }) => [state, count]);
  assert.deepEqual(await heads({ b1: 'remote1' }), [['pushed', undefined]]);
  assert.deepEqual(await heads({ b1: 'tip1' }, { remote1: 3 }), [['ahead', 3]]);
  assert.deepEqual(await heads({ b1: 'tip1' }, { tip1: 2 }), [['behind', 2]]);
  assert.deepEqual(await heads({ b1: 'tip1' }, { remote1: 'diverged' }), [['diverged', undefined]]);
  assert.deepEqual(await heads({}), [['remote', undefined]]);
});

test('run pushes the branch from the repo clone or its worktree, built here, and tells the page what changed', async () => {
  const calls: NonNullable<Setup['calls']> = [];
  const events: string[] = [];
  const setup = { tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls, events };
  const r = await make(setup).runItem('w', '1:unpushed', 'git push origin b1');
  assert.deepEqual([r.ok, r.stdout, r.command], [true, 'done', 'git push origin b1']);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [['git', ['-C', '/repo', 'push', 'origin', 'b1']]]);
  assert.deepEqual(events, ['drop:1', 'w:drift']);
  calls.length = 0;
  await make({ ...setup, worktrees: { b1: '/wt/b1' } }).runItem('w', '1:unpushed', 'git push origin b1');
  assert.deepEqual(calls[0].args, ['-C', '/wt/b1', 'push', 'origin', 'b1']);
  assert.ok(calls.every((c) => !c.args.some((a) => /^-f|force|\+/.test(a))));
});

test('run fixes a base with gh pr edit; a failed command returns its output as is and changes nothing', async () => {
  const calls: NonNullable<Setup['calls']> = [];
  const events: string[] = [];
  const setup = { stack: [{ number: 1 }, { number: 2 }], prs: { 2: { base: 'main' } }, calls, events };
  await make(setup).runItem('w', '2:stack', 'gh pr edit 2 --repo o/r --base b1');
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [['gh', ['pr', 'edit', '2', '--repo', 'o/r', '--base', 'b1']]]);
  events.length = 0;
  const bad = await make({ ...setup, fail: 'pre-push: check-ts failed\nsrc/a.ts(1,1): error TS2322' }).runItem('w', '2:stack', 'gh pr edit 2 --repo o/r --base b1');
  assert.deepEqual([bad.ok, bad.stderr], [false, 'pre-push: check-ts failed\nsrc/a.ts(1,1): error TS2322']);
  assert.deepEqual(events, []);
});

test('run refuses an item that no longer applies, one with no run action, a changed command or no id, and runs nothing', async () => {
  const calls: NonNullable<Setup['calls']> = [];
  const refused = (d: ReturnType<typeof make>, id: unknown, command?: unknown) => assert.rejects(d.runItem('w', id, command), (e: { status?: number }) => e.status === 409 || e.status === 400);
  await refused(make({ tips: { b1: 'remote1' }, calls }), '1:unpushed');
  await refused(make({ tips: { b1: 'tip1' }, ahead: { remote1: 'diverged' }, calls }), '1:unpushed');
  await refused(make({ pieces: [piece('body', 'stale')], calls }), '1:kit-body');
  await refused(make({ tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls }), '1:unpushed', 'git push origin other');
  await refused(make({ tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls }), '1:unpushed', 'git push --force origin b1');
  await refused(make({ calls }), '1:stack');
  await refused(make({ calls }), undefined);
  await refused(make({ tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls }), '1:unpushed');
  assert.deepEqual(calls, []);
});

test('run refuses an archived or missing work', async () => {
  const calls: NonNullable<Setup['calls']> = [];
  const setup = { tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls };
  await assert.rejects(make({ ...setup, archived: true }).runItem('w', '1:unpushed', 'git push origin b1'), (e: { status?: number }) => e.status === 409);
  await assert.rejects(make({ ...setup, missing: true }).runItem('w', '1:unpushed', 'git push origin b1'), (e: { status?: number }) => e.status === 404);
  assert.deepEqual(calls, []);
});

test('a fork PR gets no push to run', async () => {
  const [i] = (await make({ tips: { b1: 'tip1' }, ahead: { remote1: 2 }, prs: { 1: { isCrossRepository: true } } }).view('w', true)).drift;
  assert.deepEqual([i.kind, i.action, i.run], ['unpushed', null, undefined]);
});

test('the run route takes only an id: a command in the body is compared, never run', async () => {
  const calls = [] as NonNullable<Setup['calls']>;
  const d = make({ tips: { b1: 'tip1' }, ahead: { remote1: 2 }, calls });
  const post = async (body: unknown) => {
    const out = { code: 0, body: {} as { ok?: boolean; error?: string } };
    const req = { method: 'POST', url: '/api/works/w/drift/run' } as never;
    await d.handle(req, {} as never, ['works', 'w', 'drift', 'run'], async () => JSON.stringify(body), (_res, code, b) => void Object.assign(out, { code, body: b }));
    return out;
  };
  const evil = await post({ id: '1:unpushed', command: 'rm -rf /', cmd: 'rm', args: ['-rf', '/'] });
  assert.equal(evil.code, 409);
  assert.equal(calls.length, 0);
  assert.equal((await post({ id: '1:unpushed' })).code, 409);
  assert.equal(calls.length, 0);
  const ok = await post({ id: '1:unpushed', command: 'git push origin b1' });
  assert.deepEqual([ok.code, ok.body.ok], [200, true]);
  assert.deepEqual(calls.map((c) => c.args), [['-C', '/repo', 'push', 'origin', 'b1']]);
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
  assert.deepEqual([d.drift[0].action, d.drift[0].also], [{ type: 'run', command: 'gh pr edit 2 --repo o/r --base b1', label: 'Fix base' }, { type: 'copy', command: 'gh pr edit 2 --repo o/r --base b1', label: 'Copy base fix' }]);
  assert.deepEqual(await kinds(make({ stack, prs: { 2: { base: 'b1' } }, open: [{ number: 2, baseRefName: 'b1', headRefName: 'b2' }] })), []);
});

test('blocked demo beats of the latest video of a PR show, older videos and other PRs do not', async () => {
  const video = (name: string, pr: string, at: string, beats: string[]): Artifact => ({ name, isDir: false, size: 1, mtime: at, url: '', files: [], meta: { pr, kind: 'video', headSha: null, at, blocked: beats.map((beat) => ({ beat, what: 'no LLM key', unblock: 'set the key' })) } });
  const artifacts = [video('old.mp4', '1', '2026-10-01', ['old beat']), video('new.mp4', '1', '2026-10-02', ['lemAgent archives']), video('other.mp4', '2', '2026-10-03', ['x'])];
  const items = (await make({ artifacts }).view('w', true)).drift;
  assert.deepEqual(items.map((i) => [i.kind, i.text]), [['video-blocked-0', 'Demo beat "lemAgent archives" blocked: no LLM key. Unblock: set the key']]);
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

test('a row whose remembered workspace is not the worktree on the PR head is flagged, without an action', async () => {
  const two = (await make({ tips: { b1: 'remote1' }, trees: { '/wt/old': 'old-name', '/wt/b1': 'b1' }, rowDirs: { 1: '/wt/old' } }).view('w', true)).drift[0];
  assert.deepEqual([two.kind, two.text, two.action], ['worktrees', 'two worktrees for #1: /wt/old (on old-name), /wt/b1 (on b1)', null]);
  const stale = (await make({ tips: { b1: 'remote1' }, trees: { '/wt/old': 'old-name' }, rowDirs: { 1: '/wt/old' } }).view('w', true)).drift[0];
  assert.equal(stale.text, 'the worktree of #1, /wt/old, is on old-name, not the PR head b1');
  assert.deepEqual(await kinds(make({ tips: { b1: 'remote1' }, trees: { '/wt/b1': 'b1' }, rowDirs: { 1: '/wt/b1/' } })), []);
  assert.deepEqual(await kinds(make({ tips: { b1: 'remote1' }, trees: { '/wt/b1': 'b1' } })), []);
});
