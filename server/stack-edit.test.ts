import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyStackOps, createStackEdit, opOf } from './stack-edit.ts';
import { createCards } from './cards.ts';
import { createNotionSync } from './notion.ts';
import type { NotionAgents } from './notion.ts';
import { DEFAULTS } from './config.ts';
import type { StackRow, Work } from './core-types.ts';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stack-edit-test-'));
const page = (n: number) => ({ url: `https://www.notion.so/acme/PR-${n}-${String(n).padStart(32, '0')}`, title: `PR ${n}` });
const stack = (): StackRow[] => [100, 101, 102].map((n) => ({ number: n, personas: ['bob'], notionPage: page(n), gates: { lint: { state: 'passed' } as never } }));
const ops = (...raw: Record<string, unknown>[]) => raw.map((o, i) => opOf(o, `ops[${i}]`));

test('a stack edit inserts rows after the named PR and keeps every field of the rows it does not name', () => {
  const rows = applyStackOps(stack(), ops({ op: 'add', pr: 200, after: 101 }, { op: 'add', pr: 201, after: '#200', personas: ['carol'] }, { op: 'add', branch: 'feat/x', title: 'X', after: 'start' }));
  assert.deepEqual(rows.map((r) => [r.row.number ?? r.row.planned?.branch, r.change]), [['feat/x', 'added'], [100, 'kept'], [101, 'kept'], [200, 'added'], [201, 'added'], [102, 'kept']]);
  assert.deepEqual(rows.filter((r) => r.change === 'kept').map((r) => r.row), stack());
  assert.deepEqual(rows[4].row, { number: 201, personas: ['carol'] });
});

