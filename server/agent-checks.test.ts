import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentChecks } from './agent-checks.ts';
import { briefLines } from './agent-worktree.ts';
import type { Readiness, Verification } from './agent-worktree.ts';
import type { Work } from './core-types.ts';

const AGENT = '00000000-0000-4000-8000-000000000001';
const ready: Readiness = { state: 'ready', root: '/wt/widgets-7', deps: [], checks: [{ id: 'lint', label: 'Lint', command: 'lint <changed files>', available: true }] };
const run = (state: 'passed' | 'failed', head: string): Verification => ({ state, at: '2026-10-27T10:00:00Z', head, files: ['src/a.ts'], results: [{ id: 'lint', label: 'Lint', state, command: 'lint src/a.ts', ...(state === 'failed' ? { output: 'no-unused-vars' } : {}) }] });

test('a PR-branch agent gets its commits checked when a turn ends: a card in its chat, the row on the Gates rail, a failure sent back once until a pass', async (t) => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-checks-'));
  t.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
  let head = 'base000';
  const results: ('passed' | 'failed')[] = ['failed', 'failed', 'passed'];
  const verified: [string, string][] = [];
  const posted: string[] = [];
  const said: string[] = [];
  const work: Work = { slug: 'widgets', title: 'Widgets', stack: [{ number: 7 }] } as Work;
  const checks = createAgentChecks({
    DATA,
    worktrees: { prepare: async () => ready, whenReady: () => {}, briefLines: (r) => briefLines(r), head: async () => head, verify: async (_root, { base, head: h }) => (verified.push([base, h]), run(results[verified.length - 1], h)) },
    post: async (_id, title) => void posted.push(title),
    say: async (_id, text) => void said.push(text),
    works: { get: () => work, save: () => {} },
  });
  checks.readier.started(AGENT, '/wt/widgets-7', { slug: 'widgets', key: 7 });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(await checks.turnEnded(AGENT), null, 'no commit yet');
  head = 'c0ffee1';
  assert.equal((await checks.turnEnded(AGENT))?.state, 'failed');
  assert.equal(await checks.turnEnded(AGENT), null, 'same head is not checked twice');
  head = 'c0ffee2';
  await checks.turnEnded(AGENT);
  head = 'c0ffee3';
  await checks.turnEnded(AGENT);

  assert.deepEqual(verified, [['base000', 'c0ffee1'], ['base000', 'c0ffee2'], ['base000', 'c0ffee3']]);
  assert.deepEqual(posted, ['coco checks on c0ffee1: failed', 'coco checks on c0ffee2: failed', 'coco checks on c0ffee3: passed']);
  assert.equal(said.length, 1, 'the failure goes back once');
  assert.match(said[0], /your commits \(c0ffee1\): Lint failed[\s\S]*no-unused-vars/);
  assert.deepEqual(work.stack[0].agentChecks && { state: work.stack[0].agentChecks.state, head: work.stack[0].agentChecks.head, agentId: work.stack[0].agentChecks.agentId }, { state: 'passed', head: 'c0ffee3', agentId: AGENT });
});
