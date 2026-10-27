import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, createClassifier, createReviewPlan, normalizePlan, splitDiff, suggestedOrder } from './review-plan.ts';
import { readPrFindings, readReviewContext, reviewContextFile, writeReviewContext } from './review-context.ts';
import { DEFAULTS } from './config.ts';
import type { Work } from './core-types.ts';

const L = 'src';
const hunk = (minus: string[], plus: string[]) => ['@@ -1,1 +1,1 @@', ...minus.map((l) => `-${l}`), ...plus.map((l) => `+${l}`)].join('\n');
const diffOf = (p: string, minus: string[], plus: string[]) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n${hunk(minus, plus)}\n`;

const FIXTURE: [string, string[], string[]][] = [
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
const cat = (suffix: string) => cats[`${L}/${suffix}`];

test('splitDiff keeps added and removed lines per path', () => {
  assert.deepEqual(diffs[`${L}/invoices/server/service/invoice-service.ts`], { added: ['  helper(a, b);'], removed: ['  helper(a);'] });
});

test('classify puts each fixture file in the expected category', () => {
  const want: Record<string, [string, RegExp]> = {
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

test('the plan prompt of a 250-file PR stays under 2k tokens: no diff, no file list, guidance and rules behind get_review_context', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-plan-'));
  const big = Array.from({ length: 250 }, (_, i) => ({ filename: `${L}/feature-${i % 9}/server/use-case/a-rather-long-module-name-${i}.ts`, status: 'modified', additions: 120, deletions: 40 }));
  const refs = { number: 4242, headSha: 'a'.repeat(40), baseSha: 'c'.repeat(40), mergeBase: 'b'.repeat(40) };
  const work: Work = { slug: 'csv', title: 'CSV export', timeline: [], stack: [{ number: 4242 }] };
  const sent: { prompt: string; systemPrompt?: string }[] = [];
  const plan = createReviewPlan({
    DATA,
    REPO: DATA,
    config: { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' } },
    code: { ensureRefs: async () => refs, prFilesFromGit: async () => big },
    works: { get: () => work, prInfo: async () => assert.fail('placed, no PR lookup'), personasForPaths: () => [{ login: 'bob', hits: 250 }], remark: () => null },
    rules: { keptFor: () => [{ id: 'r1', text: 'No ternaries in server code.', source: 'x', addedAt: 'x', status: 'kept' }] },
    agents: { run: (opts) => (sent.push(opts), new Promise(() => {})) },
    place: async () => ({ workspaceId: 'wks_1', cwd: DATA }),
  });
  await plan.start('csv', 4242, { guidance: `Focus on the export permission. ${'Be thorough. '.repeat(200)}` });
  await new Promise((resolve) => setImmediate(resolve));
  const [{ prompt }] = sent;
  assert.ok(Math.ceil(prompt.length / 4) <= 2000, `${Math.ceil(prompt.length / 4)} tokens`);
  assert.doesNotMatch(prompt, /a-rather-long-module-name|Be thorough|No ternaries/);
  assert.match(prompt, /get_review_context with pr "4242" and work "csv"/);
  assert.match(prompt, new RegExp(`git diff --name-status ${refs.mergeBase} ${refs.headSha}`));
  const ctx = readReviewContext(DATA, { pr: '4242', work: 'csv' });
  assert.ok(!('error' in ctx));
  assert.match(ctx.guidance, /^Focus on the export permission/);
  assert.deepEqual(ctx.rules, ['No ternaries in server code.']);
  assert.deepEqual(ctx.personas, [{ login: 'bob', hits: 250 }]);
});

test('get_pr_findings lists settled findings with their thread end and dismissed watch points, which outlive a re-plan', () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-seen-'));
  const reviews = path.join(DATA, 'works', 'csv', 'reviews');
  const write = (file: string, data: unknown) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, JSON.stringify(data)));
  write(path.join(DATA, 'works', 'csv', 'comments', 'pr-7.json'), { number: 7, comments: [{ id: 'c1', path: 'src/a.ts', sha: 'a'.repeat(40), startLine: 4, endLine: 4, body: 'Partial write on a hidden invoice', author: 'alice', status: 'declined', resolution: { note: 'Kept on purpose' } }] });
  write(path.join(DATA, 'works', 'csv', 'threads', 'c.7.c1.json'), { messages: [{ role: 'user', text: 'why?' }, { role: 'agent', text: 'Accept the gap until the REST PR.' }] });
  write(path.join(reviews, 'pr-7-plan.json'), { run: null, ticks: {}, watch: {}, plan: { headSha: 'b'.repeat(40), createdAt: 'p1', watchPoints: [{ path: 'src/b.ts', startLine: 2, endLine: 3, body: 'Polled method now reads twice', severity: 'minor' }] } });
  const plan = createReviewPlan({ DATA, REPO: DATA, config: DEFAULTS, code: { ensureRefs: async () => assert.fail(), prFilesFromGit: async () => [] }, works: { get: () => null, prInfo: async () => assert.fail(), personasForPaths: () => [], remark: () => null } });
  plan.watch('csv', 7, { index: 0, state: 'dismissed', note: 'cheap enough' });
  const stored = JSON.parse(fs.readFileSync(path.join(reviews, 'pr-7-plan.json'), 'utf8'));
  write(path.join(reviews, 'pr-7-plan.json'), { ...stored, watch: {}, plan: { ...stored.plan, createdAt: 'p2', watchPoints: [] } });
  const seen = readPrFindings(DATA, { pr: 7 });
  assert.ok(!('error' in seen));
  assert.equal(seen.work, 'csv');
  assert.deepEqual(seen.findings.map((f) => [f.status, f.title, f.resolution?.note, f.thread?.at(-1)?.text]), [['declined', 'Partial write on a hidden invoice', 'Kept on purpose', 'Accept the gap until the REST PR.']]);
  assert.deepEqual(seen.dismissedWatchPoints.map((d) => [d.path, d.lines, d.note]), [['src/b.ts', '2-3', 'cheap enough']]);
});

test('get_review_context reads the latest run on a PR, in the given work or any', () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-ctx-'));
  writeReviewContext(DATA, 'old', 7, { guidance: 'old run', rules: [], personas: [] });
  writeReviewContext(DATA, 'new', 7, { guidance: 'new run', rules: ['r'], personas: [] });
  fs.utimesSync(reviewContextFile(DATA, 'old', 7), new Date(1000), new Date(1000));
  assert.equal((readReviewContext(DATA, { pr: 7 }) as { guidance: string }).guidance, 'new run');
  assert.equal((readReviewContext(DATA, { pr: '7', work: 'old' }) as { guidance: string }).guidance, 'old run');
  assert.match((readReviewContext(DATA, { pr: 8 }) as { error: string }).error, /no review plan run recorded for #8/);
  assert.match((readReviewContext(DATA, { pr: 'nope' }) as { error: string }).error, /PR number/);
});