test('a stack edit updates, moves and removes rows, sets or unlinks a Notion page, and names the op that cannot apply', () => {
  const rows = applyStackOps(stack(), ops({ op: 'update', row: 100, notionPage: { url: 'https://www.notion.so/acme/New-0123456789abcdef0123456789abcdef', title: 'New' } }, { op: 'update', row: 102, after: 'start' }, { op: 'update', row: 101, notionPage: null }, { op: 'remove', row: 100 }));
  assert.deepEqual(rows.map((r) => [r.row.number, r.change, r.row.notionPage?.title ?? null]), [[102, 'moved', 'PR 102'], [101, 'updated', null]]);
  assert.deepEqual(rows[1].row.gates, stack()[1].gates);
  assert.throws(() => applyStackOps(stack(), ops({ op: 'add', pr: 101 })), /ops\[0\]: #101 is already in the stack/);
  assert.throws(() => applyStackOps(stack(), ops({ op: 'add', pr: 300, after: 999 })), /ops\[0\]\.after: no row #999 in the stack/);
  assert.throws(() => applyStackOps(stack(), ops({ op: 'remove', row: 999 })), /ops\[0\]\.row: no row #999/);
  assert.throws(() => opOf({ op: 'update', row: 100, notionPage: { url: 'https://example.com/x', title: 'x' } }, 'ops[0]'), /ops\[0\]\.notionPage\.url must be a notion\.so link/);
});

test('a stack edit names a planned row by its branch as written, slashes included, and two ops on a shared branch take its rows in turn', () => {
  const planned = (branch: string): StackRow => ({ number: null, planned: { branch }, personas: [] });
  const rows = ['main', 'main', 'feat/design-preview', 'feat/redesign-shell'].map(planned);
  const left = applyStackOps(rows, ops({ op: 'remove', row: 'b:feat/design-preview' }, { op: 'remove', row: 'b:main' }, { op: 'update', row: 'b:main', title: 'Base' }, { op: 'update', row: 'b:feat/redesign-shell', after: 'start' }));
  assert.deepEqual(left.map((r) => [r.row.planned?.branch, r.change]), [['feat/redesign-shell', 'moved'], ['main', 'updated']]);
  assert.deepEqual(applyStackOps(rows, ops({ op: 'remove', row: 'b:main' }, { op: 'remove', row: 'b:main' })).map((r) => r.row.planned?.branch), ['feat/design-preview', 'feat/redesign-shell']);
  assert.throws(() => opOf({ op: 'remove', row: 'b:/x' }, 'ops[0]'), /ops\[0\]\.row must be a PR number or "b:<branch>"/);
});

test('approving a stack edit card writes the merged stack and starts the Notion sync only when ticked', async () => {
  let work: Work = { slug: 'w', title: 'W', stack: stack(), timeline: [], notion: { pageId: 'p' } };
  const synced: string[] = [];
  const works = { get: (s: string) => (s === 'w' ? structuredClone(work) : null), save: (w: Work) => void (work = structuredClone(w)) };
  const told: string[] = [];
  const cards = createCards({ DATA: tmpDir(), place: async () => ({ work: 'w', pr: null }), actions: { stack_edit: createStackEdit({ works, notion: { sync: (s) => synced.push(s) } }).cardAction }, deliver: async (_a, t) => void told.push(t) });
  const card = await cards.create({ agentId: 'agent-1', action: { type: 'stack_edit', input: { ops: [{ op: 'add', pr: 200, after: 101 }], syncNotion: true } } });
  assert.deepEqual([card.title, card.confirmLabel, card.fields?.map((f) => [f.key, f.default])], ['Edit stack: W (1 change)', 'Apply', [['syncNotion', true]]]);
  const done = await cards.answer(card.id, { approved: true, values: { syncNotion: true } });
  assert.deepEqual([done.result?.ok, done.result?.detail], [true, 'stack of w: 1 added; Notion sync started (runs in the background)']);
  assert.deepEqual(work.stack.map((s) => [s.number, s.notionPage?.title ?? null]), [[100, 'PR 100'], [101, 'PR 101'], [200, null], [102, 'PR 102']]);
  assert.deepEqual(synced, ['w']);

  const second = await cards.create({ agentId: 'agent-1', action: { type: 'stack_edit', input: { ops: [{ op: 'remove', row: 200 }] } } });
  await cards.answer(second.id, { approved: true, values: { syncNotion: false } });
  assert.deepEqual([work.stack.length, synced], [3, ['w']]);
  await assert.rejects(cards.create({ agentId: 'agent-1', action: { type: 'stack_edit', input: { work: 'nope', ops: [] } } }), /no work nope/);
});

test('a Notion sync of a linked work updates its one page and never creates another, row pages kept as mentions', async () => {
  const DATA = tmpDir();
  const pageId = '0123456789abcdef0123456789abcdef';
  let work: Work = { slug: 'w', title: 'W', stack: stack(), timeline: [], notion: { pageId, url: `https://www.notion.so/acme/W-${pageId}` } };
  const briefs: string[] = [];
  const agents: NotionAgents = { run: async (o) => (briefs.push(o.prompt), { status: 'idle', finalText: JSON.stringify({ status: 'synced', pageId, url: work.notion?.url }) }) };
  const works = { get: () => structuredClone(work), save: (w: Work) => void (work = structuredClone(w)), listArtifacts: () => [], detailPrs: async () => work.stack.map((s) => ({ number: s.number ?? null, title: `t${s.number}`, url: `u${s.number}`, state: 'OPEN' })), prInfo: async () => ({ number: null }), place: async () => ({ workspaceId: 'wks', cwd: DATA }) };
  const notion = createNotionSync({ DATA, REPO: '', config: DEFAULTS, works, agents });
  for (let i = 0; i < 2; i++) {
    await notion.sync('w');
    for (let j = 0; j < 200 && briefs.length <= i; j++) await new Promise((r) => setTimeout(r, 5));
    for (let j = 0; j < 200 && notion.status(work, []).running; j++) await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(briefs.length, 2);
  for (const b of briefs) {
    assert.match(b, new RegExp(`Target page id: ${pageId}`));
    assert.doesNotMatch(b, /notion-create-pages/);
  }
  assert.equal(work.notion?.pageId, pageId);
  const md = fs.readFileSync(path.join(DATA, 'works', 'w', 'notion-sync.md'), 'utf8');
  assert.equal(md.match(/<page url="[^"]+PR-100-/g)?.length, 1);
  assert.match(md, /<mention-page url="[^"]+PR-101-[^"]+">PR 101<\/mention-page>/);
});
