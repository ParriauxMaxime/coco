import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCards, validateAnswer, validateCard } from './cards.ts';
import { createWaiting } from './waiting.ts';

const AGENT = '11111111-2222-3333-4444-555555555555';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cards-test-'));
const choice = { kind: 'choice', title: 'Export format', question: 'Which format ships first?', options: [{ key: 'csv', label: 'CSV', recommended: true }, { key: 'xlsx', label: 'Excel' }] };
const rows = { kind: 'rows', title: 'Findings to fix', columns: ['Finding', 'Severity'], rows: [{ key: 'f1', cells: ['Missing check', { text: 'major', tone: 'risk' }] }, { key: 'f2', cells: ['Typo', 'nit'] }] };

test('a card is refused with the field that broke, and gets its kind defaults', () => {
  assert.throws(() => validateCard({ ...choice, options: [choice.options[0]] }), /options must hold 2-8 entries/);
  assert.throws(() => validateCard({ ...rows, rows: [{ key: 'f1', cells: ['only one'] }] }), /rows\[0\]\.cells must hold 2 cells/);
  assert.throws(() => validateCard({ ...choice, blocks: [{ type: 'poem' }] }), /blocks\[0\]\.type must be one of/);
  assert.throws(() => validateCard({ kind: 'form', title: 'Name it', fields: [{ key: 'n', label: 'Name', type: 'select', options: ['a'], default: 'b' }] }), /fields\[0\]\.default must be one of a/);
  assert.throws(() => validateCard({ kind: 'post', title: 'Result' }), /blocks required on a post card/);
  assert.deepEqual(validateCard(choice), { ...choice, other: true });
  assert.equal(validateCard(rows).select, 'many');
  assert.equal(validateCard({ ...rows, rowOptions: [{ key: 'fix', label: 'Fix' }, { key: 'skip', label: 'Skip' }] }).select, undefined);
  assert.equal(validateCard({ kind: 'form', title: 'Name it', fields: [{ key: 'n', label: 'Name', type: 'text' }] }).other, false);
  const decides = { ...choice.options[0], effect: { type: 'take_decision', option: 'csv' } };
  assert.throws(() => validateCard({ ...choice, multi: true, options: [decides, choice.options[1]] }), /options\[0\]\.effect is only for the options of a single choice card/);
  assert.throws(() => validateCard({ ...choice, options: [{ ...decides, effect: { type: 'merge' } }, choice.options[1]] }), /options\[0\]\.effect\.type must be one of take_decision, dismiss_finding/);
  assert.deepEqual(validateCard({ ...choice, options: [decides, choice.options[1]] }).options?.[0].effect, { type: 'take_decision', option: 'csv' });
});

test('an answer must fit its card', () => {
  const c = validateCard(choice);
  assert.throws(() => validateAnswer(c, {}), /pick an option or write an answer/);
  assert.throws(() => validateAnswer(c, { picked: ['csv', 'xlsx'] }), /pick one option/);
  assert.throws(() => validateAnswer(c, { picked: ['pdf'] }), /picked must list keys among csv, xlsx/);
  assert.deepEqual(validateAnswer(c, { other: 'Both, CSV first' }), { picked: [], other: 'Both, CSV first' });
  assert.throws(() => validateAnswer(validateCard({ ...rows, select: 'one' }), { rows: ['f1', 'f2'] }), /tick exactly one row/);
  const form = validateCard({ kind: 'form', title: 'Limits', fields: [{ key: 'max', label: 'Max rows', type: 'number', required: true }, { key: 'zip', label: 'Zip it', type: 'toggle' }] });
  assert.throws(() => validateAnswer(form, { values: { zip: true } }), /Max rows is required/);
  assert.throws(() => validateAnswer(form, { values: { max: 10, extra: 1 } }), /values\.extra is not a field/);
  assert.throws(() => validateAnswer(form, { values: { max: 5 }, other: 'x' }), /takes no free text/);
  assert.deepEqual(validateAnswer(form, { values: { max: '500', zip: false } }), { values: { max: 500, zip: false } });
  assert.throws(() => validateAnswer(validateCard({ kind: 'confirm', title: 'Push?' }), {}), /approve, reject or write an answer/);
  const edit = validateCard({ kind: 'confirm', title: 'Start it?', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] });
  assert.throws(() => validateAnswer(edit, { approved: true }), /Title is required/);
  assert.deepEqual(validateAnswer(edit, { approved: false }), { approved: false });
  assert.deepEqual(validateAnswer(edit, { approved: true, values: { title: 'PR 1' } }), { approved: true, values: { title: 'PR 1' } });
});

