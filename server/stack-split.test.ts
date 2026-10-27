import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyStackOps } from './stack-edit.ts';
import { createStackSplit, splitOf, splitOps } from './stack-split.ts';
import { createCards } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { StackRow, Work } from './core-types.ts';

const page = (n: number) => ({ url: `https://www.notion.so/acme/PR-${n}-${String(n).padStart(32, '0')}`, title: `PR ${n}` });
const stack = (): StackRow[] => [100, 101, 102].map((n) => ({ number: n, personas: ['bob'], notionPage: page(n), gates: { lint: { state: 'passed' } as never } }));
const parts = [
  { title: 'Part A', branch: 'feat/a', existingPr: 201 },
  { title: 'Part B', branch: 'feat/b', existingPr: 202 },
  { title: 'Part C', branch: 'feat/c' },
];
const heads: Record<number, { head: string; base: string }> = { 100: { head: 'feat/p100', base: 'main' }, 101: { head: 'feat/p101', base: 'feat/p100' }, 102: { head: 'feat/p102', base: 'feat/p101' }, 201: { head: 'feat/a', base: 'feat/p100' }, 202: { head: 'feat/b', base: 'feat/p100' } };

test('a split in the middle of a stack replaces the row in place, keeps the other rows and gives the first part the Notion page', () => {
  const s = splitOf({ work: 'w', pr: 101, parts }, null);
  const rows = applyStackOps(stack(), splitOps(stack(), s));
  assert.deepEqual(rows.map((r) => [r.row.number ?? r.row.planned?.branch, r.change]), [[100, 'kept'], [201, 'added'], [202, 'added'], ['feat/c', 'added'], [102, 'kept']]);
  assert.deepEqual(rows.filter((r) => r.change === 'kept').map((r) => r.row), [stack()[0], stack()[2]]);
  assert.deepEqual(rows.map((r) => r.row.notionPage?.title ?? null), ['PR 100', 'PR 101', null, null, 'PR 102']);
  assert.deepEqual(rows[3].row.planned, { title: 'Part C', branch: 'feat/c' });
  assert.deepEqual(rows[1].row.personas, ['bob']);
});

test('a part that reuses the original PR keeps the row with its gates, and a later reuse hands the page to the first part', () => {
  const s = splitOf({ work: 'w', pr: '#101', parts: [{ title: 'A', branch: 'feat/a', existingPr: 201 }, { title: 'B', branch: 'feat/p101', existingPr: 101 }] }, null);
  const rows = applyStackOps(stack(), splitOps(stack(), s));
  assert.deepEqual(rows.map((r) => [r.row.number, r.row.notionPage?.title ?? null]), [[100, 'PR 100'], [201, 'PR 101'], [101, null], [102, 'PR 102']]);
  assert.deepEqual(rows[2].row.gates, stack()[1].gates);
  assert.throws(() => splitOf({ work: 'w', pr: 101, parts: [parts[0], { ...parts[1], branch: 'feat/a' }] }, null), /distinct/);
  assert.throws(() => splitOf({ work: 'w', pr: 101, parts: [parts[0]] }, null), /parts/);
  assert.throws(() => splitOps(stack(), splitOf({ work: 'w', pr: 999, parts }, null)), /no row #999/);
});

const setup = (execFail: (args: string[]) => boolean = () => false) => {
  const fail = { on: false };
  let work: Work = { slug: 'w', title: 'W', stack: stack(), timeline: [], notion: { pageId: 'p' } };
  const calls: string[][] = [];
  const syncs: unknown[] = [];
  const queued: Raw[] = [];
  const events: string[] = [];
  const fresh: unknown[] = [];
  const works = { get: (s: string) => (s === 'w' ? structuredClone(work) : null), save: (w: Work) => void (work = structuredClone(w)), prInfo: async (n: number | null | undefined, f?: boolean) => (fresh.push([n, f]), { number: n ?? null, ...(heads[n as number] || {}) }) as never, dropPr: (n: number) => void events.push(`drop:${n}`), changed: (s: string, what?: string) => void events.push(`${s}:${what}`) };
  const split = createStackSplit({ works, exec: async (cmd, args) => (calls.push([cmd, ...args]), fail.on && execFail(args) ? { ok: false, stdout: '', stderr: 'boom\nGraphQL: not allowed' } : { ok: true, stdout: '', stderr: '' }), github: () => 'acme/app', defaultBranch: 'main', notion: { sync: (s, o) => (syncs.push([s, o]), undefined) }, bodyEntry: 'gate:kit-body:lem-pr', queue: async (_a, input) => void queued.push(input) });
  const cards = createCards({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'split-test-')), place: async () => ({ work: 'w', pr: null }), actions: { split: split.cardAction }, deliver: async () => {} });
  return { fail, cards, calls, syncs, queued, events, fresh, work: () => work };
};
const input = { pr: 101, parts, why: 'too big' };

