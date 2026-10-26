import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createRules, keptOf, seedOf } from './rules.ts';
import { createCards } from './cards.ts';
import { DEFAULTS } from './config.ts';
import type { Work } from './core-types.ts';

test('proposed rules come back as a Keep or Drop card; only the kept ones land in the ledger of the asked scope', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-test-'));
  let work: Work = JSON.parse('{"slug":"csv-export","title":"CSV export","stack":[],"rules":[{"id":"a","text":"Old rule","status":"kept"}]}');
  let ended = () => {};
  const runs: string[] = [];
  const ask = {
    start: (_input: { prompt: string; workSlug: string }, opts: { onEnd: () => void }) => {
      ended = opts.onEnd;
      runs.push(`run${runs.length + 1}`);
      return { id: runs.at(-1) ?? '' };
    },
    convOf: (agentId: string) => (agentId.startsWith('11111111') ? { id: 'run1' } : null),
  };
  const rules = createRules({ DATA, config: { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' } }, works: { get: () => work, save: (w) => void (work = w) }, ask });
  const told: string[] = [];
  const cards = createCards({ DATA, actions: { rules: rules.cardAction }, deliver: async (_id, text) => void told.push(text) });
  const AGENT = '11111111-2222-3333-4444-555555555555';
  const propose = async (body: Record<string, unknown>) => {
    const req = new IncomingMessage(new Socket());
    Object.assign(req, { method: 'POST' });
    let status = 0;
    await rules.handle(req, new ServerResponse(req), ['works', 'csv-export', 'rules', 'propose'], async () => JSON.stringify(body), (_res, code) => void (status = code));
    return status;
  };

  assert.equal(await propose({ scope: 'work', text: 'Alice: never inline diffs in prompts. Also: tests name the bug.' }), 200);
  const card = await cards.create({ agentId: AGENT, action: { type: 'rules', input: { rules: [{ text: 'Never inline diffs in prompts', source: 'never inline diffs' }, { text: 'Tests name the bug they catch', source: 'tests name the bug' }] } } });
  assert.deepEqual([card.kind, card.title, card.columns, card.rowOptions?.map((o) => o.key)], ['rows', 'Rules for the csv-export work ledger', ['Rule', 'From'], ['keep', 'drop']]);
  assert.deepEqual(card.rows?.map((r) => [r.key, r.recommended]), [['r0', 'keep'], ['r1', 'keep']]);
  assert.deepEqual(card.action?.input.target, { slug: 'csv-export', scope: 'work', pr: null, source: 'chat excerpt' });
  ended();
  assert.deepEqual([rules.view('csv-export').proposing?.status, rules.view('csv-export').proposing?.cardId, rules.view('csv-export').proposing?.error], ['done', card.id, '']);

  const answered = await cards.answer(card.id, { rowPicks: { r0: 'keep', r1: 'drop' } });
  assert.deepEqual(work.rules?.map((r) => [r.text, r.status]), [['Old rule', 'kept'], ['Never inline diffs in prompts', 'kept']]);
  assert.deepEqual([answered.result?.detail, answered.result?.link], ['1 kept in the csv-export work rules, 1 dropped', '#/work/csv-export/rules']);
  assert.match(told[0], /Never inline diffs in prompts: Keep\nTests name the bug they catch: Drop\nDone: 1 kept/);

  const none = await cards.create({ agentId: AGENT, action: { type: 'rules', input: { rules: [] } } });
  assert.deepEqual([none.kind, none.status, none.title], ['post', 'answered', 'No new rule']);
});

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
