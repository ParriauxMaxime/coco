import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createWorktrees } from './worktrees.ts';
import type { Exec } from './placement.ts';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();

// a real clone with a bare origin: a pushed row, a merged row whose remote branch is gone, a dirty planned row, a side workspace, the plan root
function scene() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-wt-')));
  const clone = path.join(root, 'widgets');
  execFileSync('git', ['init', '--bare', '-b', 'main', path.join(root, 'origin.git')]);
  execFileSync('git', ['init', '-b', 'main', clone]);
  git(clone, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
  git(clone, 'commit', '--allow-empty', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  const at = (name: string) => path.join(root, name);
  const branch = (name: string, b: string) => {
    git(clone, 'worktree', 'add', '-q', '-b', b, at(name), 'main');
    git(at(name), 'commit', '--allow-empty', '-m', b);
    return git(at(name), 'rev-parse', 'HEAD');
  };
  branch('pushed', 'feat/pushed');
  git(at('pushed'), 'push', '-q', 'origin', 'feat/pushed');
  const mergedOid = branch('merged', 'feat/merged');
  branch('dirty', 'feat/dirty');
  fs.writeFileSync(path.join(at('dirty'), 'notes.txt'), 'wip');
  branch('side', 'fix/side');
  git(clone, 'worktree', 'add', '-q', '--detach', at('plan'), 'main');
  const repo: RepoConfig = { id: 'widgets', name: 'widgets', path: clone, github: 'acme/widgets', defaultBranch: 'main', tsconfig: '', rules: [], reviewsDir: '', commitConvention: '', settings: {} };
  const work: Work = { slug: 'inv', title: 'Invoices', projectId: 'prj_w', stack: [{ number: 7 }, { number: 8 }, { number: null, planned: { title: 'Email the CSV', branch: 'feat/dirty' } }, { number: 9 }] };
  const prs: Record<number, { title: string; head: string; headOid?: string }> = { 7: { title: 'Export', head: 'feat/pushed' }, 8: { title: 'Totals', head: 'feat/merged', headOid: mergedOid }, 9: { title: 'No worktree', head: 'feat/none' } };
  const workspaces = [
    { id: 'wks_plan', projectId: 'prj_w', workspaceDirectory: at('plan') },
    { id: 'wks_pushed', projectId: 'prj_w', workspaceDirectory: at('pushed') },
    { id: 'wks_side', projectId: 'prj_w', workspaceDirectory: at('side') },
    { id: 'wks_clone', projectId: 'prj_repo', workspaceDirectory: clone },
  ];
  const paseo: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'paseo') {
      paseo.push(args);
      if (args[0] === 'project') return { ok: true, stdout: JSON.stringify([{ projectId: 'prj_w', name: 'Invoices', path: at('plan') }]), stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    }
    return new Promise((resolve) => execFile(cmd, args, { env: ENV }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })));
  };
  const store = new Map([[work.slug, work]]);
  const data = path.join(root, 'data');
  const wt = createWorktrees({ DATA: data, exec, listWorkspaces: async () => workspaces, works: { get: (s) => store.get(s) || null, prInfo: async (n) => prs[n] }, repoFor: () => repo });
  return { wt, at, clone, work, store, paseo, data };
}

test('lists a work’s worktrees with their state, the clone and the project root left out', async () => {
  const { wt, at } = scene();
  const list = await wt.list('inv');
  const by = Object.fromEntries(list.map((w) => [path.basename(w.path), w]));
  assert.deepEqual(Object.keys(by).sort(), ['dirty', 'merged', 'pushed', 'side']);
  assert.deepEqual([by.pushed.title, by.pushed.branch, by.pushed.key, by.pushed.workspaceIds, by.pushed.dirty, by.pushed.unpushed], ['Export', 'feat/pushed', '7', ['wks_pushed'], 0, 0]);
  assert.equal(by.merged.unpushed, 0, 'commits at the PR head are pushed even once the remote branch is deleted');
  assert.deepEqual([by.dirty.title, by.dirty.key, by.dirty.dirty, by.dirty.unpushed], ['Email the CSV', 'b:feat:dirty', 1, 1]);
  assert.deepEqual([by.side.branch, by.side.key, by.side.workspaceIds, by.side.unpushed], ['fix/side', null, ['wks_side'], 1]);
  assert.ok(!list.some((w) => w.path === at('plan')));
});

test('removes only the ticked worktrees of the work, never forced, and archives the workspace of each one removed', async () => {
  const { wt, at, clone, paseo } = scene();
  const r = await wt.remove('inv', [at('pushed'), at('dirty'), clone]);
  assert.deepEqual(r.removed, [at('pushed')]);
  assert.deepEqual(r.kept.map((k) => k.path), [at('dirty'), clone]);
  assert.match(r.kept[0].why, /untracked|modified/);
  assert.ok(!fs.existsSync(at('pushed')));
  assert.ok(fs.existsSync(path.join(at('dirty'), 'notes.txt')));
  assert.ok(fs.existsSync(at('merged')));
  assert.deepEqual(paseo.filter((a) => a[1] === 'archive'), [['workspace', 'archive', 'wks_pushed']]);
  assert.equal(git(clone, 'rev-parse', '--verify', 'feat/pushed').length, 40, 'the branch stays');
});

test('auto-archive leaves a notice, shown while the work stays archived, dismissed on its own once a removal goes through', async () => {
  const { wt, at, work, store } = scene();
  const notice = await wt.noticeArchived(work);
  assert.equal(notice?.count, 4);
  assert.deepEqual(wt.notices(), [], 'not archived: not shown');
  store.set('inv', { ...work, archived: { at: '2026-10-26', reason: 'auto' } });
  assert.deepEqual(wt.notices().map((n) => n.slug), ['inv']);
  const sent: unknown[] = [];
  const send = (_res: unknown, _code: number, body: unknown) => void sent.push(body);
  const req = { method: 'POST' } as Parameters<typeof wt.handle>[0];
  await wt.handle(req, {} as Parameters<typeof wt.handle>[1], ['works', 'inv', 'worktrees', 'remove'], async () => JSON.stringify({ paths: [at('merged')] }), send);
  assert.deepEqual((sent[0] as { removed: string[] }).removed, [at('merged')]);
  assert.deepEqual(wt.notices(), []);
});
