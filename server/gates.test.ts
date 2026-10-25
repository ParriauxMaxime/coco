import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive, gateState, gatesFor } from './gates.ts';

test('each configured kit kind gets its gate, with the skills the config maps to it', () => {
  const gates = gatesFor({ kitKinds: ['body', 'docs'], gateSkills: { 'kit-docs': ['docs-sync'] } });
  assert.deepEqual(gates.filter((g) => g.id.startsWith('kit-')).map((g) => [g.id, g.skills]), [['kit-body', []], ['kit-docs', ['docs-sync']]]);
});

test('gates derive from GitHub and git, and a tick or skip from the user wins over them', () => {
  const pr = { number: 7, state: 'OPEN', isDraft: true };
  assert.equal(derive('push', { pr, tip: 'a', remote: 'a' }), true);
  assert.equal(derive('push', { pr, tip: 'b', remote: 'a' }), false);
  assert.equal(derive('ready', { pr }), false);
  assert.equal(derive('merged', { pr: { ...pr, state: 'MERGED' } }), true);
  assert.equal(derive('kit-body', { pr, body: '<details><summary>TL;DR</summary>…</details>' }), true);
  const kitBody = { maxChars: 40, mustMatch: 'TL;DR' };
  assert.equal(derive('kit-body', { pr, body: 'no summary', kitBody }), false);
  assert.equal(derive('kit-body', { pr, body: `TL;DR ${'x'.repeat(40)}`, kitBody }), false);
  assert.equal(derive('kit-diagram', { pr, body: 'no diagram' }), false);
  assert.equal(derive('review-pr', { pr, tip: 'a', plan: { headSha: 'a' } }), true);
  assert.equal(derive('review-pr', { pr, tip: 'b', plan: { headSha: 'a' } }), false);
  assert.equal(derive('manual-test', { pr }), null);
  assert.equal(gateState({ state: 'skipped', reason: 'no UI' }, false), 'skipped');
  assert.equal(gateState(undefined, true), 'done');
  assert.equal(gateState(undefined, false), 'todo');
});