test('an answer is stored then sent to the agent with its summary and JSON; a dismissal tells the agent; a failed send stays on the card', async () => {
  const DATA = tmpDir();
  const sent: [string, string][] = [];
  let down = false;
  const changed: string[] = [];
  const cards = createCards({ DATA, place: async () => ({ work: 'csv', pr: 'b:feat/x' }), deliver: async (agentId, text) => {
    if (down) throw new Error('this agent is archived');
    sent.push([agentId, text]);
  } });
  cards.onChange((id) => changed.push(id));
  const asked = await cards.create({ ...rows, agentId: AGENT, rowOptions: [{ key: 'fix', label: 'Fix now' }, { key: 'later', label: 'Later' }] });
  assert.equal(asked.status, 'open');
  assert.deepEqual([asked.work, asked.pr], ['csv', 'b:feat/x']);
  assert.equal(cards.openCount(AGENT), 1);

  const answered = await cards.answer(asked.id, { rowPicks: { f1: 'fix', f2: 'later' }, other: 'Ping me after the fix' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.delivery?.ok, true);
  const [[to, text]] = sent;
  assert.equal(to, AGENT);
  assert.match(text, new RegExp(`^\\[coco card ${asked.id} answered\\] Findings to fix\\nMissing check: Fix now\\nTypo: Later\\nOther: Ping me after the fix\\n\\n\`\`\`json\\n`));
  assert.deepEqual(JSON.parse(text.split('```json\n')[1].split('\n```')[0]).rowPicks, { f1: 'fix', f2: 'later' });
  await assert.rejects(cards.answer(asked.id, { rowPicks: { f1: 'fix' } }), /already answered/);

  down = true;
  const confirm = await cards.create({ kind: 'confirm', title: 'Push the fix?', agentId: AGENT });
  const dismissed = await cards.cancel(confirm.id);
  assert.equal(dismissed.status, 'cancelled');
  assert.deepEqual(dismissed.delivery && { ok: dismissed.delivery.ok, error: dismissed.delivery.error }, { ok: false, error: 'this agent is archived' });

  const post = await cards.create({ kind: 'post', title: 'Coverage', blocks: [{ type: 'text', text: 'All green' }], agentId: AGENT });
  assert.equal(post.status, 'answered');
  await assert.rejects(cards.answer(post.id, {}), /already answered/);
  assert.ok(changed.length >= 5 && changed.every((id) => id === AGENT));

  const reloaded = createCards({ DATA, deliver: async () => {} });
  assert.deepEqual(reloaded.ofAgent(AGENT).map((c) => c.id).sort(), [asked.id, confirm.id, post.id].sort());
  assert.equal(reloaded.openCount(AGENT), 0);
});

test('a choice option carries a consequence and the card a recommended key, which marks that option', () => {
  const opts = [{ key: 'csv', label: 'CSV', consequence: 'Ships today; no styling.' }, { key: 'xlsx', label: 'Excel', consequence: 'Adds a dependency.' }];
  const c = validateCard({ ...choice, options: opts, recommended: 'xlsx' });
  assert.deepEqual(c.options, [opts[0], { ...opts[1], recommended: true }]);
  assert.throws(() => validateCard({ ...choice, options: opts, recommended: 'pdf' }), /recommended must be an option key among csv, xlsx/);
  assert.throws(() => validateCard({ ...choice, options: [{ ...opts[0], consequence: 'x'.repeat(201) }, opts[1]] }), /options\[0\]\.consequence longer than 200/);
});

test('explain asks the agent for detail and leaves the card open, answerable', async () => {
  const sent: string[] = [];
  const cards = createCards({ DATA: tmpDir(), deliver: async (_a, text) => void sent.push(text) });
  const asked = await cards.create({ ...choice, agentId: AGENT });
  const r = await cards.explain(asked.id);
  assert.deepEqual([r.status, r.explained?.ok], ['open', true]);
  assert.match(sent[0], new RegExp(`^\\[coco card ${asked.id} explain\\] Export format\\nExplain the options in more detail before I pick\\n`));
  assert.equal((await cards.answer(asked.id, { picked: ['csv'] })).status, 'answered');
  await assert.rejects(cards.explain(asked.id), /already answered/);
});

test('a dismissal tells the agent to go on with its recommendation if safe, else to stop and say what is left', async () => {
  const sent: string[] = [];
  const cards = createCards({ DATA: tmpDir(), deliver: async (_a, text) => void sent.push(text) });
  const asked = await cards.create({ ...choice, agentId: AGENT });
  await cards.cancel(asked.id);
  assert.equal(sent[0], `[coco card ${asked.id} dismissed] Export format\nThe user dismissed this card without choosing. Continue with your recommendation if it is safe; otherwise stop and say what is left.`);
});

test("a message typed to the agent answers its open cards in chat, a thread message only that thread's; nothing is delivered", async () => {
  const sent: string[] = [];
  const DATA = tmpDir();
  const cards = createCards({ DATA, place: async () => ({ work: 'csv', pr: null }), deliver: async (_a, text) => void sent.push(text), threads: { resolve: (b) => b.thread ?? null, effect: async () => ({ ok: true, detail: '' }), deliver: async (_c, text) => void sent.push(text) } });
  const plain = await cards.create({ ...choice, agentId: AGENT });
  const inThread = await cards.create({ ...choice, agentId: AGENT, thread: 'c-1' });
  const other = await cards.create({ ...choice, agentId: 'someone-else' });
  const post = await cards.create({ kind: 'post', title: 'Coverage', blocks: [{ type: 'text', text: 'ok' }], agentId: AGENT });
  assert.deepEqual(cards.chatted([AGENT]), [plain.id]);
  const closed = cards.get(plain.id);
  assert.deepEqual([closed.status, closed.answer?.chat, closed.delivery?.skipped], ['answered', true, true]);
  assert.deepEqual([cards.get(inThread.id).status, cards.get(other.id).status, cards.get(post.id).answer], ['open', 'open', undefined]);
  assert.equal(cards.openCount(AGENT), 1);
  assert.deepEqual(cards.chattedInThread('csv', 'c-1'), [inThread.id]);
  assert.equal(cards.openCount(AGENT), 0);
  assert.deepEqual(sent, []);
  await assert.rejects(cards.answer(plain.id, { picked: ['csv'] }), /already answered/);
  assert.equal(createCards({ DATA, deliver: async () => {} }).get(plain.id).answer?.chat, true);
});

test("an archived agent's open cards close as agent archived, nothing delivered, and leave the waiting count", async () => {
  const sent: string[] = [];
  const DATA = tmpDir();
  const cards = createCards({ DATA, deliver: async (_a, text) => void sent.push(text) });
  const asked = await cards.create({ ...choice, agentId: AGENT });
  const answered = await cards.create({ ...choice, agentId: AGENT });
  await cards.answer(answered.id, { picked: ['csv'] });
  const other = await cards.create({ ...choice, agentId: 'someone-else' });
  const waiting = createWaiting({ works: { list: () => [] }, cards, threads: { queue: () => [], ready: async () => null }, ask: { list: () => [] } });
  assert.equal((await waiting.view()).count, 2);
  sent.length = 0;
  assert.deepEqual(cards.agentArchived(AGENT), [asked.id]);
  const closed = cards.get(asked.id);
  assert.deepEqual([closed.status, Boolean(closed.archived), closed.delivery?.skipped], ['cancelled', true, true]);
  assert.deepEqual([cards.get(answered.id).status, cards.get(answered.id).archived, cards.get(other.id).status], ['answered', undefined, 'open']);
  assert.deepEqual(sent, []);
  assert.equal(cards.openCount(AGENT), 0);
  waiting.touch();
  assert.deepEqual((await waiting.view()).items.map((i) => i.id), [`card:${other.id}`]);
  await assert.rejects(cards.cancel(asked.id), /already cancelled/);
  assert.ok(createCards({ DATA, deliver: async () => {} }).get(asked.id).archived);
});

test('the boot sweep closes the cards of agents found archived, once per agent, and leaves those it cannot check', async () => {
  const cards = createCards({ DATA: tmpDir(), deliver: async () => {} });
  const ids = { gone: '11111111-0000-0000-0000-000000000001', live: '11111111-0000-0000-0000-000000000002', unreachable: '11111111-0000-0000-0000-000000000003' };
  const made = { gone: [await cards.create({ ...choice, agentId: ids.gone }), await cards.create({ ...choice, agentId: ids.gone })], live: await cards.create({ ...choice, agentId: ids.live }), unreachable: await cards.create({ ...choice, agentId: ids.unreachable }) };
  const asked: string[] = [];
  const closed = await cards.sweepArchived(async (id) => {
    asked.push(id);
    if (id === ids.unreachable) throw new Error('cannot reach the Paseo daemon');
    return id === ids.gone;
  });
  assert.deepEqual(closed.sort(), made.gone.map((c) => c.id).sort());
  assert.deepEqual(asked.sort(), Object.values(ids).sort());
  assert.deepEqual([cards.get(made.live.id).status, cards.get(made.unreachable.id).status], ['open', 'open']);
  assert.deepEqual(await cards.sweepArchived(async () => true).then((x) => x.length), 2);
});
