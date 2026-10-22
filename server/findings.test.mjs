import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimOf, confidenceOf, findingKey, githubSourceOf, reviewerOf, reviewSource, settle, severityOf } from './findings.mjs';

test('a finding dismissed once stays dismissed when the same reviewer raises it again on another line', () => {
  const first = findingKey('review-as:bob', 'a/b.ts', claimOf('### 1. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:100`'));
  const again = findingKey('review-as:bob', 'a/b.ts', claimOf('### 3. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:112`'));
  const other = findingKey('review-as:carol', 'a/b.ts', claimOf('### 3. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:112`'));
  assert.equal(first, again);
  assert.notEqual(first, other);
  const [row] = settle([{ key: again, path: 'a/b.ts', claim: 'Default true on the export flag' }], { ledger: { [first]: { status: 'dismissed', at: '2026-10-21', reason: 'decision 4' } } });
  assert.equal(row.status, 'dismissed');
  assert.equal(row.dismissed.reason, 'decision 4');
});

test('an accepted finding shows its comment status and the comment is not listed twice', () => {
  const comment = { id: 'c1', path: 'a/b.ts', startLine: 3, endLine: 3, body: 'Silent error for the customer, is that okay?', status: 'fixed', author: 'bob' };
  const rows = settle([{ key: 'k1', path: 'a/b.ts', claim: claimOf(comment.body) }], { comments: [comment] });
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.commentId]), [['k1', 'fixed', 'c1']]);
});

test("the owner's own comments are local, anyone else's are not", () => {
  const mine = { id: 'c1', path: 'a/b.ts', startLine: 1, endLine: 1, body: 'Rename this.', status: 'open', author: 'alice' };
  const theirs = { ...mine, id: 'c2', body: 'Split this.', author: 'bob' };
  const rows = settle([], { comments: [mine, theirs], me: 'alice' });
  assert.deepEqual(rows.map((r) => r.source), ['local', 'local:bob']);
});

test('claims and severities from both review page shapes', () => {
  assert.equal(claimOf('1. **Check 4 (silent failure)**, `x/y.js:2574`\n   > Silent error for the customer, is that okay?'), 'Check 4 (silent failure): Silent error for the customer, is that okay?');
  assert.equal(severityOf('**Non-blocking.** The export still downloads'), 'minor');
  assert.equal(severityOf('### 1. High · PR 2 · Gate skipped'), 'major');
  assert.equal(reviewSource('2026-10-16-review-as-bobsmith.md'), 'review-as:bobsmith');
  assert.equal(reviewSource('Review-bob', '# Review as Bob Smith (`bobsmith`): stack'), 'review-as:bobsmith');
  assert.equal(reviewSource('x.md', '# Review as carol42 (Carol), front-end only'), 'review-as:carol42');
  assert.equal(reviewSource('review-2026-10-14-151356.md', '# Local review'), 'review-local');
});

test('a review agent comment shows its claim, not its Class / Severity header, and its confidence', () => {
  const body = '**Class:** In-stack bug · **Severity:** major · **Confidence:** 80%\n**Recommendation:** Fix in #42.\n\n`handleExportError` retries the download only.';
  assert.equal(claimOf(body), '`handleExportError` retries the download only');
  assert.equal(confidenceOf(body), 80);
  assert.deepEqual([reviewerOf('review-as:bobsmith'), reviewerOf('local'), reviewerOf('local:opus-review'), reviewerOf('ci')].map((x) => x.group), ['personas', 'me', 'agents', 'ci']);
});

test('bot groups from config name their own reviewer group', () => {
  const bots = { tracker: 'errbot' };
  assert.equal(githubSourceOf('ErrBot-io[bot]', bots), 'tracker');
  assert.equal(githubSourceOf('helper[bot]', bots), 'bot:helper');
  assert.equal(githubSourceOf('bob', bots), 'github:bob');
  assert.equal(reviewerOf('tracker', bots).group, 'tracker');
  assert.equal(reviewerOf('tracker').group, 'agents');
});
