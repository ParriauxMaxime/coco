import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoAgents } from './paseo-agent.ts';
import type { Req, Res } from './core-types.ts';
import type { DaemonAgent, TimelineEvent, WaitResult, WorkspaceEntry } from './paseo-agent.ts';
import { createThreads } from './threads.ts';
import { DEFAULTS } from './config.ts';

type Handler = Parameters<DaemonAgent['timeline']['subscribe']>[0];
type TimelineItem = NonNullable<TimelineEvent['item']>;
type FakeAgent = { id: string; workspaceId: string; status: string; handlers: Set<Handler>; waiters: ((r: WaitResult) => void)[] };
type Created = { id: string; [key: string]: unknown };
type Sent = { agentId: string; text: string; behavior: string | null; busy: boolean };
type ThreadFile = { waiting?: { msgId: string; replyPath: string; earlier?: { msgId: string }[] } | null; messages: { role: string; text: string; blocks?: unknown; steer?: boolean }[]; groupId?: string };
type Activity = { type: string; status?: string; msgId?: string; text?: string };

const APP = '/opt/coco';
const REPO = '/acme/widgets';
const SLUG = 'widgets';
const A = 'c.7.aa11';
const B = 'c.7.bb22';
const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };
const until = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A daemon whose agents work until the test ends their turn; a message to a busy agent joins its turn.
function fakeDaemon() {
  const agents = new Map<string, FakeAgent>();
  const calls: { created: Created[]; worktrees: Record<string, unknown>[]; sent: Sent[] } = { created: [], worktrees: [], sent: [] };
  let seq = 0;
  const agentOf = (id: string) => {
    const a = agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    return a;
  };
  const handle = (a: FakeAgent): DaemonAgent => ({
    id: a.id,
    workspaceId: a.workspaceId,
    get status() {
      return a.status;
    },
    get cwd() {
      return '/wt/cc-group';
    },
    timeline: {
      subscribe: (h) => {
        a.handlers.add(h);
        const unsubscribe = () => void a.handlers.delete(h);
        unsubscribe.ready = Promise.resolve();
        return unsubscribe;
      },
    },
    send: async (text, opts = {}) => {
      calls.sent.push({ agentId: a.id, text, behavior: opts.activeTurnBehavior || null, busy: a.status === 'running' });
      a.status = 'running';
    },
    waitForFinish: () => (a.status === 'running' ? new Promise<WaitResult>((resolve) => a.waiters.push(resolve)) : Promise.resolve({ status: 'idle', lastMessage: null, final: null, error: null })),
    refresh: async () => ({ agent: { status: a.status, archivedAt: null } }),
    archive: async () => ({ archivedAt: 'now' }),
  });
  const workspace = (id: string) => ({
    id,
    agents: {
      create: async (opts: Record<string, unknown>) => {
        const a: FakeAgent = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, workspaceId: id, status: 'idle', handlers: new Set(), waiters: [] };
        agents.set(a.id, a);
        calls.created.push({ ...opts, id: a.id });
        return handle(a);
      },
    },
  });
  const client = {
    workspaces: {
      list: async () => ({ entries: [{ id: 'wks_repo', projectId: 'p1', workspaceDirectory: REPO }] }),
      ref: (w: string | WorkspaceEntry) => workspace(typeof w === 'string' ? w : w.id),
      open: async () => workspace('wks_opened'),
      create: async (opts: Record<string, unknown>) => (calls.worktrees.push(opts), workspace('wks_cc')),
    },
    agents: { ref: (id: string) => handle(agentOf(id)) },
  };
  const emit = (id: string, event: TimelineEvent) => {
    for (const h of agentOf(id).handlers) h({ agentId: id, event });
  };
  const item = (id: string, it: TimelineItem) => emit(id, { type: 'timeline', provider: 'claude', item: it });
  const finish = (id: string) => {
    const a = agentOf(id);
    emit(id, { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: 0.2 } });
    a.status = 'idle';
    for (const wake of a.waiters.splice(0)) wake({ status: 'idle', lastMessage: null, final: null, error: null });
  };
  return { connect: async () => client, calls, item, finish };
}

