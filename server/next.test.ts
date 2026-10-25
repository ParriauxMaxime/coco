import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNext } from './next.ts';

const now = new Date('2026-10-23T10:00:00Z');

test('validateNext keeps summary, typed blocks and the author, and stamps the time', () => {
  const next = validateNext({ summary: ' Review #14859 ', blocks: [{ type: 'steps', title: 'Today', items: ['Review #14859', 'Merge it'] }], by: 'plan session' }, now);
  assert.deepEqual(next, {
    summary: 'Review #14859',
    blocks: [{ type: 'steps', title: 'Today', items: ['Review #14859', 'Merge it'] }],
    at: '2026-10-23T10:00:00.000Z',
    by: 'plan session',
  });
});

test('validateNext clears on null and refuses an empty or malformed value', () => {
  assert.equal(validateNext(null), null);
  assert.throws(() => validateNext({}), /summary or blocks/);
  assert.throws(() => validateNext([]), /object or null/);
  assert.throws(() => validateNext({ blocks: [{ type: 'poem', text: 'x' }] }), /blocks\[0\]\.type/);
});
