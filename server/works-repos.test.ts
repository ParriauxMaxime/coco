import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorks } from './works.ts';
import { DEFAULTS } from './config.ts';
import type { RunResult, Work } from './core-types.ts';

// a fake gh: each GraphQL query answers its PRs titled with the repo it asked
const make = () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-works-repos-'));
  const queries: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    const q = args.find((a) => a.startsWith('query='));
    if (cmd !== 'gh' || !q) return { ok: false, stdout: '', stderr: 'unexpected' };
    const [, owner, name] = /owner:"([^"]+)",name:"([^"]+)"/.exec(q) || [];
    queries.push(`${owner}/${name}`);
    const repository = Object.fromEntries([...q.matchAll(/p(\d+):pullRequest/g)].map(([, n]) => [`p${n}`, { number: Number(n), title: `${owner}/${name}`, url: `https://github.com/${owner}/${name}/pull/${n}`, state: 'OPEN', isDraft: false, reviewDecision: null, headRefName: `b${n}`, baseRefName: 'main', additions: 0, deletions: 0, changedFiles: 0, mergedAt: null, updatedAt: '' }]));
    return { ok: true, stdout: JSON.stringify({ data: { repository } }), stderr: '' };
  };
  const repo = (id: string, github: string) => ({ ...DEFAULTS.repo, github, id, name: id, settings: {} });
  const config = { ...DEFAULTS, repo: { ...DEFAULTS.repo, github: 'acme/app' }, repos: [repo('app', 'acme/app'), repo('tool', 'acme/tool')], importRoots: [DATA] };
  const works = createWorks({ DATA, PERSONAS: path.join(DATA, 'personas'), REPO: DATA, config, run });
  const work = (slug: string, repoId: string, numbers: number[], archived = false) => works.save({ slug, title: slug, repo: repoId, stack: numbers.map((number) => ({ number })), timeline: [], ...(archived ? { archived: { at: '', reason: 'manual' } } : {}) } as unknown as Work);
  return { works, work, queries };
};

test('a PR number resolves to the repo of the work holding it, a live work before an archived one; one GraphQL query per repo', async () => {
  const { works, work, queries } = make();
  work('old', 'app', [101], true);
  work('cli', 'tool', [101]);
  work('web', 'app', [202]);
  const [a, b] = await Promise.all([works.prInfo(101), works.prInfo(202)]);
  assert.deepEqual([a.title, b.title], ['acme/tool', 'acme/app']);
  assert.deepEqual(queries.sort(), ['acme/app', 'acme/tool']);
});

test('two works in two repos holding PR 101 each read their own repo, cached apart', async () => {
  const { works, work, queries } = make();
  work('web', 'app', [101]);
  work('cli', 'tool', [101]);
  assert.equal((await works.prInfo(101, false, 'acme/app')).title, 'acme/app');
  assert.equal((await works.prInfo(101, false, 'acme/tool')).title, 'acme/tool');
  assert.equal((await works.prInfo(101, false, 'acme/app')).title, 'acme/app');
  assert.deepEqual(queries, ['acme/app', 'acme/tool']);
  const sent: { slug?: string; prs?: { title?: string }[] }[] = [];
  for (const slug of ['web', 'cli']) await works.handle({ method: 'GET', url: `/api/works/${slug}` } as never, {} as never, ['works', slug], async () => '', ((_res: unknown, _code: number, body: never) => void sent.push(body)) as never);
  assert.deepEqual(sent.map((d) => d.prs?.map((p) => p.title)), [['acme/app'], ['acme/tool']]);
});

test('the number to repo memo is forgotten when a work changes', async () => {
  const { works, work } = make();
  work('cli', 'tool', [101]);
  assert.equal((await works.prInfo(101)).title, 'acme/tool');
  work('cli', 'tool', []);
  assert.equal((await works.prInfo(101)).title, 'acme/app');
});

test('a PR typed in ⌘K opens the work holding it, else a solo work pr-<n> in the repo of its URL, titled after the PR', async () => {
  const { works, work } = make();
  work('cli', 'tool', [101]);
  work('old', 'app', [101], true);
  assert.deepEqual(await works.fromPr(101, 'Acme/Tool'), { slug: 'cli', created: false });
  assert.deepEqual(await works.fromPr(101), { slug: 'old', created: false });
  assert.deepEqual(await works.fromPr(303, 'acme/tool', false), { slug: null, title: 'acme/tool', github: 'acme/tool' });
  assert.equal(works.get('pr-303'), null);
  assert.deepEqual(await works.fromPr(303, 'acme/tool'), { slug: 'pr-303', created: true });
  const made = works.get('pr-303');
  assert.deepEqual([made?.title, made?.repo, made?.tier, made?.stack?.map((s) => s.number)], ['acme/tool', 'tool', 'solo', [303]]);
  assert.deepEqual(await works.fromPr(303, 'acme/tool'), { slug: 'pr-303', created: false });
  assert.deepEqual(await works.fromPr(303), { slug: 'pr-303-app', created: true });
});

test('POST /api/works/from-pr refuses a missing number and a PR GitHub does not know', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-works-from-pr-'));
  const run = async (): Promise<RunResult> => ({ ok: true, stdout: JSON.stringify({ data: { repository: { p9: null } } }), stderr: '' });
  const works = createWorks({ DATA, PERSONAS: path.join(DATA, 'personas'), REPO: DATA, config: { ...DEFAULTS, repo: { ...DEFAULTS.repo, github: 'acme/app' }, repos: [{ ...DEFAULTS.repo, github: 'acme/app', id: 'app', name: 'app', settings: {} }] }, run });
  const call = async (body: unknown) => {
    let out: [number, unknown] = [0, null];
    await works.handle({ method: 'POST', url: '/api/works/from-pr' } as never, {} as never, ['works', 'from-pr'], async () => JSON.stringify(body), ((_res: unknown, code: number, b: unknown) => void (out = [code, b])) as never);
    return out;
  };
  assert.equal((await call({}))[0], 400);
  assert.equal((await call({ pr: 9 }))[0], 404);
  assert.equal(works.get('pr-9'), null);
});