test('the split card shows the plan and approving sets the GitHub base chain with gh, in order', async () => {
  const t = setup();
  const card = await t.cards.create({ agentId: 'agent-1', action: { type: 'split', input } });
  assert.deepEqual([card.title, card.confirmLabel, card.fields?.map((f) => [f.key, f.default])], ['Split #101 into 3: W', 'Split', [['notionRows', true], ['bodies', true]]]);
  const table = card.blocks?.[0] as unknown as { rows: unknown[][] };
  assert.deepEqual(table.rows.map((r) => r[3]), ['feat/p100', 'feat/a', 'feat/b']);
  const done = await t.cards.answer(card.id, { approved: true, values: { notionRows: true, bodies: true } });
  assert.equal(done.result?.ok, true);
  assert.deepEqual(t.calls, [
    ['gh', 'pr', 'edit', '202', '--repo', 'acme/app', '--base', 'feat/a'],
    ['gh', 'pr', 'edit', '102', '--repo', 'acme/app', '--base', 'feat/c'],
  ]);
  assert.deepEqual(t.work().stack.map((s) => s.number ?? s.planned?.branch), [100, 201, 202, 'feat/c', 102]);
  assert.match(t.work().timeline?.[0]?.text ?? '', /#101 split into #201, #202, feat\/c/);
  assert.deepEqual(t.syncs, [['w', { rowPages: [{ row: '202', title: 'Part B' }, { row: 'b:feat:c', title: 'Part C' }] }]]);
  assert.deepEqual(t.queued.map((q) => [q.entry, q.pr]), [['gate:kit-body:lem-pr', 201], ['gate:kit-body:lem-pr', 202]]);
});

test('after each base edit the PR cache is dropped and the work announced; the pre-check reads fresh PR info', async () => {
  const t = setup();
  const card = await t.cards.create({ agentId: 'agent-1', action: { type: 'split', input } });
  await t.cards.answer(card.id, { approved: true, values: {} });
  assert.deepEqual(t.events, ['drop:202', 'w:stack', 'drop:102', 'w:stack']);
  assert.ok(t.fresh.some((f) => (f as unknown[])[1] === true));
});

test('a part whose PR head is not its branch is refused; a bad base name is refused', async () => {
  const t = setup();
  const bad = { pr: 101, parts: [parts[0], { ...parts[1], branch: 'feat/other' }, parts[2]] };
  await assert.rejects(t.cards.create({ agentId: 'agent-1', action: { type: 'split', input: bad } }), /#202 has head feat\/b on GitHub, not feat\/other/);
  heads[100] = { head: '-bad', base: 'main' };
  try {
    await assert.rejects(setup().cards.create({ agentId: 'agent-1', action: { type: 'split', input } }), /-bad is not a branch name/);
  } finally {
    heads[100] = { head: 'feat/p100', base: 'main' };
  }
});

test('toggles off run nothing beyond the stack and the bases, and a failed gh call is reported per step and retried by the next approval', async () => {
  const t = setup((args) => args[2] === '202');
  t.fail.on = true;
  const card = await t.cards.create({ agentId: 'agent-1', action: { type: 'split', input } });
  const done = await t.cards.answer(card.id, { approved: true, values: { notionRows: false, bodies: false } });
  assert.equal(done.result?.ok, false);
  assert.match(done.result?.detail ?? '', /stack: #101 replaced by 3 rows; base #201: base set to feat\/p100|base #201: already on feat\/p100/);
  assert.match(done.result?.detail ?? '', /base #202: FAILED GraphQL: not allowed/);
  assert.match(done.result?.detail ?? '', /base #102: base set to feat\/c/);
  assert.deepEqual([t.syncs.length, t.queued.length], [0, 0]);
  t.fail.on = false;
  t.calls.length = 0;
  const retry = await t.cards.create({ agentId: 'agent-1', action: { type: 'split', input } });
  const second = await t.cards.answer(retry.id, { approved: true, values: {} });
  assert.match(second.result?.detail ?? '', /stack: already split; base #201: already on feat\/p100; base #202: base set to feat\/a; base #102: base set to feat\/c/);
  assert.equal(second.result?.ok, true);
  assert.deepEqual([t.work().stack.length, t.calls.length], [5, 2]);
});

test('propose_split is preapproved for every coco agent', async () => {
  const { COCO_MCP_TOOLS, CARDS_LINE } = await import('./paseo-agent.ts');
  assert.ok(COCO_MCP_TOOLS.includes('propose_split'));
  assert.match(CARDS_LINE, /propose_split/);
});
