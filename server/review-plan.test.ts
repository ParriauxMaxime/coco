import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, createClassifier, normalizePlan, splitDiff, suggestedOrder } from './review-plan.ts';

const L = 'src';
const hunk = (minus, plus) => ['@@ -1,1 +1,1 @@', ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join('\n');
const diffOf = (p, minus, plus) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n${hunk(minus, plus)}\n`;

const FIXTURE = [
  [`${L}/invoices/server/use-case/export-use-case.ts`, [], ['  const allowed = await canExport(callerId);', '  if (!allowed) throw new HttpError(403);', '  return toCsv(rows);']],
  [`${L}/invoices/server/controller/export-route.ts`, ['  return useCase.run(req);'], ['  const out = await useCase.run(req);', '  res.status(out ? 200 : 403);', '  return out;']],
  [`${L}/invoices/server/service/invoice-service.ts`, ['  helper(a);'], ['  helper(a, b);']],
  [`${L}/invoices/server/use-case/export-use-case.test.ts`, [], ['  it("refuses", () => {});']],
  [`${L}/invoices/invoice-errors.ts`, [], ["  EXPORT_REFUSED: 'export-refused',"]],
  [`${L}/invoices/server/@types/invoice-types.d.ts`, [], ['  includeVoided?: boolean;']],
  [`${L}/invoices/invoices.md`, [], ['- new rule']],
  [`${L}/invoices/client/components/table.tsx`, [], ["import { useExport } from '/client/export';"]],
  [`${L}/invoices/client/components/row.tsx`, ['    <Row  a={1} />'], ['    <Row a={1} />']],
  [`${L}/invoices/client/components/cell.tsx`, ['  const customer = invoice.customer.firstName + " " + invoice.customer.lastName;', '  const email = invoice.customer.emails[0]?.value ?? "";', '  const total = invoice.total?.amount ?? "";'], []],
  [`${L}/invoices/client/components/new-cell.tsx`, [], ['  const customer = invoice.customer.firstName + " " + invoice.customer.lastName;', '  const email = invoice.customer.emails[0]?.value ?? "";', '  const total = invoice.total?.amount ?? "";', '  return null;']],
];
const files = FIXTURE.map(([filename, minus, plus]) => ({ filename, status: 'modified', additions: plus.length, deletions: minus.length }));
const diffs = splitDiff(FIXTURE.map(([p, minus, plus]) => diffOf(p, minus, plus)).join(''));
const cats = classify(files, diffs);
const cat = (suffix) => cats[`${L}/${suffix}`];

test('splitDiff keeps added and removed lines per path', () => {
  assert.deepEqual(diffs[`${L}/invoices/server/service/invoice-service.ts`], { added: ['  helper(a, b);'], removed: ['  helper(a);'] });
});

test('classify puts each fixture file in the expected category', () => {
  const want = {
    'invoices/server/use-case/export-use-case.ts': ['core', /use-case/],
    'invoices/server/controller/export-route.ts': ['core', /controller/],
    'invoices/server/service/invoice-service.ts': ['refactor', /call-site/],
    'invoices/server/use-case/export-use-case.test.ts': ['tests', /test file/],
    'invoices/server/@types/invoice-types.d.ts': ['wiring', /type declarations/],
    'invoices/invoices.md': ['other', /docs/],
    'invoices/client/components/table.tsx': ['wiring', /import\/export/],
    'invoices/client/components/row.tsx': ['refactor', /formatting/],
    'invoices/client/components/new-cell.tsx': ['refactor', /moved/],
  };
  for (const [suffix, [category, reason]] of Object.entries(want)) {
    assert.equal(cat(suffix).category, category, suffix);
    assert.match(cat(suffix).reason, reason, suffix);
  }
  assert.equal(cat('invoices/client/components/cell.tsx').category, 'core');
  assert.equal(cat('invoices/invoice-errors.ts').category, 'core');
});

test('fileLayers from config replace the default wiring and layer lists', () => {
  const custom = createClassifier({ wiring: [['-errors\\.ts$', 'error registry entry']], layers: [['/use-case/', 'use-case'], ['/controller/', 'controller']] });
  const c = custom.classify(files, diffs);
  assert.match(c[`${L}/invoices/invoice-errors.ts`].reason, /error registry/);
  assert.equal(c[`${L}/invoices/server/@types/invoice-types.d.ts`].category, 'core');
  const order = custom.suggestedOrder(files, c);
  assert.ok(order.indexOf(`${L}/invoices/server/use-case/export-use-case.ts`) < order.indexOf(`${L}/invoices/server/controller/export-route.ts`));
});

test('suggestedOrder: core entry point first (controller before use-case), docs last', () => {
  const order = suggestedOrder(files, cats);
  assert.ok(order.indexOf(`${L}/invoices/server/controller/export-route.ts`) < order.indexOf(`${L}/invoices/server/use-case/export-use-case.ts`));
  assert.equal(cats[order[0]].category, 'core');
  assert.equal(order.at(-1), `${L}/invoices/invoices.md`);
});

test('normalizePlan drops unknown paths, dedupes, skims the rest and clamps watch lines', () => {
  const raw = {
    summary: 'Refuse the export without the permission.',
    steps: [{ title: 'Entry point', why: 'entry', files: [{ path: `${L}/invoices/server/controller/export-route.ts`, focus: '403' }, { path: 'nope.ts', focus: 'x' }] }, { title: 'Dup', why: '', files: [{ path: `${L}/invoices/server/controller/export-route.ts`, focus: '' }] }],
    skim: [],
    watchPoints: [{ path: `${L}/invoices/server/use-case/export-use-case.ts`, startLine: 2, endLine: 99, body: 'Check the 403.' }, { path: 'nope.ts', startLine: 1, endLine: 1, body: 'x' }],
  };
  const plan = normalizePlan(raw, files, cats, { [`${L}/invoices/server/use-case/export-use-case.ts`]: 10 });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].files.length, 1);
  assert.equal(plan.skim.length, files.length - 1);
  assert.deepEqual(plan.watchPoints.map((w) => [w.startLine, w.endLine]), [[2, 10]]);
});
