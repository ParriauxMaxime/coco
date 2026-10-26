import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissions, parseResponse, whereOf } from './permissions.ts';
import type { AgentListObserver, AgentSnapshot, PermissionClient, PermissionRequest, PermissionResponse } from './permissions.ts';
import { activityEvents } from './paseo-agent.ts';
import type { ActivityEvent } from './paseo-agent.ts';
import { answerSummary, buildAnswers, parseQuestions, questionResponse } from '../src/components/permission.ts';
import { groupActivity } from '../src/components/activity.ts';

const question: PermissionRequest = {
  id: 'permission-q1',
  name: 'AskUserQuestion',
  kind: 'question',
  title: 'Which items do you want to work on?',
  input: {
    questions: [
      { question: 'Which items do you want to work on?', header: 'Items', multiSelect: true, allowOther: true, options: [{ label: 'widgets', description: 'the widgets export' }, { label: 'gadgets' }] },
      { question: 'How deep should the review go?', header: 'Depth', multiSelect: false, allowOther: true, options: [{ label: 'quick' }, { label: 'thorough' }] },
    ],
  },
};
const bash: PermissionRequest = { id: 'permission-t1', name: 'Bash', kind: 'tool', input: { command: 'rm -rf build' }, detail: { type: 'shell', command: 'rm -rf build' } };
const agent = (id: string, extra: Partial<AgentSnapshot> = {}): AgentSnapshot => ({ id, title: `coco · ${id}`, labels: { source: 'cocopilot' }, pendingPermissions: [], ...extra });

// Paseo's live agent list behind the SDK surface the registry uses: a first page, then pushed updates; answers are recorded
function fakePaseo(first: AgentSnapshot[], { keepPending = false } = {}) {
  let observer: AgentListObserver | null = null;
  const answered: { agentId: string; requestId: string; response: PermissionResponse }[] = [];
  const listed: Record<string, unknown>[] = [];
  const push = (payload: unknown) => observer?.update({ type: 'agent_update', payload });
  const client: PermissionClient = {
    agents: {
      list: async (opts) => (listed.push(opts), { entries: first.map((a) => ({ agent: a })), subscription: { subscribe: (o) => ((observer = o), () => {}) } }),
      ref: (agentId) => ({
        respondToPermission: async ({ requestId, response }) => {
          answered.push({ agentId, requestId, response });
          if (!keepPending) setTimeout(() => push({ kind: 'upsert', agent: agent(agentId, { pendingPermissions: [] }) }), 5);
        },
      }),
    },
  };
  return { client: async () => client, push, answered, listed };
}

test('the registry lists the requests of coco agents only, follows Paseo updates and tells watchers when the set changes', async () => {
  const paseo = fakePaseo([
    agent('a1', { pendingPermissions: [question] }),
    agent('a2', { title: 'by hand', labels: {}, pendingPermissions: [bash] }),
    agent('a3', { archivedAt: '2026-01-01', pendingPermissions: [bash] }),
    agent('a4', { title: 'Morning review', labels: { source: 'cockpit' }, pendingPermissions: [bash] }),
  ]);
  const p = createPermissions({ client: paseo.client, locate: (a) => ({ label: a.id, href: `#/x/${a.id}` }) });
  await p.boot();
  assert.deepEqual(paseo.listed[0].filter, { includeBackground: true });
  assert.deepEqual(p.list().map((x) => [x.agentId, x.request.id, x.where?.href]), [['a1', 'permission-q1', '#/x/a1'], ['a4', 'permission-t1', '#/x/a4']]);
  let changes = 0;
  p.onChange(() => changes++);
  paseo.push({ kind: 'upsert', agent: agent('a1', { pendingPermissions: [question] }) });
  assert.equal(changes, 0);
  paseo.push({ kind: 'upsert', agent: agent('a1', { pendingPermissions: [] }) });
  paseo.push({ kind: 'remove', agentId: 'a4' });
  paseo.push({ kind: 'upsert', agent: agent('a5', { pendingPermissions: [bash] }) });
  assert.equal(changes, 3);
  assert.deepEqual(p.list().map((x) => x.agentId), ['a5']);
});

