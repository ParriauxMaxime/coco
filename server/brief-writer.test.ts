import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanBrief, createBriefWriter, parseLessons, readLessons } from './brief-writer.ts';
import { createJudge } from './judge.ts';
import type { AgentHistory } from './paseo-agent.ts';

const AGENT = '12345678-1234-1234-1234-123456789abc';
const HOUR = 60 * 60 * 1000;
const dispatch = { slug: 'csv', repoId: 'widgets', title: 'Ask · Why a new index? · #102', label: 'Ask on this PR', pr: '#102', edits: false, task: 'Why a new index?' };

type Run = { title: string; prompt: string; provider: string; labels: Record<string, unknown>; workspaceId: string; cwd: string; timeoutMs: number };

function setup({ answers = [] as ({ status: string; finalText: string; error?: string } | 'hang')[], history = null as AgentHistory | null, lessons = undefined as unknown } = {}) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-brief-'));
  if (lessons !== undefined) {
    fs.mkdirSync(path.join(DATA, 'repos', 'widgets'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'repos', 'widgets', 'brief-lessons.json'), JSON.stringify(lessons));
  }
  const runs: Run[] = [];
  const state = { history, now: Date.parse('2026-10-26T12:00:00Z') };
  const config = { models: { default: 'claude/opus', fast: 'claude/sonnet' } };
  const agents = {
    run: async (opts: Run) => {
      runs.push(opts);
      const next = answers.shift() || { status: 'done', finalText: '[]' };
      return next === 'hang' ? new Promise<never>(() => {}) : next;
    },
    history: async () => state.history,
  };
  const writer = createBriefWriter({
    DATA,
    config,
    place: async (slug) => ({ workspaceId: `wks_plan_${slug}`, cwd: '/tmp/plan' }),
    agents,
    judge: createJudge({ DATA, config, agents }),
    now: () => state.now,
    writerMs: 50,
  });
  const lessonsFile = path.join(DATA, 'repos', 'widgets', 'brief-lessons.json');
  const tracked = () => JSON.parse(fs.readFileSync(path.join(DATA, 'brief-runs.json'), 'utf8'));
  return { DATA, writer, runs, state, lessonsFile, tracked };
}

const historyOf = (message: string, followUps: string[], extra: Partial<AgentHistory> = {}): AgentHistory => ({ status: 'idle', archived: false, updatedAt: '2026-10-26T11:59:00Z', userMessages: [message, ...followUps].map((text) => ({ text, at: null })), ...extra });

