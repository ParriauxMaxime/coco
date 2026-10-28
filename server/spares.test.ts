import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSpares } from './spares.ts';
import type { Readiness } from './agent-worktree.ts';
import type { RepoConfig } from './config.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// a clone of acme/widgets with two commits on main; spares: how many the repo wants, warm: a step writing a marker in the spare
function scene(spares: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-spares-'));
  const clone = path.join(root, 'widgets');
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  const first = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'second');
  const repo = { id: 'widgets', name: 'widgets', path: clone, github: 'acme/widgets', defaultBranch: 'main', settings: {} } as unknown as RepoConfig;
  const warm = [{ label: 'Type check cache', command: ['sh', '-c', 'echo warm > .warm'] }];
  const prepared: string[] = [];
  const ready = (root: string): Readiness => ({ state: 'ready', root, deps: [], checks: [] });
  const pool = createSpares({ DATA: path.join(root, 'data'), config: { repos: [repo], agentWorktree: { deps: [], checks: [], spares, warm } }, prepare: async (dir) => (prepared.push(dir), ready(dir)), pollMs: 5 });
  fs.mkdirSync(path.join(root, 'data'));
  return { pool, clone, first, prepared };
}

test('fills the pool with detached worktrees, deps readied and warmed; a claim switches one to the branch at the base and refills', async () => {
  const { pool, clone, first, prepared } = scene(2);
  await pool.start();
  const made = pool.list();
  assert.equal(made.length, 2);
  assert.ok(made.every((s) => s.state === 'ready' && fs.readFileSync(path.join(s.path, '.warm'), 'utf8').trim() === 'warm'));
  assert.deepEqual(prepared.sort(), made.map((s) => s.path).sort());

  const dir = await pool.claim('widgets', { branch: 'cocopilot/abc123', base: first });
  assert.ok(dir && made.some((s) => s.path === dir));
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'cocopilot/abc123');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), first);
  await until(() => pool.list().length === 2 && pool.list().every((s) => s.state === 'ready'), 'the refill');
  assert.ok(!pool.list().some((s) => s.path === dir), 'the claimed worktree left the pool');
  assert.match(git(clone, 'worktree', 'list'), /cocopilot\/abc123/);
});

test('no spare wanted, or none made yet: claim answers null and the caller makes its own worktree', async () => {
  const off = scene(0);
  await off.pool.start();
  assert.equal(await off.pool.claim('widgets', { branch: 'b', base: off.first }), null);
  assert.equal(off.pool.list().length, 0);

  const cold = scene(1);
  assert.equal(await cold.pool.claim('widgets', { branch: 'b', base: cold.first }), null, 'the pool was never filled');
  await until(() => cold.pool.list().some((s) => s.state === 'ready'), 'the fill the claim started');
});
