import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement } from './placement.ts';
import type { Exec } from './placement.ts';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

const REPO: RepoConfig = { id: 'widgets', name: 'widgets', path: '/src/widgets', github: 'acme/widgets', defaultBranch: 'main', tsconfig: '', rules: [], reviewsDir: '', commitConvention: '', settings: {} };
const PROJECTS = [
  { projectId: 'prj_repo', name: 'widgets', path: '/src/widgets' },
  { projectId: 'prj_inv', name: 'invoices_csv', path: '/wt/invoices-plan' },
  { projectId: 'prj_same', name: 'Billing', path: '/wt/billing-plan' },
];
const fakeExec = (calls: string[][]): Exec => async (cmd, args) => {
  calls.push(args);
  return { ok: true, stdout: args[0] === 'project' && args[1] === 'ls' ? JSON.stringify(PROJECTS) : '', stderr: '' };
};
const work = (slug: string, title: string, projectId: string): Work => ({ slug, title, projectId, stack: [] });

test('project names follow work titles; the repo project and matching names are left alone', async () => {
  const calls: string[][] = [];
  const p = createPlacement({ repos: [REPO], exec: fakeExec(calls) });
  const renames = await p.syncProjectNames([work('inv', 'Invoice CSV export', 'prj_inv'), work('bill', 'Billing', 'prj_same'), work('fix', 'Small fix', 'prj_repo')]);
  assert.deepEqual(renames.map((r) => [r.slug, r.to, r.skipped || null]), [['inv', 'Invoice CSV export', null], ['fix', 'Small fix', 'the repo’s own project']]);
  assert.deepEqual(calls.filter((a) => a[1] === 'rename'), [['project', 'rename', 'prj_inv', 'Invoice CSV export']]);
});

test('a dry run renames nothing', async () => {
  const calls: string[][] = [];
  await createPlacement({ repos: [REPO], exec: fakeExec(calls) }).syncProjectNames([work('inv', 'Invoice CSV export', 'prj_inv')], { dryRun: true });
  assert.equal(calls.filter((a) => a[1] === 'rename').length, 0);
});
