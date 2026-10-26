import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRepos, guessRepo } from './repos.ts';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

const repo = (id: string, github: string): RepoConfig => ({ id, name: id, path: `/tmp/${id}`, github, defaultBranch: 'main', tsconfig: '', rules: [], reviewsDir: '', commitConvention: '', settings: {} });
const REPOS = [repo('widgets', 'acme/widgets'), repo('docs', 'acme/docs')];
const work = (slug: string, extra: Partial<Work> = {}): Work => ({ slug, title: slug, stack: [], ...extra });

test('a GitHub link names the repo, whatever its case', async () => {
  assert.equal(await guessRepo(work('w', { links: [{ label: 'gh', url: 'https://github.com/Acme/Docs/pull/3' }] }), REPOS, async () => false), 'docs');
});

test('a planned branch found in a clone picks that repo', async () => {
  const stack = [{ number: null, planned: { title: 't', branch: 'feat/x' } }] as Work['stack'];
  assert.equal(await guessRepo(work('w', { stack }), REPOS, async (r, b) => r.id === 'docs' && b === 'feat/x'), 'docs');
});

test('nothing known falls back to the first repo', async () => {
  assert.equal(await guessRepo(work('w'), REPOS, async () => false), 'widgets');
});

test('assign leaves works that have a repo, and writes nothing on a dry run', async () => {
  const saved: Work[] = [];
  const repos = createRepos({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'coco-repos-')), repos: REPOS });
  const list = [work('a', { repo: 'docs' }), work('b')];
  assert.deepEqual(await repos.assign(list, (w) => saved.push(w), { dryRun: true, branchExists: async () => false }), [{ slug: 'b', repo: 'widgets' }]);
  assert.equal(saved.length, 0);
  await repos.assign(list, (w) => saved.push(w), { branchExists: async () => false });
  assert.deepEqual(saved.map((w) => [w.slug, w.repo]), [['b', 'widgets']]);
});

test('the saved order sorts repos and their works; unknown ids are dropped', () => {
  const repos = createRepos({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'coco-repos-')), repos: REPOS });
  repos.saveOrder({ repos: ['docs', 'nope', 'widgets'] });
  repos.saveOrder({ repo: 'widgets', works: ['b', 'a'] });
  const g = repos.grouped([{ slug: 'a', repo: 'widgets' }, { slug: 'b', repo: 'widgets' }, { slug: 'c', repo: 'docs' }, { slug: 'd' }]);
  assert.deepEqual(g.map((r) => [r.id, r.works.map((w) => w.slug)]), [['docs', ['c']], ['widgets', ['b', 'a', 'd']]]);
});