function setup() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const daemon = fakeDaemon();
  const work = { slug: SLUG, title: 'Widgets', stack: [{ number: 7 }], decisions: [] };
  const comment = (id: string, body: string) => ({ id, path: 'src/widgets.ts', startLine: 3, endLine: 4, side: 'head' as const, snippet: 'const w = null;', ctxBefore: [], ctxAfter: [], body });
  const reviewAgent = { rowPr: async () => ({ number: 7, head: 'feat/widgets', sha: 'abc123', url: '' }), agentsList: async () => [], trailersBetween: async () => [], timeline: () => {}, worktreeFor: async () => null, sameDir: () => false };
  const threads = createThreads({
    DATA,
    REPO,
    config,
    works: { get: (slug: string) => (slug === SLUG ? work : null), list: () => [work], upsertDecision: () => {} },
    comments: { list: () => ({ comments: [comment('aa11', 'Null check missing'), comment('bb22', 'Rename the helper')] }), update: async () => {} },
    reviewAgent,
    reviewPlan: { planOf: () => null },
    exec: async () => ({ ok: false, stdout: '', stderr: '' }),
    agents: createPaseoAgents({ APP, connect: daemon.connect }),
  });
  const file = (key: string) => path.join(DATA, 'works', SLUG, 'threads', `${key}.json`);
  const read = (key: string): ThreadFile => JSON.parse(fs.readFileSync(file(key), 'utf8'));
  const activity = (key: string): Activity[] => {
    const f = path.join(DATA, 'works', SLUG, 'threads', `${key}.activity.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const reply = (p: string, text: string) => fs.writeFileSync(p, JSON.stringify({ blocks: [{ type: 'text', text }] }));
  const post = async (key: string, text: string) => {
    const thread = await threads.post(SLUG, key, { text });
    assert.ok(thread.waiting);
    return { ...thread, waiting: thread.waiting };
  };
  return { threads, post, daemon, read, activity, reply };
}

type Pending = { waiting: { replyPath: string; msgId: string; earlier?: { msgId: string }[] } | null };
const pending = (t: Pending) => {
  assert.ok(t.waiting);
  return t.waiting;
};
const write = (_id: string, file: string, status: string): TimelineItem => ({ type: 'tool_call', callId: `w-${path.basename(file)}`, name: 'Write', detail: { type: 'write', filePath: file }, status, error: null });

test('a group agent answers two findings: a message on one steers its turn, each reply lands on its own finding as it is written', async () => {
  const { post, daemon, read, activity, reply } = setup();
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const agent = daemon.calls.created[0].id;
  assert.deepEqual(daemon.calls.worktrees[0].source, { kind: 'worktree', cwd: REPO, worktreeSlug: `cc-${a1.groupId}`, action: 'branch-off', branchName: `cocopilot/${a1.groupId}`, baseBranch: 'abc123' });

  const b1 = await post(B, 'Rename the helper too');
  await until(() => daemon.calls.sent.length === 2, 'second dispatch');
  assert.equal(b1.groupId, a1.groupId);
  assert.equal(daemon.calls.created.length, 1);
  assert.deepEqual(daemon.calls.sent.map((s) => [s.agentId, s.behavior, s.busy]), [[agent, 'steer', false], [agent, 'steer', true]]);
  assert.match(daemon.calls.sent[1].text, /review comment on src\/widgets\.ts:3-4/);

  daemon.item(agent, { type: 'reasoning', text: 'both on widgets.ts' });
  daemon.item(agent, { type: 'tool_call', callId: 'b1', name: 'Bash', detail: { type: 'shell', command: 'npm test' }, status: 'running', error: null });
  daemon.item(agent, { type: 'tool_call', callId: 'b1', name: 'Bash', detail: { type: 'shell', command: 'npm test', output: 'ok' }, status: 'completed', error: null });
  reply(a1.waiting.replyPath, 'Null check added.');
  daemon.item(agent, write(agent, a1.waiting.replyPath, 'completed'));
  await until(() => !read(A).waiting, 'reply on A');

  assert.deepEqual(read(A).messages.map((m) => [m.role, m.text]), [['user', 'Add the null check'], ['agent', 'Null check added.']]);
  assert.deepEqual(read(A).messages[1].blocks, [{ type: 'text', text: 'Null check added.' }]);
  assert.ok(read(B).waiting, 'B still waits on the same turn');
  assert.deepEqual(activity(A).map((e) => [e.type, e.status || '']), [['think', ''], ['tool', 'running'], ['tool', 'completed'], ['tool', 'completed']]);
  assert.deepEqual(activity(B).map((e) => [e.type, e.status || '']), [['think', ''], ['tool', 'running'], ['tool', 'completed']]);
  assert.ok(activity(A).every((e) => e.msgId === a1.waiting.msgId));

  const a2 = await post(A, 'Also cover undefined');
  await until(() => daemon.calls.sent.length === 3, 'follow-up on A');
  assert.deepEqual([daemon.calls.sent[2].behavior, daemon.calls.sent[2].busy], ['steer', true]);
  assert.match(daemon.calls.sent[2].text, /^# cocopilot · follow-up on the comment on src\/widgets\.ts:3/);
  assert.ok(read(B).waiting, 'the follow-up on A did not end the reply on B');

  reply(b1.waiting.replyPath, 'Renamed.');
  daemon.item(agent, write(agent, b1.waiting.replyPath, 'completed'));
  await until(() => !read(B).waiting, 'reply on B');
  assert.equal(read(B).messages.at(-1)?.text, 'Renamed.');
  assert.ok(read(A).waiting);

  reply(a2.waiting.replyPath, 'Undefined covered.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  assert.deepEqual(read(A).messages.map((m) => [m.role, m.text]), [['user', 'Add the null check'], ['agent', 'Null check added.'], ['user', 'Also cover undefined'], ['agent', 'Undefined covered.']]);
  assert.equal(activity(A).at(-1)?.type, 'end');
  assert.equal(activity(A).at(-1)?.msgId, a2.waiting.msgId);
});

test('a second message on a thread while its agent works is delivered mid-turn, shown at once, and both replies land', async () => {
  const { post, daemon, read, reply } = setup();
  const first = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  const second = await post(A, 'Use optional chaining instead');
  await until(() => daemon.calls.sent.length === 2, 'steer');

  assert.deepEqual([daemon.calls.sent[1].behavior, daemon.calls.sent[1].busy], ['steer', true]);
  assert.match(daemon.calls.sent[1].text, /sent while you were still on the previous one/);
  assert.ok(daemon.calls.sent[1].text.includes(second.waiting.replyPath));
  assert.deepEqual(second.messages.map((m) => [m.text, Boolean(m.steer)]), [['Add the null check', false], ['Use optional chaining instead', true]]);
  assert.deepEqual(second.waiting.earlier?.map((e) => e.msgId), [first.waiting.msgId]);

  reply(first.waiting.replyPath, 'Added a null check.');
  daemon.item(agent, write(agent, first.waiting.replyPath, 'completed'));
  await until(() => read(A).messages.length === 3, 'first reply');
  assert.ok(read(A).waiting, 'still waiting on the latest message');
  assert.deepEqual(read(A).waiting?.earlier, []);

  reply(second.waiting.replyPath, 'Switched to optional chaining.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  assert.deepEqual(read(A).messages.filter((m) => m.role === 'agent').map((m) => m.text), ['Added a null check.', 'Switched to optional chaining.']);
});

test('the thread stream replays the stored activity, then live deltas and a ping on every change; deltas are not stored', async () => {
  const { threads, post, daemon, activity } = setup();
  const sent = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  daemon.item(agent, { type: 'tool_call', callId: 'b1', name: 'Bash', detail: { type: 'shell', command: 'npm test', output: 'ok' }, status: 'completed', error: null });

  const seen: Activity[] = [];
  const req = { method: 'GET', url: `/api/works/${SLUG}/threads/${A}/events`, on: () => {} } as unknown as Req;
  const res = { writeHead: () => {}, write: (chunk: string) => seen.push(JSON.parse(chunk.slice('data: '.length))) } as unknown as Res;
  await threads.handle(req, res, ['works', SLUG, 'threads', A, 'events'], async () => '', () => assert.fail('no JSON answer on the stream'));
  assert.deepEqual(seen.map((e) => [e.type, e.msgId]), [['tool', sent.waiting.msgId]]);

  daemon.item(agent, { type: 'assistant_message', text: 'Adding ', messageId: 'm1' });
  await until(() => seen.some((e) => e.type === 'delta'), 'live delta');
  daemon.item(agent, { type: 'assistant_message', text: 'it.', messageId: 'm1' });
  daemon.finish(agent);
  await until(() => seen.some((e) => e.type === 'thread'), 'thread ping');
  assert.deepEqual(activity(A).map((e) => e.type), ['tool', 'text', 'end']);
  assert.equal(activity(A)[1].text, 'Adding it.');
});