test('an answer goes to Paseo and resolves once Paseo drops the request; a request no longer pending, or one Paseo keeps, is an error', async () => {
  const paseo = fakePaseo([agent('a1', { pendingPermissions: [question] })]);
  const p = createPermissions({ client: paseo.client, waitMs: 200 });
  await p.boot();
  const response = questionResponse(question, { Items: 'widgets' });
  assert.deepEqual(await p.respond('a1', 'permission-q1', response), { ok: true });
  assert.deepEqual(paseo.answered, [{ agentId: 'a1', requestId: 'permission-q1', response }]);
  await assert.rejects(p.respond('a1', 'permission-q1', response), (e: { status: number }) => e.status === 404);

  const stuck = fakePaseo([agent('a1', { pendingPermissions: [bash] })], { keepPending: true });
  const q = createPermissions({ client: stuck.client, waitMs: 30 });
  await q.boot();
  await assert.rejects(q.respond('a1', 'permission-t1', { behavior: 'allow' }), (e: { status: number }) => e.status === 502);
});

test('an answer body is reduced to what Paseo takes', () => {
  assert.deepEqual(parseResponse({ behavior: 'allow', updatedInput: { answers: { Items: 'widgets' } }, extra: 1 }), { behavior: 'allow', updatedInput: { answers: { Items: 'widgets' } } });
  assert.deepEqual(parseResponse({ behavior: 'deny', selectedActionId: 'reject', message: 'not now' }), { behavior: 'deny', selectedActionId: 'reject', message: 'not now' });
  assert.throws(() => parseResponse({ behavior: 'maybe' }), /behavior/);
  assert.throws(() => parseResponse({ behavior: 'allow', updatedInput: 'widgets' }), /updatedInput/);
});

test('a request links to the coco page showing its agent', () => {
  const deps = { askOf: (id: string) => (id === 'ask1' ? { id: 'c1', kind: 'ask', scope: { kind: 'global' as const } } : null), groupKind: () => 'decision', workTitle: () => 'Widgets export' };
  assert.deepEqual(whereOf(agent('ask1'), deps), { label: 'Ask coco', href: '#/ask/c1' });
  assert.deepEqual(whereOf(agent('r1', { labels: { source: 'cocopilot', kind: 'review', run: 'ab12', work: 'widgets' } }), deps), { label: 'Review run · Widgets export', href: '#/work/widgets/agent-ab12' });
  assert.deepEqual(whereOf(agent('g1', { labels: { source: 'cocopilot', kind: 'cc-group', group: 'a1b2c3', work: 'widgets' } }), deps), { label: 'Thread · Widgets export', href: '#/work/widgets/decisions' });
  assert.equal(whereOf(agent('x1'), deps), null);
});

test('question answers follow Paseo: keyed by header, labels joined, Other replacing a single choice and joining a multiple one', () => {
  const qs = parseQuestions(question.input);
  assert.ok(qs);
  assert.deepEqual(buildAnswers(qs, [[0, 1], [1]], ['', '']), { Items: 'widgets, gadgets', Depth: 'thorough' });
  assert.deepEqual(buildAnswers(qs, [[0], [1]], ['bolts', 'just the diff']), { Items: 'widgets, bolts', Depth: 'just the diff' });
  const response = questionResponse(question, { Items: 'widgets' });
  assert.deepEqual(response, { behavior: 'allow', updatedInput: { ...question.input, answers: { Items: 'widgets' } } });
  assert.equal(answerSummary(question, response), 'Items: widgets');
  assert.equal(answerSummary({ ...bash, actions: [{ id: 'reject', label: 'Reject', behavior: 'deny' }] }, { behavior: 'deny', selectedActionId: 'reject' }), 'Reject');
});

test('a permission is kept in the activity log with its agent, long inputs cut, and its answer joins it in the activity', () => {
  const kept: ActivityEvent[] = [];
  const stream = activityEvents({ keep: (e) => kept.push(e), live: () => {} });
  stream.onPermission({ type: 'permission', agentId: 'a1', request: { ...bash, input: { content: 'x'.repeat(5000) } } });
  stream.onPermission({ type: 'permission_resolved', agentId: 'a1', requestId: 'permission-t1', resolution: { behavior: 'allow' } });
  assert.equal(kept[0].agentId, 'a1');
  assert.ok(String(kept[0].request?.input?.content).length < 2100);
  const items = groupActivity([{ type: 'text', text: 'Cleaning up.' }, kept[0] as never, kept[1] as never]);
  assert.deepEqual(items.map((it) => (it.kind === 'permission' ? [it.kind, it.resolution] : [it.kind])), [['event'], ['permission', { behavior: 'allow' }]]);
});
