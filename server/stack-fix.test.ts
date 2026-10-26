import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStackFix } from './stack-fix.ts';
import type { Work } from './core-types.ts';

const WT = '/wt/a';
const ME = 'e88d0ecc-0000-4000-8000-000000000000';

type TestComment = { id: string; status: 'open'; path: string; startLine: number; endLine: number; body: string };
type TestAgent = { id: string; cwd: string; status: string };

function setup({ agents = [], place }: { agents?: TestAgent[]; place?: (slug: string) => Promise<{ workspaceId: string; cwd: string }> } = {}) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-fix-'));
  const work: Work = { slug: 'w', title: 'W', stack: [{ number: 1 }, { number: 2 }] };
  const store: Record<string, TestComment[]> = {
    1: [
      { id: 'c1', status: 'open', path: 'a.ts', startLine: 1, endLine: 1, body: 'Rename x' },
      { id: 'c2', status: 'open', path: 'a.ts', startLine: 5, endLine: 5, body: 'Guard y' },
    ],
    2: [{ id: 'c3', status: 'open', path: 'b.ts', startLine: 2, endLine: 2, body: 'Edit the PR body' }],
  };
  const wdir = path.join(DATA, 'works', 'w');
  fs.mkdirSync(path.join(wdir, 'threads'), { recursive: true });
  fs.writeFileSync(path.join(wdir, 'findings.json'), JSON.stringify({
    k1: { status: 'accepted', at: 't', commentId: 'c1' },
    k2: { status: 'dismissed', at: 't', reason: 'not ours', commentId: 'c2' },
    k3: { status: 'accepted', at: 't', commentId: 'c3', reason: 'draft the line only' },
  }));
  fs.writeFileSync(path.join(wdir, 'threads', 'c.1.c1.json'), JSON.stringify({ key: 'c.1.c1', messages: [
    { role: 'user', text: 'Is this blocking?' },
    { role: 'agent', text: 'Not blocking, keep the name.' },
    { role: 'system', text: 'noise' },
    { role: 'user', text: 'Then no code change, record the decision.' },
    { role: 'agent', text: 'old twin', blocks: [{ type: 'text', text: 'Agreed: **no code change**, decision recorded.' }, { type: 'callout', tone: 'note', text: 'Follow-up ticket.' }] },
  ] }));
  const launched: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const sf = createStackFix({
    DATA,
    REPO: '/repo',
    config: { repo: { defaultBranch: 'master' }, owner: { name: 'max' }, models: { default: 'opus' } },
    works: { get: (s) => (s === 'w' ? work : null) },
    comments: { list: (_, key) => ({ comments: store[key] || [] }), update: async (_, key, id, patch) => updates.push({ key, id, ...patch }), reanchor: async () => ({}) },
    code: { ensureRefs: async () => ({ headSha: '', mergeBase: '' }) },
    reviewAgent: {
      trailersBetween: async () => [],
      rowPr: async (_, i) => ({ head: i ? 'b' : 'a', title: `row ${i}`, state: 'OPEN' }),
      branchSha: async (b) => `${b}-sha`,
      worktreeFor: async (b) => (b === 'a' ? WT : null),
      remoteHead: async () => null,
      agentsList: async () => agents,
      sameDir: (x, y) => x === y,
      personaChecks: () => null,
      launch: async (runner, opts) => (launched.push({ runner, ...opts }), 'agent-1'),
      timeline: () => {},
    },
    exec: async () => ({ ok: true, stdout: '', stderr: '' }),
    place,
  });
  return { sf, DATA, launched, updates };
}

test('the agent runs in the workspace placement gives the work, not in the first row worktree', async () => {
  const { sf, launched } = setup({ place: async (slug) => ({ workspaceId: `ws-${slug}`, cwd: '/plans/w' }) });
  const run = await sf.start('w', {});
  assert.deepEqual(launched[0].runner, { mode: 'workspace', workspaceId: 'ws-w', cwd: '/plans/w' });
  assert.equal(run.cwd, '/plans/w');
  const folder = setup();
  await folder.sf.start('w', {});
  assert.deepEqual(folder.launched[0].runner, { mode: 'cwd', cwd: WT });
});

test('select accepted sends only accepted open comments; the default still sends every open one', async () => {
  const a = setup();
  const run = await a.sf.start('w', { select: 'accepted' });
  assert.deepEqual(run.rows.map((r) => r.commentIds), [['c1'], ['c3']]);
  assert.equal(run.select, 'accepted');
  assert.deepEqual(a.updates.map((u) => u.id), ['c1', 'c3']);

  const b = setup();
  const all = await b.sf.start('w', {});
  assert.deepEqual(all.rows.map((r) => r.commentIds), [['c1', 'c2'], ['c3']]);
  assert.equal(all.select, 'all');
});

test('select by ids per row keeps the rows above for restacking', async () => {
  const { sf } = setup();
  const run = await sf.start('w', { select: { 1: ['c2'] } });
  assert.deepEqual(run.rows.map((r) => r.commentIds), [['c2'], []]);
  await assert.rejects(setup().sf.start('w', { select: { 1: ['nope'] } }), /none of the picked comments is open/);
  await assert.rejects(setup().sf.start('w', { select: ['c1'] }), /select must be/);
});

test('the brief carries the triage: board note, owner messages, last agent reply as markdown, and the GitHub-write rule', async () => {
  const { sf } = setup();
  const run = await sf.start('w', { select: 'accepted' });
  const brief = fs.readFileSync(run.briefPath, 'utf8');
  assert.match(brief, /> Is this blocking\?/);
  assert.match(brief, /> Then no code change, record the decision\./);
  assert.match(brief, /Last agent reply in the thread:\n\n> Agreed: \*\*no code change\*\*, decision recorded\.\n>\n> > \*\*note:\*\* Follow-up ticket\./);
  assert.doesNotMatch(brief, /noise|old twin|keep the name/);
  assert.match(brief, /Note: draft the line only/);
  assert.match(brief, /follow it over the comment's own recommendation/);
  assert.match(brief, /needs a GitHub write .* is declined: put the drafted text in the note/);
});

test('an agent running in a row worktree blocks the run unless it requested it', async () => {
  const agents = [{ id: ME, cwd: WT, status: 'running' }];
  await assert.rejects(setup({ agents }).sf.start('w', {}), /agent e88d0ecc is running in \/wt\/a/);
  const run = await setup({ agents }).sf.start('w', { requestedBy: ME });
  assert.equal(run.status, 'running');
  await assert.rejects(setup({ agents: [...agents, { id: 'other', cwd: WT, status: 'running' }] }).sf.start('w', { requestedBy: ME }), /agent other is running/);
});

test('ingest counts accepted open comments per row', async () => {
  const { sf } = setup();
  const { open } = await sf.ingest('w');
  assert.deepEqual(open, [{ key: 1, count: 2, accepted: 1 }, { key: 2, count: 1, accepted: 1 }]);
});