test('the brief writer runs on the fast model in the work Plan workspace with the dispatch, the facts and the repo lessons', async () => {
  const { writer, runs } = setup({ answers: [{ status: 'done', finalText: '```markdown\nThe PR adds an index on `invoices.teamId`.\n```' }], lessons: ['Invoices live in `server/billing/`.', { text: 'Run tests with `npm test`.', at: '2026-10-20T00:00:00Z' }] });
  const out = await writer.write(dispatch, '# CSV export — PR 2: Export endpoint\n\n## Task');
  assert.deepEqual(out, { brief: 'The PR adds an index on `invoices.teamId`.' });
  assert.equal(runs[0].provider, 'claude/sonnet');
  assert.equal(runs[0].workspaceId, 'wks_plan_csv');
  assert.equal(runs[0].labels.kind, 'brief-writer');
  assert.match(runs[0].prompt, /Agent: Ask on this PR, read-only, on #102\./);
  assert.match(runs[0].prompt, /<task>\nWhy a new index\?\n<\/task>/);
  assert.match(runs[0].prompt, /## Facts\n\n# CSV export — PR 2: Export endpoint/);
  assert.match(runs[0].prompt, /## Lessons from past runs in this repo\n\n- Invoices live in `server\/billing\/`\.\n- Run tests with `npm test`\./);
});

test('a failed, empty or late writer gives no brief and says why', async () => {
  const { writer } = setup({ answers: [{ status: 'error', finalText: '', error: 'provider down' }, { status: 'done', finalText: '  ' }, 'hang'] });
  assert.deepEqual(await writer.write(dispatch, null), { brief: null, error: 'provider down' });
  assert.equal((await writer.write(dispatch, null)).error, 'the brief writer answered nothing');
  assert.match(String((await writer.write(dispatch, null)).error), /no brief within/);
});

test('once a tracked run is archived, the follow-ups that supplied context become repo lessons', async () => {
  const message = '# Ask\n\nWhy a new index?\n\n---\n\nbrief';
  const { writer, runs, lessonsFile, tracked } = setup({
    answers: [{ status: 'done', finalText: 'Kept:\n["Billing queries go through `server/billing/queries.ts`.", "Run tests with npm test."]' }],
    history: historyOf(message, ['thanks', 'The queries are in server/billing/queries.ts, not in the API layer.'], { archived: true }),
    lessons: [{ text: 'Run tests with `npm test`.', at: '2026-10-20T00:00:00Z' }],
  });
  writer.track({ agentId: AGENT, slug: 'csv', repoId: 'widgets', title: 'Ask', message });
  const kept = await writer.ended(AGENT);
  assert.deepEqual(kept, ['Billing queries go through `server/billing/queries.ts`.']);
  assert.equal(runs[0].labels.kind, 'brief-lessons');
  assert.equal(runs[0].workspaceId, 'wks_plan_csv');
  assert.match(runs[0].prompt, /## Follow-ups\n\n1\. thanks\n2\. The queries are in server\/billing\/queries\.ts/);
  assert.doesNotMatch(runs[0].prompt, /## Follow-ups[\s\S]*Why a new index\?/);
  const saved = JSON.parse(fs.readFileSync(lessonsFile, 'utf8'));
  assert.equal(saved.length, 2);
  assert.deepEqual({ ...saved[1], at: undefined }, { text: 'Billing queries go through `server/billing/queries.ts`.', at: undefined, work: 'csv', agentId: AGENT });
  assert.deepEqual(tracked(), []);
});

test('a run with no follow-up is forgotten at its end without a review', async () => {
  const { writer, runs, tracked } = setup({ history: historyOf('first', [], { archived: true }) });
  writer.track({ agentId: AGENT, slug: 'csv', repoId: 'widgets', title: 'Ask', message: 'first' });
  await writer.ended(AGENT);
  assert.equal(runs.length, 0);
  assert.deepEqual(tracked(), []);
});

test('the sweep reviews a run idle for an hour, then only the follow-ups sent after', async () => {
  const { writer, runs, state, tracked, lessonsFile } = setup({
    answers: [{ status: 'done', finalText: '["Fixtures use the acme team."]' }, { status: 'done', finalText: '[]' }],
    history: historyOf('first', ['Use the acme team fixtures.'], { status: 'running' }),
  });
  writer.track({ agentId: AGENT, slug: 'csv', repoId: 'widgets', title: 'Ask', message: 'first' });
  await writer.sweep();
  assert.equal(runs.length, 0);
  state.history = historyOf('first', ['Use the acme team fixtures.'], { updatedAt: new Date(state.now - HOUR / 2).toISOString() });
  await writer.sweep();
  assert.equal(runs.length, 0);
  state.now += HOUR;
  await writer.sweep();
  assert.equal(runs.length, 1);
  assert.equal(tracked()[0].reviewed, 1);
  assert.equal(JSON.parse(fs.readFileSync(lessonsFile, 'utf8')).length, 1);
  state.history = historyOf('first', ['Use the acme team fixtures.', 'Also bob owns billing.'], { archived: true });
  await writer.ended(AGENT);
  assert.match(runs[1].prompt, /## Follow-ups\n\n1\. Also bob owns billing\.\n/);
  assert.deepEqual(tracked(), []);
});

test('a failed review is retried, then given up', async () => {
  const fail = { status: 'error', finalText: '', error: 'boom' };
  const { writer, tracked } = setup({ answers: [fail, fail, fail], history: historyOf('first', ['context'], { archived: true }) });
  writer.track({ agentId: AGENT, slug: 'csv', repoId: 'widgets', title: 'Ask', message: 'first' });
  await assert.rejects(writer.ended(AGENT), /boom/);
  assert.equal(tracked()[0].tries, 1);
  await assert.rejects(writer.ended(AGENT), /boom/);
  await assert.rejects(writer.ended(AGENT), /boom/);
  assert.deepEqual(tracked(), []);
});

test('lessons read from strings or objects, and answers parse leniently', () => {
  const { DATA } = setup({ lessons: ['plain', { text: 'object', at: '2026-10-01' }, { text: '' }, 7] });
  assert.deepEqual(readLessons(DATA, 'widgets').map((l) => l.text), ['plain', 'object']);
  assert.deepEqual(readLessons(DATA, '../x'), []);
  assert.equal(parseLessons('none'), null);
  assert.equal(parseLessons('[oops]'), null);
  assert.deepEqual(parseLessons('Here: ["a", 3, " b "]'), ['a', 'b']);
  assert.equal(cleanBrief('  plain  '), 'plain');
});
