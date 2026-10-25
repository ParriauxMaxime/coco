import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptOf, seedOf } from './rules.ts';

test('seed rules from config start kept, malformed entries are skipped', () => {
  const seeded = seedOf([['Keep PR bodies short.', 'team notes'], ['  '], 'not a pair']);
  assert.deepEqual(seeded.map((r) => [r.text, r.source, r.status]), [['Keep PR bodies short.', 'team notes', 'kept']]);
  assert.deepEqual(seedOf(undefined), []);
});

test('briefs and review plans get the kept rules only, global first, then work, then the PR row', () => {
  const global = [{ text: 'g1', status: 'kept' }, { text: 'g2', status: 'retired' }];
  const work = { rules: [{ text: 'w1', status: 'proposed' }, { text: 'w2', status: 'kept' }], stack: [{ rules: [{ text: 'p0', status: 'kept' }] }, { rules: [{ text: 'p1', status: 'kept' }] }] };
  assert.deepEqual(keptOf(global, work, 1).map((r) => `${r.scope}:${r.text}`), ['global:g1', 'work:w2', 'pr:p1']);
  assert.deepEqual(keptOf(global, { stack: [] }, -1).map((r) => r.text), ['g1']);
});
