import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrief, renderHandoff } from './briefs.mjs';
import { DEFAULTS } from './config.mjs';

const config = { ...DEFAULTS, personasDir: '/personas', repo: { ...DEFAULTS.repo, defaultBranch: 'main' } };

const work = {
  slug: 'w',
  title: 'Export invoices as CSV',
  notes: '## Rules\n- No ternaries in server code.\n\n## Do not revisit\n- CSV only for v1.\n\n## Precedents\n- #101 payouts export, abc123def456',
  decisions: [
    { id: 'a', title: 'D1', status: 'taken', choice: 'y', options: [{ key: 'y', label: 'Yes' }], pr: 2 },
    { id: 'b', title: 'D2', status: 'taken', choice: 'n', options: [{ key: 'n', label: 'No' }], pr: 1 },
    { id: 'c', title: 'D3', status: 'pending', options: [] },
  ],
  stack: [{ number: 1, planned: { title: 'Export endpoint', branch: 'feat/a' } }, { number: 2, planned: { title: 'Export button', scope: 'Add the Export CSV button', branch: 'feat/b' }, personas: ['bob'], kit: { video: false } }],
};
const pr = { head: 'feat/b', base: 'feat/a', sha: 'abc' };

test('a brief keeps the decisions of its own PR, drops empty sections and follows the row kit', () => {
  const text = renderBrief({ work, index: 1, pr, worktree: null, rules: [{ text: 'TL;DR collapsed in PR bodies.' }], config });
  assert.match(text, /- D1: Yes/);
  assert.doesNotMatch(text, /D2|D3/);
  assert.match(text, /- CSV only for v1\./);
  assert.match(text, /TL;DR collapsed in PR bodies\.\n- No ternaries in server code\./);
  assert.match(text, /git show abc123def456\ngh pr view 101/);
  assert.match(text, /No demo video for this PR\./);
  assert.doesNotMatch(text, /## What the work changes/);
  assert.match(text, /`\/personas\/bob\.md`/);
  assert.match(text, /Read `AGENTS\.md` and `CLAUDE\.md`, then follow/);
  assert.match(text, new RegExp(`curl -s -X POST ${DEFAULTS.baseUrl}/api/works/w/artifacts`));
});

test('a kit kind beyond body, diagram and video is expected when a work link names it', () => {
  const docs = { ...work, links: [{ label: 'Docs companion', url: 'https://github.com/acme/docs/pull/7' }] };
  const kinds = { ...config, kitKinds: ['body', 'diagram', 'video', 'docs'] };
  assert.match(renderBrief({ work: docs, index: 1, pr, worktree: null, config: kinds }), /Docs companion PR updated/);
  assert.doesNotMatch(renderBrief({ work, index: 1, pr, worktree: null, config: kinds }), /companion PR/);
});

test('a handoff puts the branch state and the rebase onto the fork point above the brief', () => {
  const state = { at: '2026-10-21T10:00:00Z', tip: 't1', remote: 't0', baseRef: 'feat/a', baseTip: 'b1', fork: 'f0', log: ['t1 fix'], dirty: [], comments: [], decisions: [], worktree: '/wt' };
  const text = renderHandoff({ brief: '# brief', pr, agentId: '0e56e1a3-x', state });
  assert.match(text, /local commits not pushed/);
  assert.match(text, /git -C \/wt rebase --onto feat\/a f0 feat\/b/);
  assert.ok(text.trimEnd().endsWith('# brief'));
});
