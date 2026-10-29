import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrBody, lineDiff } from './pr-body.ts';
import { createCards } from './cards.ts';
import type { Exec } from './core-types.ts';

const OLD = ['## Summary', 'Scoped reads.', '', '| Callers | 11 / 124 |', '', '## Test', 'Run it.'].join('\n');
const NEW = OLD.replace('11 / 124', '11 / 120');

const setup = () => {
  let live = OLD;
  const written: string[] = [];
  const exec: Exec = async (_cmd, args) => {
    if (args[0] === 'pr' && args[1] === 'view') return args[2] === '101' ? { ok: true, stdout: JSON.stringify({ body: live, title: 'Scoped reads', url: 'https://github.com/acme/widgets/pull/101' }), stderr: '' } : { ok: false, stdout: '', stderr: 'no pull requests found' };
    if (args[0] === 'pr' && args[1] === 'edit') {
      written.push(fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'));
      return { ok: true, stdout: '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected' };
  };
  const cards = createCards({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-test-')), place: async () => ({ work: 'w', pr: '101' }), actions: { pr_body: createPrBody({ githubOf: () => 'acme/widgets', exec }).cardAction }, deliver: async () => {} });
  return { cards, written, edit: (body: string) => (live = body) };
};

test('the diff of a body keeps two lines around each change and folds the rest', () => {
  assert.deepEqual(lineDiff(OLD, NEW), ['@@ …', ' Scoped reads.', ' ', '-| Callers | 11 / 124 |', '+| Callers | 11 / 120 |', ' ', ' ## Test', '@@ …']);
  assert.deepEqual(lineDiff('a', 'a\nb'), [' a', '+b']);
});

test('a body card shows the diff against the live body and writes the body only on approval', async () => {
  const { cards, written } = setup();
  await assert.rejects(cards.create({ agentId: 'ag-1', action: { type: 'pr_body', input: { body: OLD } } }), /the same as the live body of #101/);
  await assert.rejects(cards.create({ agentId: 'ag-1', action: { type: 'pr_body', input: { pr: 7, body: NEW } } }), /no PR #7 in acme\/widgets/);
  const c = await cards.create({ agentId: 'ag-1', action: { type: 'pr_body', input: { body: NEW, why: 'The caller count moved.' } } });
  assert.equal(c.title, 'New body for #101');
  assert.equal(c.confirmLabel, 'Replace body');
  assert.match(JSON.stringify(c.blocks), /-\| Callers \| 11 \/ 124 \|\\n\+\| Callers \| 11 \/ 120 \|/);
  assert.deepEqual(written, []);
  const done = await cards.answer(c.id, { approved: true });
  assert.deepEqual(written, [NEW]);
  assert.deepEqual([done.result?.ok, done.result?.link], [true, 'https://github.com/acme/widgets/pull/101']);
});

test('a body changed on GitHub since the card is not overwritten', async () => {
  const { cards, written, edit } = setup();
  const c = await cards.create({ agentId: 'ag-1', action: { type: 'pr_body', input: { body: NEW } } });
  edit(`${OLD}\n\n## Demo\nvideo`);
  const done = await cards.answer(c.id, { approved: true });
  assert.deepEqual(written, []);
  assert.equal(done.result?.ok, false);
  assert.match(done.result?.detail || '', /changed on GitHub since this card: nothing written/);
});
