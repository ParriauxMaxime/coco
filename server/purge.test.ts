import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPurge, recommend } from './purge.ts';
import type { AgentFacts, WorktreeFacts, WorkspaceFacts } from './purge.ts';
import type { AgentSnapshot } from './permissions.ts';

const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
const agent = (f: Partial<AgentFacts>): AgentFacts => ({ kind: 'agent', status: 'idle', pending: 0, activityAt: at(1), helper: null, self: false, work: null, pr: null, ...f });
const tree = (f: Partial<WorktreeFacts>): WorktreeFacts => ({ kind: 'worktree', main: false, self: false, dirty: 0, unpushed: 0, liveAgents: 0, work: null, pr: null, onRemote: true, activityAt: at(48), ...f });
const space = (f: Partial<WorkspaceFacts>): WorkspaceFacts => ({ kind: 'workspace', dirExists: true, agents: 0, liveAgents: 0, duplicate: false, ...f });
const verdict = (f: Parameters<typeof recommend>[0]) => {
  const v = recommend(f, NOW);
  return `${v.recommendation}: ${v.reason}`;
};
const live = { slug: 'inv', title: 'Invoices', archived: false };
const merged = { number: 8, state: 'MERGED', label: '#8' };

test('agents: kept while running, waiting, recent or coco itself; purged once stale, ended, or their work or PR is done', () => {
  assert.equal(verdict(agent({ status: 'running', activityAt: at(200) })), 'keep: running');
  assert.equal(verdict(agent({ pending: 2, activityAt: at(200) })), 'keep: waiting on you: 2 requests');
  assert.equal(verdict(agent({ self: true, status: 'closed', activityAt: at(200) })), 'keep: coco runs inside this agent');
  assert.equal(verdict(agent({ activityAt: at(5), work: { ...live, archived: true } })), 'keep: active 5h ago');
  assert.equal(verdict(agent({ helper: 'review-plan', activityAt: at(3) })), 'purge: one-shot review-plan helper, done 3h ago');
  assert.equal(verdict(agent({ activityAt: at(30), work: { ...live, archived: true } })), 'purge: its work “Invoices” is archived');
  assert.equal(verdict(agent({ activityAt: at(30), pr: merged })), 'purge: PR #8 merged');
  assert.equal(verdict(agent({ status: 'closed', activityAt: at(30) })), 'purge: session closed, last active 1d ago');
  assert.equal(verdict(agent({ status: 'error', activityAt: at(100) })), 'purge: error for 4d');
  assert.equal(verdict(agent({ activityAt: at(48) })), 'keep: idle 2d, recent');
});

test('worktrees: kept with local work, live agents or an open PR; purged once merged, archived, gone from origin or long idle', () => {
  assert.equal(verdict(tree({ main: true, dirty: 3 })), 'keep: main checkout');
  assert.equal(verdict(tree({ self: true, pr: merged })), 'keep: coco runs from here');
  assert.equal(verdict(tree({ dirty: 3, pr: merged })), 'keep: 3 uncommitted files');
  assert.equal(verdict(tree({ unpushed: 1, pr: merged })), 'keep: 1 unpushed commit');
  assert.equal(verdict(tree({ liveAgents: 2, pr: merged })), 'keep: 2 live agents here');
  assert.equal(verdict(tree({ work: live, pr: { number: 7, state: 'OPEN', label: '#7' }, activityAt: at(900) })), 'keep: PR #7 open in “Invoices”');
  assert.equal(verdict(tree({ work: live, pr: merged })), 'purge: PR #8 merged');
  assert.equal(verdict(tree({ work: { ...live, archived: true } })), 'purge: its work “Invoices” is archived');
  assert.equal(verdict(tree({ onRemote: false, activityAt: at(5) })), 'keep: active 5h ago');
  assert.equal(verdict(tree({ onRemote: false })), 'purge: branch gone from origin, no PR, nothing unpushed');
  assert.equal(verdict(tree({ activityAt: at(24 * 20) })), 'purge: no activity for 20d, in no live work');
  assert.equal(verdict(tree({ activityAt: at(24 * 5) })), 'keep: last active 5d ago');
  assert.equal(verdict(tree({ error: 'not a git repository' })), 'keep: git state unreadable: not a git repository');
});

test('workspaces: purged when their folder is gone or another workspace covers it, never with a live agent', () => {
  assert.equal(verdict(space({ dirExists: false, liveAgents: 1 })), 'keep: 1 live agent');
  assert.equal(verdict(space({ dirExists: false })), 'purge: its folder is gone');
  assert.equal(verdict(space({ duplicate: true, agents: 2 })), 'purge: another workspace covers this folder; its 2 agents are up for purge too');
  assert.equal(verdict(space({})), 'keep: the only workspace on this folder');
});

function scene() {
  const archived: string[] = [];
  const snaps: AgentSnapshot[] = [
    { id: 'busy', title: 'coco · Busy', status: 'running', updatedAt: at(100) },
    { id: 'old', title: 'Old', status: 'closed', updatedAt: at(100) },
    { id: 'me', title: 'Me', status: 'idle', updatedAt: at(100) },
  ];
  const purge = createPurge({
    APP: '/nowhere/app',
    exec: async () => ({ ok: false, stdout: '', stderr: 'no git here' }),
    client: async () => ({
      agents: { list: async () => ({ entries: snaps.map((agent) => ({ agent })) }), ref: (id: string) => ({ archive: async () => void archived.push(id) }) },
      workspaces: { archive: async (id: string) => (archived.push(id), { error: null }) },
    }),
    listWorkspaces: async () => [],
    repos: [],
    works: { list: () => [] },
    prInfo: async () => null,
    selfAgentId: 'me',
    now: () => NOW,
  });
  return { purge, archived };
}

test('POST re-checks each item: a kept one is refused unless forced, coco’s own agent always, a purge one goes', async () => {
  const { purge, archived } = scene();
  const results = await purge.perform([{ kind: 'agent', id: 'busy' }, { kind: 'agent', id: 'old' }, { kind: 'agent', id: 'me', force: true }, { kind: 'workspace', id: 'wks_gone' }]);
  assert.deepEqual(results.map((r) => [r.id, r.ok, r.error]), [
    ['busy', false, 'now recommended to keep: running'],
    ['old', true, undefined],
    ['me', false, 'never purged: coco runs inside this agent'],
    ['wks_gone', false, 'no longer listed'],
  ]);
  assert.deepEqual(archived, ['old']);
  const forced = await purge.perform([{ kind: 'agent', id: 'busy', force: true }]);
  assert.equal(forced[0].ok, true);
  assert.deepEqual(archived, ['old', 'busy']);
});
