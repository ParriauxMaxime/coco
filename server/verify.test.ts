import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentWorktrees } from './agent-worktree.ts';
import type { Run } from './agent-worktree.ts';
import { reusable, verifyCommit } from './verify.ts';
import type { VerifyRun } from './verify.ts';
import { DEFAULTS } from './config.ts';
import type { Config } from './config.ts';

const COMMIT = 'c'.repeat(40);
const checks = [
  { id: 'lint', label: 'Lint', command: ['bin/lint', '{files}'], files: '\\.ts$' },
  { id: 'fmt', label: 'Format', command: ['oxfmt', '--check', '{files}'], files: '\\.ts$' },
  { id: 'types', label: 'Types', command: ['npm', 'run', 'check-ts'] },
  { id: 'tests', label: 'Tests', command: ['node', '--test', '{tests}'] },
  { id: 'css', label: 'Styles', command: ['stylelint', '{files}'], files: '\\.css$' },
];

// a main checkout and a worktree on disk; git and every check go through a fake run that logs the commands
function fixture(t: { after(fn: () => void): void }, { lock = '1', mainModules = true }: { lock?: string; mainModules?: boolean } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-verify-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const wt = path.join(dir, 'wt');
  fs.mkdirSync(path.join(main, '.git'), { recursive: true });
  if (mainModules) fs.mkdirSync(path.join(main, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(main, 'package-lock.json'), '1');
  fs.writeFileSync(path.join(wt, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(wt, 'bin/lint'), '');
  for (const f of ['src/a.ts', 'src/a.test.ts', 'src/b.ts', 'README.md']) fs.writeFileSync(path.join(wt, f), '');
  const calls: string[] = [];
  const failing = new Set<string>();
  const run: Run = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { ok: true, output: `${path.join(main, '.git/worktrees/wt')}\n${path.join(main, '.git')}` };
    if (cmd === 'git' && args[0] === 'diff') return { ok: true, output: 'src/a.ts\nsrc/b.ts\nREADME.md' };
    calls.push([cmd, ...args].join(' '));
    const bad = failing.has(cmd) ? { ok: false, output: Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') } : null;
    return bad ?? { ok: true, output: '' };
  };
  const config = { ...DEFAULTS, repos: [{ ...DEFAULTS.repo, id: 'widgets', name: 'widgets', path: main, settings: {} }], agentWorktree: { deps: [{ path: 'node_modules', lockfile: 'package-lock.json', install: ['npm', 'ci'] }], checks } } as Config;
  return { wt, calls, failing, aw: createAgentWorktrees({ config, run }) };
}

test('the check plan for a commit: each configured check on the changed files it covers, tests next to them, a failure keeps its last 40 lines', async (t) => {
  const { aw, wt, calls, failing } = fixture(t);
  failing.add('oxfmt');
  const seen: VerifyRun[] = [];
  const run = await verifyCommit(aw, wt, COMMIT, (r) => void seen.push(r));
  assert.deepEqual(calls, ['bin/lint src/a.ts src/b.ts', 'oxfmt --check src/a.ts src/b.ts', 'npm run check-ts', 'node --test src/a.test.ts']);
  assert.equal(run.status, 'fail');
  assert.deepEqual(run.checks.map((c) => [c.name, c.ok, c.skipped ? 'skipped' : '']), [['Lint', true, ''], ['Format', false, ''], ['Types', true, ''], ['Tests', true, ''], ['Styles', true, 'skipped']]);
  const lines = run.checks[1].tail!.split('\n');
  assert.equal(lines.length, 40);
  assert.equal(lines.at(-1), 'line 100');
  assert.ok(run.finishedAt);
  assert.equal(seen[0].status, 'running');
  assert.ok(seen.some((r) => r.status === 'running' && r.checks.length === 2), 'chips appear as checks finish');
  assert.ok(run.checks.every((c) => typeof c.ms === 'number'));
});

test('a worktree without usable node_modules reports deps-pending and runs nothing, even when its lockfile differs: no install on its own', async (t) => {
  const differs = fixture(t, { lock: '2' });
  const a = await verifyCommit(differs.aw, differs.wt, COMMIT, () => {});
  assert.equal(a.status, 'deps-pending');
  assert.match(a.note ?? '', /node_modules/);
  assert.deepEqual(differs.calls, [], 'no install, no check');
  assert.equal(reusable(a, false), false, 'tried again on the next click');

  const bare = fixture(t, { mainModules: false });
  const b = await verifyCommit(bare.aw, bare.wt, COMMIT, () => {});
  assert.equal(b.status, 'deps-pending');
  assert.match(b.note ?? '', /main checkout/);
  assert.deepEqual(bare.calls, []);
});

test('a worktree with identical lockfile is linked from the main checkout and checked', async (t) => {
  const { aw, wt, calls } = fixture(t);
  const run = await verifyCommit(aw, wt, COMMIT, () => {});
  assert.equal(run.status, 'pass');
  assert.equal(fs.readlinkSync(path.join(wt, 'node_modules')), path.join(path.dirname(wt), 'main/node_modules'));
  assert.equal(calls.length, 4);
});

test('only finished runs and a run still in flight are reused', () => {
  const run = (status: VerifyRun['status']): VerifyRun => ({ commit: COMMIT, startedAt: 'now', status, checks: [] });
  assert.equal(reusable(run('pass'), false), true);
  assert.equal(reusable(run('fail'), false), true);
  assert.equal(reusable(run('running'), true), true);
  assert.equal(reusable(run('running'), false), false, 'a run cut short by a restart starts over');
  assert.equal(reusable(run('deps-pending'), false), false);
  assert.equal(reusable(undefined, false), false);
});
