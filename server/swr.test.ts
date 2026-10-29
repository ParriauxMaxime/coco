import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, swrCache } from './swr.ts';

const tick = () => new Promise((ok) => setTimeout(ok, 5));

test('an expired key answers with its old value at once, and a refresh that differs is announced once', async () => {
  const told: [string, number][] = [];
  const cache = swrCache<number>(60000, undefined, { changed: (k, v) => void told.push([k, v]) });
  let n = 1;
  const fn = async () => n;
  assert.equal(await cache('k', fn), 1);
  n = 2;
  assert.equal(await cache('k', fn), 1);
  cache.expire('k');
  assert.equal(await cache('k', fn), 1);
  await tick();
  assert.equal(await cache('k', fn), 2);
  assert.deepEqual(told, [['k', 2]]);
  // a refresh landing the same value says nothing
  await cache('k', fn, true);
  await tick();
  assert.deepEqual(told, [['k', 2]]);
  assert.equal(cache.has('k'), true);
  cache.drop('k');
  assert.equal(cache.has('k'), false);
});

test('mapLimit keeps the order and never runs more than its limit at once', async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (x) => {
    most = Math.max(most, ++running);
    await new Promise((ok) => setTimeout(ok, x));
    running--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0]);
  assert.equal(most, 2);
});
