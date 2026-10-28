import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillParents, linkParent, spunOff } from './lineage.ts';
import { createAsk } from './ask.ts';
import { createCards } from './cards.ts';
import { DEFAULTS } from './config.ts';
import type { Work } from './core-types.ts';

const work = (slug: string, more: Partial<Work> = {}): Work => ({ slug, title: slug.toUpperCase(), stack: [], timeline: [], ...more });
const memory = (...list: Work[]) => {
  const all = new Map(list.map((w) => [w.slug, structuredClone(w)]));
  const touched: string[] = [];
  return {
    get: (slug: string) => structuredClone(all.get(slug)) ?? null,
    save: (w: Work, { touch = true }: { touch?: boolean } = {}) => {
      if (touch) touched.push(w.slug);
      all.set(w.slug, structuredClone(w));
    },
    list: () => [...all.values()].map((w) => structuredClone(w)),
    touched,
  };
};

test('a spun-off work keeps its parent, the parent timeline links it in time order, and no work becomes its own ancestor', () => {
  const store = memory(work('coco', { timeline: [{ ts: '2026-10-28T15:00:00Z', kind: 'note', text: 'later' }, { ts: '2026-10-28T13:00:00Z', kind: 'note', text: 'earlier' }] }), work('judge'), work('deeper'));
  assert.equal(linkParent(store, 'judge', 'coco', { ts: '2026-10-28T14:04:52Z' }), true);
  assert.equal(store.get('judge')?.parent, 'coco');
  assert.deepEqual(store.get('coco')?.timeline?.map((t) => [t.text, t.link]), [['later', undefined], ['spun off work JUDGE', '#/work/judge'], ['earlier', undefined]]);

  assert.equal(linkParent(store, 'judge', 'deeper'), false, 'a work keeps its first parent');
  assert.equal(linkParent(store, 'deeper', 'judge'), true);
  assert.equal(linkParent(store, 'coco', 'deeper'), false, 'coco is deeper’s grandparent');
  assert.equal(linkParent(store, 'coco', 'coco'), false);
  assert.equal(linkParent(store, 'coco', 'gone'), false);
  assert.equal(store.get('coco')?.parent, undefined);
});

test('the backfill takes the work of the agent named in "created from agent", once, without touching updatedAt', () => {
  const created = { ts: '2026-10-28T14:04:52.100Z', kind: 'coco', text: 'created from agent 19707ead' };
  const store = memory(work('cocopilot-open-source'), work('judge-model', { timeline: [created] }), work('orphan', { timeline: [{ ...created, text: 'created from agent deadbeef' }] }), work('asked', { timeline: [{ ...created, text: 'created from ask c99756ae: "x"' }] }));
  const asked: string[] = [];
  const workOf = (id: string) => (asked.push(id), id === '19707ead' ? 'cocopilot-open-source' : null);
  assert.deepEqual(backfillParents(store, workOf), [{ slug: 'judge-model', parent: 'cocopilot-open-source' }]);
  assert.deepEqual(asked.sort(), ['19707ead', 'deadbeef']);
  assert.equal(store.get('judge-model')?.parent, 'cocopilot-open-source');
  assert.deepEqual(store.get('cocopilot-open-source')?.timeline?.[0], { ts: created.ts, kind: 'coco', text: 'spun off work JUDGE-MODEL', link: '#/work/judge-model' });
  assert.deepEqual(store.touched, []);
  assert.deepEqual(backfillParents(store, workOf), [], 'a second run finds nothing to do');
  assert.equal(store.get('cocopilot-open-source')?.timeline?.length, 1);
});

test('the parent lists each spun-off work with its state and What’s next, live ones first', () => {
  const all = [
    work('coco'),
    work('old', { parent: 'coco', archived: { at: '2026-10-01', reason: 'manual' }, createdAt: '2026-10-02' }),
    work('judge', { parent: 'coco', createdAt: '2026-10-28', next: { summary: 'Drop wrong lessons', at: '2026-10-28T14:45:00Z', blocks: null } }),
    work('elsewhere', { parent: 'other' }),
  ];
  assert.deepEqual(spunOff(all, 'coco'), [
    { slug: 'judge', title: 'JUDGE', archived: false, next: 'Drop wrong lessons', nextAt: '2026-10-28T14:45:00Z', createdAt: '2026-10-28' },
    { slug: 'old', title: 'OLD', archived: true, next: null, nextAt: null, createdAt: '2026-10-02' },
  ]);
});

test('approving a work scaffold an agent of another work proposed makes the new work a child of that work, in its repo; an update links nothing', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-test-'));
  const store = memory(work('cocopilot', { repo: 'coco' }));
  const ask = createAsk({ DATA, APP: '/opt/coco', REPO: '/acme/coco', config: { ...DEFAULTS, owner: { name: 'Alice' } }, works: { ...store, prInfo: async () => null } });
  const cards = createCards({ DATA, place: async () => ({ work: 'cocopilot', pr: 'b:main' }), actions: ask.actions, deliver: async () => {} });
  const agentId = '19707ead-eab5-4d00-a978-3ddb5c563f60';
  const create = await cards.create({ agentId, action: { type: 'work_scaffold', input: { slug: 'judge-model', title: 'Judge model' } } });
  assert.equal((await cards.answer(create.id, { approved: true })).result?.detail, 'created work judge-model');
  const child = store.get('judge-model');
  assert.deepEqual([child?.parent, child?.repo, child?.timeline?.[0].text], ['cocopilot', 'coco', 'created from agent 19707ead']);
  assert.deepEqual(store.get('cocopilot')?.timeline?.map((t) => [t.text, t.link]), [['spun off work Judge model', '#/work/judge-model']]);

  const update = await cards.create({ agentId, action: { type: 'work_scaffold', input: { slug: 'cocopilot', title: 'cocopilot' } } });
  await cards.answer(update.id, { approved: true });
  assert.deepEqual([store.get('cocopilot')?.parent, store.get('cocopilot')?.timeline?.length], [undefined, 2]);
  assert.equal(cards.workOfAgent('19707ead'), 'cocopilot');
});
