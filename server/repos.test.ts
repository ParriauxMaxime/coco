import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createRepoAdder, createRepos, guessRepo, parseSource } from './repos.ts';
import { loadConfig, withRepo } from './config.ts';
import type { RepoConfig } from './config.ts';
import type { RunResult, Work } from './core-types.ts';

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

test('a repo added to a config with a single repo lists that repo first, every other line kept as written', () => {
  const text = '{\n  "owner": { "name": "Alice", "login": "alice" },\n  "repo": { "path": "~/code/widgets", "github": "acme/widgets", "defaultBranch": "main", "rules": ["AGENTS.md"] },\n  "kitKinds": ["body"]\n}\n';
  const out = withRepo(text, { id: 'docs', name: 'docs', path: '~/code/docs', github: 'acme/docs', defaultBranch: 'main' }, { id: 'widgets', name: 'widgets', path: '/home/alice/code/widgets' });
  assert.ok(out.startsWith(text.slice(0, text.lastIndexOf('\n}'))));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-app-'));
  fs.writeFileSync(path.join(app, 'coco.config.json'), out);
  const c = loadConfig({ APP: app, file: path.join(app, 'coco.config.json') });
  assert.deepEqual(c.repos.map((r) => [r.id, r.github, r.rules]), [['widgets', 'acme/widgets', ['AGENTS.md']], ['docs', 'acme/docs', ['AGENTS.md', 'CLAUDE.md']], ['cocopilot', '', ['AGENTS.md', 'CLAUDE.md']]]);
  assert.equal(c.repo.github, 'acme/widgets');
});

test('a repo added to a listed config goes last, the entries already there kept as written', () => {
  const entry = '{\n      "id": "widgets",\n      "path": "~/code/widgets",\n      "settings": { "kitKinds": ["body"] }\n    }';
  const text = `{\n    "owner": { "name": "Alice" },\n    "repos": [\n    ${entry}\n    ],\n    "kitKinds": ["body"]\n}`;
  const out = withRepo(text, { id: 'docs', name: 'docs', path: '/srv/docs' }, null);
  assert.ok(out.includes(entry));
  assert.deepEqual(JSON.parse(out).repos.map((r: { id: string }) => r.id), ['widgets', 'docs']);
  assert.deepEqual(JSON.parse(out).kitKinds, ['body']);
});

test('a source is a GitHub slug, a GitHub URL or an absolute folder', () => {
  assert.deepEqual(parseSource('acme/widgets'), { slug: 'acme/widgets' });
  assert.deepEqual(parseSource('https://github.com/acme/widgets.git'), { slug: 'acme/widgets' });
  assert.deepEqual(parseSource('git@github.com:acme/widgets.git'), { slug: 'acme/widgets' });
  assert.deepEqual(parseSource('/srv/widgets'), { dir: '/srv/widgets' });
  assert.deepEqual(parseSource('~/code/widgets'), { dir: path.join(os.homedir(), 'code/widgets') });
  assert.equal(parseSource('widgets'), null);
});

const execReal = (cmd: string, args: string[]) => new Promise<RunResult>((resolve) => execFile(cmd, args, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));
const gitInit = (dir: string, origin?: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (origin) execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
};
// a clone folder holding the default repo and coco itself, a config listing the default repo, and gh clones faked into a git init
function adderWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-add-')));
  const APP = gitInit(path.join(root, 'coco'));
  const widgets = gitInit(path.join(root, 'widgets'), 'https://github.com/acme/widgets.git');
  const configFile = path.join(root, 'coco.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ repos: [{ id: 'widgets', path: widgets }] }, null, 2));
  const config = { repos: [{ ...repo('widgets', 'acme/widgets'), path: widgets }, { ...repo('cocopilot', ''), path: APP }], cloneDir: root };
  const calls: string[] = [];
  const exec = async (cmd: string, args: string[]) => {
    if (cmd !== 'gh') return execReal(cmd, args);
    calls.push(args.join(' '));
    gitInit(args[3], `git@github.com:${args[2]}.git`);
    return { ok: true, stdout: '', stderr: '' };
  };
  const started: string[] = [];
  const adder = createRepoAdder({ config, APP, configFile, exec, project: async (r) => ({ projectId: `prj_${r.id}`, name: r.name }), setup: async (r) => (started.push(r.id), { agentId: `agent-${r.id}` }) });
  return { root, config, configFile, calls, started, adder };
}

test('a local folder becomes a repo ahead of coco, listed in the config file, with its project and setup run', async () => {
  const w = adderWorld();
  const gadgets = gitInit(path.join(w.root, 'scratch', 'gadgets'));
  const r = await w.adder.add(gadgets);
  assert.deepEqual([r.ok, r.how, r.repo?.id, r.repo?.github, r.project?.projectId, r.setup?.agentId], [true, 'folder', 'gadgets', '', 'prj_gadgets', 'agent-gadgets']);
  assert.deepEqual(w.config.repos.map((x) => x.id), ['widgets', 'gadgets', 'cocopilot']);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.configFile, 'utf8')).repos.map((x: { id: string }) => x.id), ['widgets', 'gadgets']);
  const again = await w.adder.add(gadgets);
  assert.deepEqual([again.ok, again.existing], [false, 'gadgets']);
  assert.deepEqual(w.started, ['gadgets']);
});

test('a slug reuses the clone whose origin it is, whatever its folder name, and clones into cloneDir when none is', async () => {
  const w = adderWorld();
  const docs = gitInit(path.join(w.root, 'docs-site'), 'git@github.com:Acme/Docs.git');
  const found = await w.adder.add('acme/docs');
  assert.deepEqual([found.how, found.repo?.path, found.repo?.github], ['found', docs, 'Acme/Docs']);
  const cloned = await w.adder.add('acme/gadgets');
  assert.deepEqual([cloned.how, cloned.repo?.path, cloned.repo?.github], ['cloned', path.join(w.root, 'gadgets'), 'acme/gadgets']);
  assert.deepEqual(w.calls, [`repo clone acme/gadgets ${path.join(w.root, 'gadgets')}`]);
  assert.deepEqual((await w.adder.add('acme/widgets')).existing, 'widgets');
});

test('the saved order sorts repos and their works; unknown ids are dropped', () => {
  const repos = createRepos({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'coco-repos-')), repos: REPOS });
  repos.saveOrder({ repos: ['docs', 'nope', 'widgets'] });
  repos.saveOrder({ repo: 'widgets', works: ['b', 'a'] });
  const g = repos.grouped([{ slug: 'a', repo: 'widgets' }, { slug: 'b', repo: 'widgets' }, { slug: 'c', repo: 'docs' }, { slug: 'd' }]);
  assert.deepEqual(g.map((r) => [r.id, r.works.map((w) => w.slug)]), [['docs', ['c']], ['widgets', ['b', 'a', 'd']]]);
});
