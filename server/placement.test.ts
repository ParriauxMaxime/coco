import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlacement } from './placement.ts';
import type { Exec } from './placement.ts';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

const repo = (id: string, p: string): RepoConfig => ({ id, name: id, path: p, github: `acme/${id}`, defaultBranch: 'main', tsconfig: '', rules: [], reviewsDir: '', commitConvention: '', settings: {} });
const REPOS = [repo('widgets', '/src/widgets'), repo('cocopilot', '/apps/coco')];
type Ws = { id: string; projectId?: string; workspaceDirectory?: string };

// a pretend Paseo + git: projects, workspaces and worktrees the calls read and create
function world({ projects = [] as { projectId: string; name: string; path: string }[], workspaces = [] as Ws[], worktrees = '' } = {}) {
  const calls: string[][] = [];
  let n = 0;
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (v: unknown) => ({ ok: true, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    if (cmd === 'git' && args.includes('worktree') && args.includes('list')) return ok(worktrees);
    if (cmd === 'git') return ok('');
    if (args[0] === 'project' && args[1] === 'ls') return ok(projects);
    if (args[0] === 'project' && args[1] === 'create') {
      const p = { projectId: `prj_${++n}`, name: path.basename(args[2]), path: args[2] };
      projects.push(p);
      return ok(p);
    }
    if (args[0] === 'project' && args[1] === 'rename') return ok('');
    if (args[0] === 'workspace' && args[1] === 'create') {
      const cwd = flag(args, '--isolation') === 'local' ? flag(args, '--path') : `/wt/${flag(args, '--title')}`;
      const w = { id: `wks_${++n}`, projectId: flag(args, '--project'), workspaceDirectory: cwd };
      workspaces.push(w);
      return ok({ workspaceId: w.id, cwd });
    }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  return { calls, exec, listWorkspaces: async () => workspaces, projects, workspaces };
}
function store(list: Work[]) {
  const map = new Map(list.map((w) => [w.slug, w]));
  return { get: (s: string) => map.get(s) || null, save: (w: Work) => map.set(w.slug, w), prInfo: async (n: number) => ({ title: `PR title ${n}`, head: `feat/pr-${n}` }), map };
}
const DATA = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coco-place-'));

test('project names follow work titles; the repo project and matching names are left alone', async () => {
  const w = world({ projects: [{ projectId: 'prj_repo', name: 'widgets', path: '/src/widgets' }, { projectId: 'prj_inv', name: 'invoices_csv', path: '/wt/invoices-plan' }, { projectId: 'prj_same', name: 'Billing', path: '/wt/billing-plan' }] });
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: DATA(), exec: w.exec });
  const renames = await p.syncProjectNames([{ slug: 'inv', title: 'Invoice CSV export', projectId: 'prj_inv', stack: [] }, { slug: 'bill', title: 'Billing', projectId: 'prj_same', stack: [] }, { slug: 'fix', title: 'Small fix', projectId: 'prj_repo', stack: [] }]);
  assert.deepEqual(renames.map((r) => [r.slug, r.skipped || null]), [['inv', null], ['fix', 'the repo’s own project']]);
  assert.deepEqual(w.calls.filter((a) => a[2] === 'rename'), [['paseo', 'project', 'rename', 'prj_inv', 'Invoice CSV export']]);
  await p.syncProjectNames([{ slug: 'inv', title: 'Other', projectId: 'prj_inv', stack: [] }], { dryRun: true });
  assert.equal(w.calls.filter((a) => a[2] === 'rename').length, 1);
});

test('global runs in the coco repo project, in a workspace titled cocopilot, made once', async () => {
  const w = world();
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: DATA(), exec: w.exec, listWorkspaces: w.listWorkspaces });
  const first = await p.place({ kind: 'global' });
  assert.equal(first.cwd, '/apps/coco');
  assert.deepEqual(await p.place({ kind: 'global' }), first);
  assert.equal(w.calls.filter((a) => a[2] === 'create').length, 2);
  assert.ok(w.calls.some((a) => a.includes('--title') && a.includes('cocopilot')));
});

