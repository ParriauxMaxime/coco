import test from 'node:test';
import assert from 'node:assert/strict';
import { branchOf, currentKey, keyClash, keyLabel, parseKey, rowKey } from './stack.ts';
import { assertUniqueKeys } from './stack-replace.ts';
import { landedRow } from './landed.ts';
import type { StackRow } from './core-types.ts';

test('a row with a branch reads as that branch, a row that ships on the default branch as its planned order', () => {
  const stack: StackRow[] = [{ planned: { order: 3, branch: 'feat/x' } }, { planned: { order: 11 } }, { planned: { order: 14 } }, { number: 42, planned: { order: 1 } }];
  assert.deepEqual(stack.map(rowKey), ['b:feat:x', 'r:11', 'r:14', 42]);
  assert.deepEqual(stack.map((s) => keyLabel(rowKey(s))), ['feat/x', 'row 11', 'row 14', '#42']);
  assert.equal(keyClash(stack), null);
});

test('a row reads the same before and after it lands', () => {
  const planned = { planned: { order: 11 } };
  assert.equal(rowKey(planned), rowKey({ ...planned, landed: { sha: 'a648a58', at: '2026-10-29T13:02:50+01:00', by: 'agent' } }));
});

test('a stack where two rows share a key is refused, since one tab, one agent label and one finding would hold both', () => {
  const shared: StackRow[] = [{ planned: { order: 1, branch: 'main' } }, { planned: { order: 2, branch: 'main' } }];
  assert.equal(keyClash(shared), 'b:main');
  assert.throws(() => assertUniqueKeys(shared), /two rows read as main/);
  assert.doesNotThrow(() => assertUniqueKeys([{ planned: { order: 1 } }, { planned: { order: 2 } }]));
});

test('keys as agents write them: a number, #12, a branch, an order', () => {
  assert.equal(parseKey('#12'), 12);
  assert.equal(parseKey('12'), 12);
  assert.equal(parseKey('b:feat/x'), 'b:feat:x');
  assert.equal(parseKey('r:11'), 'r:11');
  assert.equal(parseKey('feat/x'), null);
  assert.equal(parseKey(''), null);
});

test('an order key names no branch, a branch key its branch', () => {
  assert.equal(branchOf('b:feat:x'), 'feat/x');
  assert.equal(branchOf('r:11'), '');
  assert.equal(branchOf(42), '');
});

test('a landed row is found by its order key, its order or its branch', () => {
  const stack: StackRow[] = [{ planned: { order: 11, title: 'Restart in about a second' } }, { planned: { order: 3, branch: 'feat/x' } }];
  assert.equal(landedRow(stack, 'r:11').planned?.order, 11);
  assert.equal(landedRow(stack, 11).planned?.order, 11);
  assert.equal(landedRow(stack, 'b:feat/x').planned?.order, 3);
  assert.equal(landedRow(stack, 'feat/x').planned?.order, 3);
  assert.throws(() => landedRow(stack, 'r:99'), /no row r:99/);
});

test('a branch key of a row that lost its branch reads as the row does today', () => {
  const work = { stack: [{ number: 42, planned: { branch: 'fix/a' } }, { planned: { order: 2 } }] as StackRow[] };
  assert.equal(currentKey(work, 'b:fix:a'), 42);
  assert.equal(currentKey(work, 'r:2'), 'r:2');
  assert.equal(currentKey(work, 'b:fix:c'), 'b:fix:c');
  assert.equal(currentKey(null, 7), 7);
});
