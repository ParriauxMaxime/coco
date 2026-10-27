import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSULT_CAP, consultPack, pastComments, pickPersona, pickRules } from './consult.ts';

const surfaces = (glob: string) => `# P\n\n\`\`\`yaml\nsurfaces:\n  - name: s\n    confidence: high\n    paths:\n      - ${glob}\n\`\`\`\n`;
const review = `# Reviews\n\n## What she checks\n\n1. Is every database call in a repository, never in a use case or service, because layers keep tests cheap?\n2. Does the permission rule live in a domain predicate that is synchronous and shared?\n3. Are constants and projections in a conf file next to the module?\n4. Does the migration have a rollback path documented in the pull request body?\n\n## Voice\n\n- Short remarks, lowercase, rarely explains the reason behind a request at all.\n`;

test('pickRules ranks by overlap with the question, then fills with the top rules', () => {
  const out = pickRules(review, new Set(['migration', 'rollback']), 3, 2);
  assert.match(out[0], /^Does the migration/);
  assert.match(out[1], /^Is every database call/);
  assert.equal(out.length, 3);
});

test('pastComments keeps quotes on similar paths, best path match first', () => {
  const json = { checks: [{ quotes: [['faut un repo', '#6022 coupon-management-use-case.ts:36 CHANGES'], ['useMutation', '#8407 front/hooks.ts:2'], ['toujours un repo', '#9166 coupon-use-case.ts:9']] }] };
  const out = pastComments(json, 'imports/coupon/server/coupon-management-use-case.ts', new Set());
  assert.equal(out.length, 2);
  assert.match(out[0], /#6022/);
  assert.deepEqual(pastComments(null, 'x.ts', new Set()), []);
});

test('pickPersona maps a path to its surface, else the first fallback', () => {
  const docs = { ann: surfaces('billing/**'), bob: surfaces('sequence/**') };
  assert.equal(pickPersona(docs, 'sequence/a.ts', ['ann']), 'bob');
  assert.equal(pickPersona(docs, 'other/a.ts', ['zed', 'ann']), 'ann');
  assert.equal(pickPersona(docs, undefined, []), null);
});

test('consultPack carries the rules, the instruction, and never exceeds the cap', () => {
  const pack = consultPack({ login: 'camille', question: 'should this database call move to a repository?', path: 'a/use-case.ts', owner: 'Max', review });
  assert.match(pack, /Is every database call/);
  assert.match(pack, /3 to 6 lines/);
  assert.match(pack, /recommended/);
  const long = `## Checks\n\n${Array.from({ length: 80 }, (_, i) => `- rule number ${i} about repository layers and database calls ${'x'.repeat(400)}`).join('\n')}`;
  const big = consultPack({ login: 'camille', question: 'repository database layers', owner: 'Max', review: long, authoring: long });
  assert.ok(big.length <= CONSULT_CAP, String(big.length));
  assert.match(big, /Do not start a persona review/);
});
