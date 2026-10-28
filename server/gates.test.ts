import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, detail, gateState, gatesFor, skillRuns } from './gates.ts';

test('the milestones run in order, self-reviewed carrying the self-review and review-pr skills', () => {
  const gates = gatesFor({ gateSkills: { 'self-review': ['simplify'], 'review-pr': ['code-review'] } });
  assert.deepEqual(gates.map((g) => g.id), ['self-review', 'kit', 'pushed', 'ready', 'approved', 'merged']);
  assert.deepEqual(gates[0].skills, ['simplify', 'code-review']);
});

test('skill runs list every configured gate skill, one per kit kind, none for a key with no skill', () => {
  const runs = skillRuns({ kitKinds: ['body', 'docs'], gateSkills: { history: ['commit'], 'kit-docs': ['docs-sync'], 'kit-body': [] } });
  assert.deepEqual(runs.map((r) => [r.id, r.label, r.skills]), [['history', 'tidy history', ['commit']], ['kit-docs', 'kit: docs', ['docs-sync']]]);
});

test('self-reviewed needs a review at the head and no open finding', () => {
  assert.equal(derive('self-review', { reviewed: true, openFindings: 0 }), true);
  assert.equal(derive('self-review', { reviewed: true, openFindings: 2 }), false);
  assert.equal(detail('self-review', { reviewed: true, openFindings: 2 }), '2 open findings');
  assert.equal(detail('self-review', { reviewed: false }), 'no review at this head');
  assert.equal(derive('self-review', {}), null);
});

test('kit counts the pieces in scope, fresh or present, and the body rules', () => {
  const kit = [{ id: 'body', state: 'fresh' }, { id: 'video', state: 'stale' }];
  assert.equal(derive('kit', { kit }), false);
  assert.equal(detail('kit', { kit }), 'video stale');
  assert.equal(derive('kit', { kit: [{ id: 'body', state: 'present' }] }), true);
  const kitBody = { maxChars: 40, mustMatch: 'TL;DR' };
  assert.equal(derive('kit', { kit: [{ id: 'body', state: 'fresh' }], body: 'no summary', kitBody }), false);
  assert.equal(derive('kit', { kit: null }), null);
});

test('pushed, ready, approved and merged read git and GitHub', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: true };
  assert.equal(derive('pushed', { tip: 'abc1234', remote: 'abc1234def' }), true);
  assert.equal(derive('pushed', { tip: 'b', remote: 'a' }), false);
  assert.equal(derive('pushed', { tip: null, remote: 'a' }), true);
  assert.equal(derive('pushed', { tip: 'a' }), null);
  assert.equal(derive('ready', { pr }), false);
  assert.equal(derive('approved', { pr: { ...pr, reviewDecision: 'APPROVED', unresolvedThreads: 2 } }), false);
  assert.equal(detail('approved', { pr: { ...pr, reviewDecision: 'APPROVED', unresolvedThreads: 2 } }), '2 threads');
  assert.equal(derive('approved', { pr: { ...pr, reviewDecision: 'APPROVED', unresolvedThreads: 0 } }), true);
  assert.equal(derive('merged', { pr: { ...pr, state: 'MERGED' } }), true);
});

test("the owner's tick or skip wins; a finished skill run is a fact, not a tick", () => {
  assert.equal(gateState({ state: 'skipped', reason: 'no UI' }, false), 'skipped');
  assert.equal(gateState({ state: 'done', skill: 'simplify', sha: 'a' }, false), 'todo');
  assert.equal(gateState({ state: 'running', skill: 'simplify' }, false), 'running');
  assert.equal(gateState(undefined, true), 'done');
});
