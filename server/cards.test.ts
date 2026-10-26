import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCards, validateAnswer, validateCard } from './cards.ts';

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
