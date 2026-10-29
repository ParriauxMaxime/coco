import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPath, columnsShown, fitMode, navSegment, openAt, parseNavSegment } from './nav.ts';

test('a path round-trips through its hash segment, keys with ~, : or / included', () => {
  const path = ['12', 'f:abc/def', 'x~y'];
  const seg = navSegment(path);
  assert.ok(seg.startsWith('n-'));
  assert.equal(seg.split('/').length, 1);
  assert.deepEqual(parseNavSegment(seg), path);
  assert.equal(navSegment([]), '');
  assert.deepEqual(parseNavSegment(undefined), []);
  assert.deepEqual(parseNavSegment('max'), []);
});

test('a mode too wide for the surface opens as Drill; Classic and Drill always fit', () => {
  assert.equal(fitMode('columns', 1200), 'columns');
  assert.equal(fitMode('columns', 390), 'drill');
  assert.equal(fitMode('expand', 390), 'expand');
  assert.equal(fitMode('expand', 256), 'expand');
  assert.equal(fitMode('expand', 200), 'drill');
  assert.equal(fitMode('drill', 100), 'drill');
  assert.equal(fitMode('classic', 100), 'classic');
});

test('Columns shows the deepest levels that fit, at least one', () => {
  assert.equal(columnsShown(3, 1200), 3);
  assert.equal(columnsShown(3, 700), 2);
  assert.equal(columnsShown(3, 200), 1);
  assert.equal(columnsShown(1, 1200), 1);
});

test('opening an item closes what was open below its level; opening it again with toggle closes it', () => {
  assert.deepEqual(openAt(['a', 'b', 'c'], 1, 'x'), ['a', 'x']);
  assert.deepEqual(openAt([], 0, 'a'), ['a']);
  assert.deepEqual(openAt(['a', 'b'], 1, 'b', true), ['a']);
  assert.deepEqual(openAt(['a', 'b'], 1, 'b'), ['a', 'b']);
});

test('a stale path keeps the levels that still exist', () => {
  const known = [['a', 'b'], ['x']];
  assert.deepEqual(clampPath(['a', 'x', 'z'], (k, i) => known[i]?.includes(k) ?? false), ['a', 'x']);
  assert.deepEqual(clampPath(['gone', 'x'], (k, i) => known[i]?.includes(k) ?? false), []);
});
