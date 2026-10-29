import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backfillLanded, landedRow, landedTip } from './landed.ts';
import type { Git } from './landed.ts';
import { createWorks } from './works.ts';
import { renderWorkMarkdown } from './notion.ts';
import { DEFAULTS } from './config.ts';
import type { PrInfo, StackRow, Work } from './core-types.ts';

const ID = ['-c', 'user.name=alice', '-c', 'user.email=alice@acme.test'];
// main with one commit; feat/shipped fast-forwarded onto main, feat/fresh created at main since, feat/open a commit ahead of main
function fixture(t: { after(fn: () => void): void }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-landed-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sh = (...args: string[]) => execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8' }).trim();
  const commit = (msg: string) => {
    fs.writeFileSync(path.join(repo, `${msg}.txt`), msg);
    sh('add', '.');
    sh('commit', '-qm', msg);
  };
  sh('init', '-q', '-b', 'main');
  commit('init');
  sh('checkout', '-qb', 'feat/shipped');
  commit('shipped');
  sh('checkout', '-q', 'main');
  sh('merge', '-q', '--ff-only', 'feat/shipped');
  sh('branch', 'feat/fresh');
  sh('checkout', '-qb', 'feat/open');
  commit('open');
  sh('checkout', '-q', 'main');
  const git: Git = async (args) => {
    try {
      return { ok: true, stdout: execFileSync('git', ['-C', repo, '--no-optional-locks', ...args], { encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
    } catch (e) {
      return { ok: false, stdout: '', stderr: String(e) };
    }
  };
  return { repo, git, tip: (ref: string) => sh('rev-parse', ref) };
}

const row = (order: number, branch: string, title = branch, more: Partial<StackRow> = {}): StackRow => ({ number: null, planned: { order, title, branch }, ...more });

test('a branch landed when its own commits sit on main; a fresh branch, an open one and main itself did not', async (t) => {
  const { git, tip } = fixture(t);
  assert.equal((await landedTip(git, 'feat/shipped', 'main'))?.sha, tip('feat/shipped'));
  assert.equal(await landedTip(git, 'feat/fresh', 'main'), null, 'created at main, no commit of its own');
  assert.equal(await landedTip(git, 'feat/open', 'main'), null);
  assert.equal(await landedTip(git, 'main', 'main'), null);
  assert.equal(await landedTip(git, 'feat/gone', 'main'), null);
});

test('a row is found by its order, branch or key; a branch two rows share needs the order', () => {
  const stack = [row(1, 'main', 'a'), row(2, 'main', 'b'), row(3, 'feat/x')];
  assert.equal(landedRow(stack, 2).planned?.title, 'b');
  assert.equal(landedRow(stack, '3').planned?.branch, 'feat/x');
  assert.equal(landedRow(stack, 'feat/x').planned?.order, 3);
  assert.equal(landedRow(stack, 'b:feat:x').planned?.order, 3);
  assert.throws(() => landedRow(stack, 'main'), { status: 409 });
  assert.throws(() => landedRow(stack, 9), { status: 404 });
});

test('rows titled "✓ " by hand lose the mark and land once: at their branch tip when it landed, else at main', async (t) => {
  const { git, tip } = fixture(t);
  const works = new Map<string, Work>([['coco', { slug: 'coco', title: 'coco', stack: [row(1, 'feat/shipped', '✓ Ship it'), row(2, 'main', '✓ Hotfix'), row(3, 'feat/open', 'Next')], timeline: [] } as unknown as Work]]);
  const store = { list: () => [...works.values()].map((w) => structuredClone(w)), save: (w: Work) => void works.set(w.slug, structuredClone(w)) };
  assert.deepEqual(await backfillLanded(store, () => ({ git, base: 'main' })), [{ slug: 'coco', rows: 2 }]);
  const stack = works.get('coco')?.stack || [];
  assert.deepEqual(stack.map((s) => [s.planned?.title, s.landed?.sha ?? null, s.landed?.by ?? null]), [['Ship it', tip('feat/shipped'), 'owner'], ['Hotfix', tip('main'), 'owner'], ['Next', null, null]]);
  assert.deepEqual(await backfillLanded(store, () => ({ git, base: 'main' })), [], 'a second run finds nothing to do');
});

test('the owner marks a planned row landed at main and undoes it for good; a work read sees a landed branch on its own', async (t) => {
  const { repo, tip } = fixture(t);
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-landed-data-'));
  t.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
  const config = { ...DEFAULTS, repo: { ...DEFAULTS.repo, github: '', path: repo, defaultBranch: 'main' }, repos: [{ ...DEFAULTS.repo, id: 'app', name: 'app', github: '', path: repo, defaultBranch: 'main', settings: {} }] };
  const works = createWorks({ DATA, PERSONAS: path.join(DATA, 'personas'), REPO: repo, config });
  works.save({ slug: 'w', title: 'W', repo: 'app', stack: [row(1, 'main', 'Hotfix'), row(2, 'feat/shipped'), row(3, 'feat/open'), { number: 7, planned: { order: 4 } }], timeline: [] } as unknown as Work);
  const call = async (method: string, sub: string[], body?: unknown) => {
    let out: { code: number; body: Record<string, unknown> } = { code: 0, body: {} };
    await works.handle({ method, url: `/api/works/w/${sub.join('/')}` } as never, {} as never, ['works', 'w', ...sub], async () => JSON.stringify(body ?? {}), ((_res: unknown, code: number, b: Record<string, unknown>) => void (out = { code, body: b })) as never);
    return out;
  };

  const marked = await call('POST', ['landed'], { row: 1, by: 'owner' });
  assert.equal(marked.code, 200);
  assert.deepEqual([(marked.body.landed as { sha: string }).sha, (marked.body.landed as { by: string }).by], [tip('main'), 'owner']);
  assert.equal((await call('POST', ['landed'], { row: 'feat/open', by: 'agent', sha: tip('feat/open') })).code, 409, 'not on main');
  assert.equal((await call('POST', ['landed'], { row: 4, by: 'owner' })).code, 409, 'a row with a PR lands when GitHub merges it');
  assert.equal((await call('POST', ['landed'], { row: 1, by: 'nobody' })).code, 400);
  assert.equal((await call('POST', ['landed'], { row: 1, by: 'owner', sha: 'HEAD; rm' })).code, 400);

  const states = async () => ((await call('GET', [])).body.prs as PrInfo[]).map((p) => [p.state, p.landed?.by ?? null]);
  const read = await states();
  assert.deepEqual(read.slice(0, 3), [['LANDED', 'owner'], ['LANDED', 'detected'], ['PLANNED', null]]);
  assert.match(works.get('w')?.timeline?.[0]?.text || '', /feat\/shipped is on main at \w{7} with no PR/);

  assert.equal((await call('POST', ['landed'], { row: 'feat/shipped', by: 'owner', clear: true })).code, 200);
  assert.equal(works.get('w')?.stack[1].landed, null);
  assert.deepEqual((await states()).slice(1, 2), [['PLANNED', null]], 'an undone row stays planned');
});

test('the Notion stack table says landed, with the commit, and the progress line counts it', () => {
  const landed = { sha: 'abc1234def', at: '2026-10-29T10:00:00Z', by: 'agent' as const };
  const md = renderWorkMarkdown({ slug: 'w', title: 'W', stack: [row(1, 'feat/a', 'A', { landed }), row(2, 'feat/b', 'B')] } as unknown as Work, [{ number: null, state: 'LANDED', landed }, { number: null, state: 'PLANNED' }]);
  assert.match(md, /0\/2 merged · 1 landed/);
  assert.match(md, /\| landed · `abc1234` \| A \| .* \| landed \|/);
  assert.match(md, /\| planned · `feat\/b` \| B \| .* \| planned \|/);
});
