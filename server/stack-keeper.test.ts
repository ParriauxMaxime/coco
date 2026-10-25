import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createStackKeeper, keepPlan, needsKeeping } from './stack-keeper.ts';
import type { ExecResult, Work } from './core-types.ts';

const rows: Parameters<typeof keepPlan>[0] = [
  { key: 1, number: 1, state: 'MERGED', branch: 'a', headOid: 'A1' },
  { key: 2, number: 2, state: 'OPEN', branch: 'b', tip: 'B1', worktree: '/wt/b', containsParent: true },
  { key: 'b:c', number: null, state: 'LOCAL', branch: 'c', tip: 'C1' },
];

test('after a parent merges, the first child leaves the parent head for origin/master and each next child follows its old parent tip', () => {
  const { parent, steps } = keepPlan(rows, { github: 'acme/widgets', branch: 'master' });
  assert.equal(parent?.number, 1);
  assert.deepEqual(steps.map((s) => [s.branch, s.onto.ref, s.upstream]), [['b', 'origin/master', 'A1'], ['c', 'b', 'B1']]);
  assert.deepEqual(steps[0].commands, ['git -C /wt/b fetch origin master', 'git -C /wt/b rebase --onto origin/master A1 b']);
  assert.equal(steps[0].ghBase, 'gh pr edit 2 --repo acme/widgets --base master');
  assert.equal(steps[1].ghBase, null);
});

test('apply rebases the child of a squash-merged parent onto origin/master and moves its Paseo baseRef; nothing is pushed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-'));
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'wt-b');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  execFileSync('git', ['clone', '-q', origin, repo]);
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  const commit = (file: string, text: string) => { fs.writeFileSync(path.join(repo, file), text); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', file); };
  commit('base.txt', 'base\n');
  sh(repo, 'push', '-q', 'origin', 'master');
  sh(repo, 'checkout', '-qb', 'a');
  commit('a.txt', 'a\n');
  const aHead = sh(repo, 'rev-parse', 'HEAD');
  sh(repo, 'checkout', '-qb', 'b');
  commit('b.txt', 'b\n');
  sh(repo, 'checkout', '-q', 'master');
  sh(repo, 'merge', '-q', '--squash', 'a');
  sh(repo, 'commit', '-qm', 'squash a');
  sh(repo, 'push', '-q', 'origin', 'master');
  sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
  sh(repo, 'worktree', 'add', '-q', wt, 'b');
  const meta = path.join(repo, '.git/worktrees/wt-b/paseo');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'worktree.json'), JSON.stringify({ version: 2, baseRefName: 'a', baseRef: 'refs/heads/a' }));

  let work: Work = { slug: 'w', title: 'W', stack: [{ number: 1 }, { number: 2 }] };
  const exec = (cmd: string, args: string[]) => (cmd === 'gh' ? Promise.resolve<ExecResult>({ ok: true, stdout: `${aHead}\n`, stderr: '' }) : new Promise<ExecResult>((resolve) => execFile(cmd, args, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }))));
  const keeper = createStackKeeper({
    REPO: repo,
    config: { repo: { github: 'acme/widgets', defaultBranch: 'master' } },
    works: { get: () => work, save: (w) => (work = w), prInfo: async (n) => ({ number: n ?? null, state: n === 1 ? 'MERGED' : 'OPEN', head: n === 1 ? 'a' : 'b' }) },
    reviewAgent: { exec, branchSha: async (b) => sh(repo, 'rev-parse', b), worktreeFor: async (b) => (b === 'b' ? wt : null), agentsList: async () => [], sameDir: () => false, timeline: () => {} },
  });
  const res: { code?: number; body?: unknown } = {};
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  await keeper.handle(req, new ServerResponse(req), ['works', 'w', 'stack-keeper', 'apply'], async () => '', (_res, code, body) => void Object.assign(res, { code, body }));
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(sh(repo, 'log', '--format=%s', 'origin/master..b'), 'b.txt');
  assert.equal(JSON.parse(fs.readFileSync(path.join(meta, 'worktree.json'), 'utf8')).baseRef, 'refs/remotes/origin/master');
  assert.equal(sh(repo, 'rev-parse', 'refs/cocopilot/base/2'), sh(repo, 'rev-parse', 'origin/master'));
  assert.equal(sh(repo, 'ls-remote', 'origin', 'refs/heads/b'), '');
  assert.equal(work.stack[1].keeper?.parent, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a child already kept for that parent, or no longer holding its head, is left alone', () => {
  assert.equal(keepPlan(rows.map((r) => (r.key === 2 ? { ...r, keptFor: 1 } : r))).parent, null);
  const { steps } = keepPlan(rows.map((r) => (r.key === 2 ? { ...r, containsParent: false } : r)));
  assert.equal(steps.length, 1);
  assert.match(steps[0].skip ?? '', /already rebased/);
  assert.equal(needsKeeping({ stack: [{ number: 1 }, { number: 2, keeper: { parent: 1 } }] }, { 1: { state: 'MERGED' }, 2: { state: 'OPEN' } }), false);
  assert.equal(needsKeeping({ stack: [{ number: 1 }, { number: 2 }] }, { 1: { state: 'MERGED' }, 2: { state: 'OPEN' } }), true);
});