test('a work reuses its project root workspace; read-only row agents land there too', async () => {
  const w = world({ projects: [{ projectId: 'prj_w', name: 'Invoices', path: '/wt/plan' }], workspaces: [{ id: 'wks_plan', projectId: 'prj_w', workspaceDirectory: '/wt/plan' }] });
  const works = store([{ slug: 'inv', title: 'Invoices', projectId: 'prj_w', stack: [{ number: 7 }] }]);
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: DATA(), exec: w.exec, listWorkspaces: w.listWorkspaces, works });
  assert.deepEqual(await p.place({ kind: 'work', slug: 'inv' }), { workspaceId: 'wks_plan', cwd: '/wt/plan' });
  assert.deepEqual(await p.place({ kind: 'row', slug: 'inv', key: 7, edits: false }), { workspaceId: 'wks_plan', cwd: '/wt/plan' });
  assert.equal(w.calls.filter((a) => a[1] === 'workspace').length, 0);
});

test('a work without a project gets a plan worktree, a project named after it, and keeps the id', async () => {
  const w = world();
  const works = store([{ slug: 'inv', title: 'Invoice CSV export', repo: 'widgets', stack: [] }]);
  const data = DATA();
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: data, exec: w.exec, listWorkspaces: w.listWorkspaces, works });
  const placed = await p.place({ kind: 'work', slug: 'inv' });
  const dir = path.join(data, 'worktrees', 'widgets', 'inv');
  assert.equal(placed.cwd, dir);
  assert.ok(w.calls.some((a) => a[0] === 'git' && a.includes('add') && a.includes(dir)));
  assert.ok(w.calls.some((a) => a[2] === 'rename' && a[4] === 'Invoice CSV export'));
  assert.equal(works.map.get('inv')?.projectId, 'prj_1');
});

test('an editing row agent adopts a worktree already on its branch, titled after the PR, and remembers it', async () => {
  const w = world({ projects: [{ projectId: 'prj_w', name: 'Invoices', path: '/wt/plan' }], worktrees: 'worktree /src/widgets\nbranch refs/heads/main\n\nworktree /old/pr-7\nbranch refs/heads/feat/pr-7\n' });
  const works = store([{ slug: 'inv', title: 'Invoices', projectId: 'prj_w', stack: [{ number: 7 }] }]);
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: DATA(), exec: w.exec, listWorkspaces: w.listWorkspaces, works });
  const placed = await p.place({ kind: 'row', slug: 'inv', key: 7, edits: true });
  assert.equal(placed.cwd, '/old/pr-7');
  const create = w.calls.find((a) => a[2] === 'create' && a[1] === 'workspace') || [];
  assert.deepEqual([create[create.indexOf('--isolation') + 1], create[create.indexOf('--project') + 1], create[create.indexOf('--title') + 1]], ['local', 'prj_w', 'PR title 7']);
  assert.equal(works.map.get('inv')?.stack[0].workspaceId, placed.workspaceId);
  assert.deepEqual(await p.place({ kind: 'row', slug: 'inv', key: 7, edits: true }), placed);
});

test('an editing agent on a planned row branches off the previous row, in the work project', async () => {
  const w = world({ projects: [{ projectId: 'prj_w', name: 'Invoices', path: '/wt/plan' }] });
  const works = store([{ slug: 'inv', title: 'Invoices', projectId: 'prj_w', stack: [{ number: null, planned: { title: 'Export', branch: 'feat/export' } }, { number: null, planned: { title: 'Email the CSV', branch: 'feat/email' } }] }]);
  const p = createPlacement({ repos: REPOS, APP: '/apps/coco', DATA: DATA(), exec: w.exec, listWorkspaces: w.listWorkspaces, works });
  await p.place({ kind: 'row', slug: 'inv', key: 'b:feat:email', edits: true });
  const create = w.calls.find((a) => a[2] === 'create' && a[1] === 'workspace') || [];
  const at = (f: string) => create[create.indexOf(f) + 1];
  assert.deepEqual([at('--mode'), at('--new-branch'), at('--base'), at('--project'), at('--title')], ['branch-off', 'feat/email', 'feat/export', 'prj_w', 'Email the CSV']);
});
