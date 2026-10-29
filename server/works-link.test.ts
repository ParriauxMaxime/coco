import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorks, rekeyed } from './works.ts';
import { DEFAULTS } from './config.ts';
import type { RunResult, Work } from './core-types.ts';

// a fake gh: `heads` maps a branch to the PRs GitHub lists for it; PR queries answer an open PR on branch b<n>
const make = (heads: Record<string, { number: number; isCrossRepository: boolean }[]>) => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-works-link-'));
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    const q = args.find((a) => a.startsWith('query='));
    if (cmd !== 'gh' || !q) return { ok: false, stdout: '', stderr: 'unexpected' };
    const asked = [...q.matchAll(/(h\d+):pullRequests\(headRefName:("[^"]+")/g)].map(([, alias, b]) => [alias, { nodes: heads[JSON.parse(b)] || [] }]);
    const prs = [...q.matchAll(/p(\d+):pullRequest/g)].map(([, n]) => [`p${n}`, { number: Number(n), title: `PR ${n}`, url: '', state: 'OPEN', isDraft: true, reviewDecision: null, headRefName: `b${n}`, baseRefName: 'main', additions: 0, deletions: 0, changedFiles: 0, mergedAt: null, updatedAt: '' }]);
    return { ok: true, stdout: JSON.stringify({ data: { repository: Object.fromEntries([...asked, ...prs]) } }), stderr: '' };
  };
  const config = { ...DEFAULTS, repo: { ...DEFAULTS.repo, github: 'acme/app' }, importRoots: [DATA] };
  const works = createWorks({ DATA, PERSONAS: path.join(DATA, 'personas'), REPO: DATA, config, run });
  const rekeys: [string, unknown, unknown][] = [];
  works.hooks.onRekeyed = (slug, from, to) => void rekeys.push([slug, from, to]);
  const detail = async (slug: string) => {
    let sent: { prs?: { number?: number | null }[] } = {};
    await works.handle({ method: 'GET', url: `/api/works/${slug}` } as never, {} as never, ['works', slug], async () => '', ((_res: unknown, _code: number, body: never) => void (sent = body)) as never);
    return sent;
  };
  return { works, rekeys, detail };
};
const planned = (branch: string) => ({ number: null, planned: { branch, title: branch } });

test('a planned row whose branch has a PR takes its number, and its branch key moves to the number', async () => {
  const { works, rekeys, detail } = make({ 'fix/a': [{ number: 77, isCrossRepository: true }, { number: 42, isCrossRepository: false }], 'fix/b': [] });
  works.save({ slug: 'w', title: 'w', stack: [planned('fix/a'), planned('fix/b')], timeline: [] } as unknown as Work);
  const d = await detail('w');
  assert.deepEqual(d.prs?.map((p) => p.number), [42, null]);
  assert.deepEqual(works.get('w')?.stack.map((s) => s.number), [42, null]);
  assert.equal(works.get('w')?.stack[0].planned?.branch, 'fix/a');
  assert.deepEqual(rekeys, [['w', 'b:fix:a', 42]]);
  assert.match(works.get('w')?.timeline?.[0]?.text || '', /fix\/a opened as #42/);
});

test('a PR another row already holds is not linked twice', async () => {
  const { works, rekeys, detail } = make({ 'fix/a': [{ number: 42, isCrossRepository: false }] });
  works.save({ slug: 'w', title: 'w', stack: [{ number: 42 }, planned('fix/a')], timeline: [] } as unknown as Work);
  await detail('w');
  assert.deepEqual(works.get('w')?.stack.map((s) => s.number), [42, null]);
  assert.deepEqual(rekeys, []);
});

test('rekeyed: a row keeping its branch and getting a number moves; a new or removed row does not', () => {
  assert.deepEqual(rekeyed([planned('fix/a')], [{ number: 5, planned: { branch: 'fix/a' } }]), [['b:fix:a', 5]]);
  assert.deepEqual(rekeyed([], [{ number: 5, planned: { branch: 'fix/a' } }]), []);
  assert.deepEqual(rekeyed([planned('fix/a')], []), []);
  assert.deepEqual(rekeyed([planned('fix/a')], [planned('fix/a')]), []);
});
