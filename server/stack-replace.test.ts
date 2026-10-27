import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsk } from './ask.ts';
import { DEFAULTS } from './config.ts';
import { matchRows, replaceRows, stackDiff } from './stack-replace.ts';
import type { StackRow, Work } from './core-types.ts';

const page = (n: number) => ({ url: `https://www.notion.so/acme/P-${n}`, title: `PR ${n}` });
const row = (n: number | null, branch: string, extra: Partial<StackRow> = {}): StackRow => ({ number: n, planned: { order: 0, title: `T ${branch}`, scope: '', branch }, personas: [], ...extra });
const current = (): StackRow[] => [
  row(101, 'feat/a', { notionPage: page(101), personas: ['bob'], workspaceId: 'w1', kit: { diagram: true }, gates: { lint: { state: 'passed', at: 'x' } } }),
  row(102, 'feat/b', { notionPage: page(102) }),
  row(null, 'feat/c', { notionPage: page(103) }),
];

test('rows match by PR number then branch, once each', () => {
  assert.deepEqual(matchRows(current(), [row(null, 'feat/b'), row(101, 'feat/zzz'), row(null, 'feat/c'), row(null, 'feat/new')]), [1, 0, 2, -1]);
  assert.deepEqual(matchRows(current(), [row(null, 'feat/a'), row(null, 'feat/a')]), [0, -1]);
});

test('a replace keeps notionPage, gates, kit, workspace, reviewers and the PR number of matched rows', () => {
  const [a, , c] = replaceRows(current(), [row(null, 'feat/a', { personas: [] }), row(null, 'feat/b'), row(104, 'feat/c')]);
  assert.deepEqual([a.number, a.notionPage?.title, a.workspaceId, a.kit, a.gates?.lint.state, a.personas], [101, 'PR 101', 'w1', { diagram: true }, 'passed', ['bob']]);
  assert.deepEqual([c.number, c.notionPage?.title], [104, 'PR 103']);
  const [n] = replaceRows(current(), [row(101, 'feat/a', { personas: ['amy'], notionPage: page(9) })]);
  assert.deepEqual([n.personas, n.notionPage?.title, n.workspaceId], [['amy'], 'PR 9', 'w1']);
});

test('the diff lists rows added, removed and moved, and the Notion links kept and lost', () => {
  const d = stackDiff(current(), [row(null, 'feat/c'), row(101, 'feat/a'), row(105, 'feat/new')]);
  assert.deepEqual([d.added.length, d.removed.length, d.moved.length, d.linksKept, d.linksLost, d.differs], [1, 1, 1, 2, 1, true]);
  assert.match(d.removed[0], /^#102/);
  const same = stackDiff(current(), [row(101, 'feat/a'), row(null, 'feat/b'), row(null, 'feat/c')]);
  assert.deepEqual([same.added, same.removed, same.moved, same.linksKept, same.linksLost, same.differs], [[], [], [], 3, 0, false]);
});

// 29 rows keyed by branch with links, replaced by a plan that names them by PR number
test('29 linked rows re-keyed by PR keep their links', () => {
  const old = Array.from({ length: 29 }, (_, i) => row(i + 1, `feat/r${i}`, { notionPage: page(i + 1) }));
  const next = old.map((r, i) => row(null, `feat/r${i}`));
  const rows = replaceRows(old, next);
  assert.equal(rows.filter((r) => r.notionPage).length, 29);
  assert.deepEqual(rows.map((r) => r.number), old.map((r) => r.number));
  const d = stackDiff(old, next);
  assert.deepEqual([d.linksKept, d.linksLost, d.differs], [29, 0, false]);
  const byPr = stackDiff(old, old.map((r, i) => row(i + 1, `feat/renamed${i}`)));
  assert.deepEqual([byPr.linksKept, byPr.linksLost, byPr.differs], [29, 0, false]);
});

function setup(stack: StackRow[]) {
  const work = { slug: 'w', title: 'W', stack, timeline: [] } as unknown as Work;
  const saved: Work[] = [];
  const ask = createAsk({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'stackcard-')), APP: '/opt/coco', REPO: '/acme/widgets', config: { ...DEFAULTS, owner: { name: 'Alice' } }, works: { get: (s) => (s === 'w' ? work : undefined), save: (w) => void saved.push(w), prInfo: async () => null } });
  const def = ask.actions.work_scaffold;
  return { saved, post: (stackIn?: Record<string, unknown>[]) => def.card({ slug: 'w', title: 'W', stack: stackIn }, {} as never), run: (input: Record<string, unknown>, replaceStack: boolean) => def.run({ agentId: 'a', action: { type: 'work_scaffold', input }, answer: { values: { replaceStack } } } as never) };
}
const planned = (order: number, branch: string, extra: Record<string, unknown> = {}) => ({ order, title: `T ${branch}`, scope: 's', branch, personas: [], ...extra });

