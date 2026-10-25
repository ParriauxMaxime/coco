import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksToMarkdown, readSuggestionBefore, validateBlocks, validateRich } from './blocks.ts';

test('rich fields come back only for the keys sent, so a patch keeps the rest', async () => {
  assert.deepEqual(validateRich({ title: 'x' }), {});
  const rich = validateRich({ summary: '  Members see hidden names.  ', blocks: [{ type: 'suggestion', path: 'a.ts', startLine: 2, endLine: 3, after: 'y', before: 'forged' }] });
  assert.equal(rich.summary, 'Members see hidden names.');
  await readSuggestionBefore(rich.blocks, async (p) => (p === 'a.ts' ? ['one', 'two', 'three'] : null));
  assert.equal(rich.blocks[0].before, 'two\nthree');
});

test('a bad block is refused with the field that broke', () => {
  assert.throws(() => validateBlocks([{ type: 'text', text: 'ok' }, { type: 'table', columns: ['a', 'b'], rows: [['1']] }]), /blocks\[1\]\.rows\[0\] must hold 2 cells/);
  assert.throws(() => validateBlocks([{ type: 'media', kind: 'image', src: 'https://evil.example/x.png' }]), /blocks\[0\]\.src/);
  assert.throws(() => validateBlocks([{ type: 'poem', text: 'x' }]), /blocks\[0\]\.type must be one of/);
});

test('the markdown twin keeps every block readable for agents', () => {
  const blocks = validateBlocks([
    { type: 'text', text: 'A support agent <risk>exports</risk> every invoice.' },
    { type: 'steps', items: ['Call `GET /invoices/export.csv`', 'Check skipped'], outcome: 'CSV without the permission' },
    { type: 'table', columns: ['Role', 'Result'], rows: [['support', { text: 'exported', tone: 'risk' }]] },
  ]);
  const md = blocksToMarkdown({ category: 'In-stack bug', recommendation: 'Pin the patch', blocks, sources: [{ label: '#101 H1' }] });
  assert.match(md, /^\*\*Class:\*\* In-stack bug · \*\*Recommendation:\*\* Pin the patch/);
  assert.match(md, /A support agent exports every invoice\./);
  assert.match(md, /1\. Call `GET \/invoices\/export\.csv`\n2\. Check skipped\n→ CSV without the permission/);
  assert.match(md, /\| support \| exported \|/);
  assert.match(md, /Source: #101 H1$/);
});
