import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorks } from './works.ts';
import { swrCache } from './swr.ts';
import { DEFAULTS } from './config.ts';
import type { Sink } from './events.ts';
import type { Work } from './core-types.ts';

const make = () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-works-'));
  const works = createWorks({ DATA, PERSONAS: path.join(DATA, 'personas'), REPO: DATA, config: { ...DEFAULTS, importRoots: [DATA] } });
  const sink = () => {
    const got: unknown[] = [];
    const closers: (() => void)[] = [];
    const s: Sink = { send: (json) => void got.push(JSON.parse(json)), onClose: (fn) => void closers.push(fn), closed: false };
    return Object.assign(s, { got, close: () => closers.forEach((f) => f()) });
  };
  const w = { slug: 'w', title: 'W', stack: [{ number: 1 }], timeline: [] } as unknown as Work;
  works.save(w);
  return { DATA, works, sink, w };
};

test('a work save is announced to the work topic as a work change, a stack save as a stack change', () => {
  const { works, sink, w } = make();
  const s = sink();
  works.watchWork(s, 'w');
  works.save({ ...w, title: 'W2' });
  works.save({ ...w, title: 'W2', stack: [{ number: 1 }, { number: 2 }] });
  assert.deepEqual(s.got, [{ slug: 'w', what: 'work' }, { slug: 'w', what: 'stack' }]);
});

test('the work topic follows its own slug; the works topic still sends every slug', () => {
  const { works, sink, w } = make();
  const one = sink();
  const all = sink();
  works.watchWork(one, 'other');
  works.watch(all);
  works.save(w);
  assert.deepEqual([one.got, all.got], [[], [{ slug: 'w' }]]);
});

test('a closed subscription stops hearing; listeners run in the order they were added; plan, drift and artifacts changes are announced', () => {
  const { works, sink } = make();
  const order: string[] = [];
  works.onChange(() => void order.push('first'));
  const s = sink();
  works.watchWork(s, 'w');
  works.onChange(() => void order.push('last'));
  works.changed('w', 'artifacts');
  works.changed('w', 'drift');
  works.changed('w', 'plan');
  s.close();
  works.changed('w', 'plan');
  assert.deepEqual(s.got, [{ slug: 'w', what: 'artifacts' }, { slug: 'w', what: 'drift' }, { slug: 'w', what: 'plan' }]);
  assert.deepEqual(order, ['first', 'last', 'first', 'last', 'first', 'last', 'first', 'last']);
});

test('importing an artifact is announced as an artifacts change', async () => {
  const { DATA, works, sink } = make();
  fs.writeFileSync(path.join(DATA, 'note.txt'), 'x');
  const s = sink();
  works.watchWork(s, 'w');
  await works.handle({ method: 'POST', url: '/api/works/w/artifacts' } as never, {} as never, ['works', 'w', 'artifacts'], async () => JSON.stringify({ path: path.join(DATA, 'note.txt') }), () => {});
  assert.deepEqual(s.got, [{ slug: 'w', what: 'artifacts' }]);
});

test('dropping a cached value makes the next read recompute', async () => {
  const c = swrCache<number>(60000);
  let n = 0;
  assert.deepEqual([await c('k', async () => ++n), await c('k', async () => ++n)], [1, 1]);
  c.drop('k');
  assert.equal(await c('k', async () => ++n), 2);
});