test('the replace toggle defaults on only when the proposed stack differs', async () => {
  const { post } = setup(current());
  const field = async (s?: Record<string, unknown>[]) => (await post(s)).card.fields?.[0]?.default;
  assert.equal(await field([planned(1, 'feat/a'), planned(2, 'feat/b'), planned(3, 'feat/c')]), false);
  assert.equal(await field([planned(1, 'feat/a', { existingPr: 101 }), planned(2, 'feat/b', { existingPr: 102 }), planned(3, 'feat/c')]), false);
  assert.equal(await field([planned(1, 'feat/b'), planned(2, 'feat/a'), planned(3, 'feat/c')]), true);
  assert.equal(await field([planned(1, 'feat/a')]), true);
  assert.equal(await field(undefined), false);
  assert.equal(await field([]), false);
});

test('the card shows the stack diff and warns when Notion links would be lost', async () => {
  const { post } = setup(current());
  const blocks = (await post([planned(1, 'feat/c'), planned(2, 'feat/a'), planned(3, 'feat/new')])).card.blocks as { type: string; text?: string; title?: string }[];
  const diff = blocks.find((b) => b.text?.includes('Notion links kept'));
  assert.match(diff?.text ?? '', /Added 1: .*feat\/new.* · Removed 1: #102.* · Moved 1: .* · 2 Notion links kept, 1 lost/);
  assert.ok(blocks.some((b) => b.title === 'Notion links would be lost'));
  const quiet = (await post([planned(1, 'feat/a'), planned(2, 'feat/b'), planned(3, 'feat/c')])).card.blocks as { type: string; text?: string; title?: string }[];
  assert.ok(!quiet.some((b) => b.title === 'Notion links would be lost'));
  assert.ok(quiet.some((b) => b.text?.startsWith('Same rows in the same order · 3 Notion links kept, 0 lost')));
});

test('approving applies the replace with the fields kept, a row notionPage passes through, a bad one is refused', async () => {
  const { run, saved, post } = setup(current());
  const input = { slug: 'w', title: 'W', stack: [planned(1, 'feat/a'), planned(2, 'feat/new', { notionPage: page(7) }), planned(3, 'feat/c', { existingPr: 103 })] };
  assert.equal((await run(input, true))?.ok, true);
  const rows = saved[0].stack as StackRow[];
  assert.deepEqual(rows.map((r) => [r.number, r.notionPage?.title ?? null]), [[101, 'PR 101'], [null, 'PR 7'], [103, 'PR 103']]);
  assert.deepEqual([rows[0].workspaceId, rows[0].personas, rows[0].kit, rows[0].gates?.lint.state], ['w1', ['bob'], { diagram: true }, 'passed']);
  assert.equal(rows.length, 3);
  assert.match((await run(input, false))?.detail ?? '', /stack kept/);
  await assert.rejects(async () => post([planned(1, 'feat/a', { notionPage: { url: 'https://example.com/x', title: 'x' } })]), /notionPage\.url must be a notion\.so link/);
});
