import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalog, createDispatch, firstMessage } from './dispatch.ts';
import { DEFAULTS } from './config.ts';
import type { Config } from './config.ts';
import type { Work } from './core-types.ts';

const AGENT = '12345678-1234-1234-1234-123456789abc';
const config: Config = {
  ...DEFAULTS,
  owner: { name: 'Alice', login: 'alice' },
  repo: { ...DEFAULTS.repo, github: 'acme/widgets', defaultBranch: 'main' },
  gateSkills: { ...DEFAULTS.gateSkills, 'self-review': ['code-review'], 'kit-diagram': ['coco-diagram'] },
  rituals: [{ kind: 'review-as', label: 'Review as', prompt: '/review-as {login} {pr}' }],
};

function setup({ contextFails = false } = {}) {
  let work: Work = { slug: 'csv', title: 'CSV export', timeline: [], stack: [{ number: 101, personas: ['bob'] }, { number: 102 }] };
  const works = { get: (s: string) => (s === 'csv' ? structuredClone(work) : null), save: (w: Work) => ((work = structuredClone(w)), w) };
  const placed: unknown[] = [];
  const started: Record<string, unknown>[] = [];
  const fixes: { key: unknown; commentIds: string[]; prompt: string }[] = [];
  const timeline: string[] = [];
  const dispatch = createDispatch({
    config,
    works,
    placement: { place: async (scope) => (placed.push(scope), { workspaceId: 'kind' in scope && scope.kind === 'row' && scope.edits ? 'wks_row' : 'wks_plan', cwd: '/tmp/x' }) },
    agents: { start: async (opts) => (started.push(opts), { agentId: AGENT, workspaceId: String(opts.workspaceId) }) },
    briefs: {
      context: async () => {
        if (contextFails) throw new Error('gh down');
        return { work, index: 1, pr: { head: 'feat/csv-2', base: 'feat/csv-1', title: 'Export endpoint' }, worktree: null, config };
      },
    },
    reviewAgent: {
      start: async (_slug, key, input) => (fixes.push({ key, commentIds: input.commentIds, prompt: input.wrap ? input.wrap('Read brief.md') : '' }), { runId: 'r1', agentId: AGENT }),
      timeline: (_slug, _kind, text) => timeline.push(text),
    },
    comments: { list: () => ({ comments: [{ id: 'c1', status: 'open' }, { id: 'c2', status: 'fixed' }, { id: 'c3', status: 'open' }] }) },
  });
  return { dispatch, placed, started, fixes, timeline, work: () => work };
}

test('the catalog lists the fixed kinds, one gate run per gate skill, and manual test', () => {
  const ids = catalog(config).map((e) => e.id);
  assert.deepEqual(ids, ['ask', 'persona-review', 'fix-findings', 'gate:self-review:code-review', 'gate:kit-diagram:coco-diagram', 'gate:manual-test', 'prompt']);
  const byId = Object.fromEntries(catalog(config).map((e) => [e.id, e]));
  assert.equal(byId.ask.edits, false);
  assert.equal(byId['persona-review'].edits, false);
  assert.equal(byId['fix-findings'].edits, true);
  assert.equal(byId['gate:self-review:code-review'].edits, true);
});

test('a read-only ask runs in the Plan workspace with its question first and the PR brief after', async () => {
  const { dispatch, placed, started } = setup();
  const r = await dispatch.start('csv', { entry: 'ask', key: 102, prompt: 'Why a new index?' });
  assert.deepEqual(placed, [{ kind: 'row', slug: 'csv', key: 102, edits: false }]);
  assert.equal(r.workspaceId, 'wks_plan');
  const prompt = String(started[0].prompt);
  assert.ok(prompt.indexOf('Why a new index?') < prompt.indexOf('# CSV export — PR 2'));
  assert.match(prompt, /Read-only: do not edit files/);
  assert.match(prompt, /git diff feat\/csv-1\.\.\.feat\/csv-2/);
  assert.equal(started[0].title, 'Ask · Why a new index? · #102');
});

test('a gate run works on the PR row, sends the skill and marks the gate running', async () => {
  const { dispatch, placed, started, work } = setup();
  await dispatch.start('csv', { entry: 'gate:self-review:code-review', key: 101 });
  assert.deepEqual(placed, [{ kind: 'row', slug: 'csv', key: 101, edits: true }]);
  assert.match(String(started[0].prompt), /^# self review: \/code-review\n\n\/code-review 101\n/);
  assert.doesNotMatch(String(started[0].prompt), /Read-only/);
  assert.equal(work().stack[0].gates?.['self-review']?.state, 'running');
  assert.equal(work().stack[0].gates?.['self-review']?.agentId, AGENT);
});

test('a persona review fills the review-as ritual and stays read-only', async () => {
  const { dispatch, placed, started } = setup();
  await dispatch.start('csv', { entry: 'persona-review', key: 101, persona: 'bob' });
  assert.deepEqual(placed, [{ kind: 'row', slug: 'csv', key: 101, edits: false }]);
  assert.match(String(started[0].prompt), /\n\/review-as bob 101\n/);
});

test('fix findings hands the open comments to the review agent with the dispatch message around its brief', async () => {
  const { dispatch, fixes, started } = setup();
  const r = await dispatch.start('csv', { entry: 'fix-findings', key: 102 });
  assert.equal(started.length, 0);
  assert.deepEqual(fixes[0].commentIds, ['c1', 'c3']);
  assert.match(fixes[0].prompt, /^# Fix findings\n\nRead brief\.md\n\n---/);
  assert.equal(r.runId, 'r1');
});

test('a free prompt without a PR runs on the work; one with edits on a PR gets the row', async () => {
  const { dispatch, placed } = setup();
  await dispatch.start('csv', { entry: 'prompt', prompt: 'Summarise the stack' });
  await dispatch.start('csv', { entry: 'prompt', key: 102, prompt: 'Add a test', edits: true });
  assert.deepEqual(placed, [{ kind: 'work', slug: 'csv' }, { kind: 'row', slug: 'csv', key: 102, edits: true }]);
});

test('a dispatch still starts when the PR brief cannot be rendered', async () => {
  const { dispatch, started } = setup({ contextFails: true });
  await dispatch.start('csv', { entry: 'ask', key: 102, prompt: 'Why?' });
  assert.match(String(started[0].prompt), /could not be rendered: gh down/);
});

test('bad dispatches are refused before anything starts', async () => {
  const { dispatch, placed } = setup();
  await assert.rejects(dispatch.start('csv', { entry: 'nope', key: 101 }), /unknown dispatch/);
  await assert.rejects(dispatch.start('csv', { entry: 'ask', key: 101 }), /needs a prompt/);
  await assert.rejects(dispatch.start('csv', { entry: 'ask', prompt: 'x' }), /needs a PR/);
  await assert.rejects(dispatch.start('csv', { entry: 'ask', key: 999, prompt: 'x' }), /not in this work/);
  await assert.rejects(dispatch.start('csv', { entry: 'persona-review', key: 101, persona: '../x' }), /persona login/);
  assert.equal(placed.length, 0);
});

test('firstMessage leaves the read-only note out for editing kinds', () => {
  assert.equal(firstMessage({ title: 'T', task: 'do it', edits: true, brief: null }), '# T\n\ndo it');
});
