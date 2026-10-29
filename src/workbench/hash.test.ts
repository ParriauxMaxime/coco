import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, toHash } from './hash.ts';

test('a work hash carries the levels a beta mode opened, after max and the finding', () => {
  const h = toHash('drill', 'findings', true, ['12', 'f:a~b']);
  assert.equal(h, '#/work/drill/findings/max/n-12~f%3Aa%7Eb');
  assert.deepEqual(parseHash(h), { slug: 'drill', tabId: 'findings', max: true, finding: undefined, nav: ['12', 'f:a~b'] });
  assert.deepEqual(parseHash('#/work/drill/findings-12/f-c1/n-c1')?.nav, ['c1']);
  assert.equal(parseHash('#/work/drill/findings-12/f-c1/n-c1')?.finding, 'c1');
});

test('a hash without levels reads as today: no level open', () => {
  assert.equal(toHash('drill', 'stack', false), '#/work/drill/stack');
  assert.deepEqual(parseHash('#/work/drill/stack')?.nav, []);
  assert.deepEqual(parseHash('#/work/drill/plan/notes'), { slug: 'drill', legacy: 'notes' });
});
