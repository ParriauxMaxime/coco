import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoAgents } from './paseo-agent.ts';
import { createThreads } from './threads.ts';
import { DEFAULTS } from './config.ts';

const APP = '/opt/coco';
const REPO = '/acme/widgets';
const SLUG = 'widgets';
const A = 'c.7.aa11';
const B = 'c.7.bb22';
const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };
const until = async (cond, what = 'condition') => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A daemon whose agents work until the test ends their turn; a message to a busy agent joins its turn.
function fakeDaemon() {
  const agents = new Map();
  const calls = { created: [], worktrees: [], sent: [] };
  let seq = 0;
  const handle = (a) => ({
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
        const unsubscribe = () => a.handlers.delete(h);
        unsubscribe.ready = Promise.resolve();
        return unsubscribe;
      },
    },
    send: async (text, opts = {}) => {
      calls.sent.push({ agentId: a.id, text, behavior: opts.activeTurnBehavior || null, busy: a.status === 'running' });
      a.status = 'running';
    },
    waitForFinish: () => (a.status === 'running' ? new Promise((resolve) => a.waiters.push(resolve)) : Promise.resolve({ status: 'idle', lastMessage: null, final: null, error: null })),
    refresh: async () => ({ agent: { id: a.id, status: a.status, archivedAt: null } }),
    archive: async () => ({ archivedAt: 'now' }),
  });
  const workspace = (id) => ({
    id,
    agents: {
      create: async (opts) => {
        const a = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, workspaceId: id, status: 'idle', handlers: new Set(), waiters: [] };
        agents.set(a.id, a);
        calls.created.push({ ...opts, id: a.id });
        return handle(a);
      },
    },
  });
  const client = {
    workspaces: {
      list: async () => ({ entries: [{ id: 'wks_repo', projectId: 'p1', workspaceDirectory: REPO }] }),
      ref: (w) => workspace(typeof w === 'string' ? w : w.id),
      create: async (opts) => (calls.worktrees.push(opts), workspace('wks_cc')),
    },
    agents: { ref: (id) => handle(agents.get(id)) },
  };
  const emit = (id, event) => {
    for (const h of agents.get(id).handlers) h({ agentId: id, event });
  };
  const item = (id, it) => emit(id, { type: 'timeline', provider: 'claude', item: it });
  const finish = (id) => {
    const a = agents.get(id);
    emit(id, { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: 0.2 } });
    a.status = 'idle';
    for (const wake of a.waiters.splice(0)) wake({ status: 'idle', lastMessage: null, final: null, error: null });
  };
  return { connect: async () => client, calls, item, finish };
}

function setup() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const daemon = fakeDaemon();
  const work = { slug: SLUG, stack: [{ number: 7 }], decisions: [] };
  const comment = (id, body) => ({ id, path: 'src/widgets.ts', startLine: 3, endLine: 4, side: 'head', snippet: 'const w = null;', body });
  const reviewAgent = { rowPr: async () => ({ number: 7, head: 'feat/widgets', sha: 'abc123', url: '' }), agentsList: async () => [], trailersBetween: async () => [], timeline: () => {}, worktreeFor: async () => null, sameDir: () => false };
  const threads = createThreads({
    DATA,
    REPO,
    config,
    works: { get: (slug) => (slug === SLUG ? work : null), list: () => [work] },
    comments: { list: () => ({ comments: [comment('aa11', 'Null check missing'), comment('bb22', 'Rename the helper')] }), update: async () => {} },
    reviewAgent,
    reviewPlan: { planOf: () => null },
    exec: async () => ({ ok: false, stdout: '', stderr: '' }),
    agents: createPaseoAgents({ APP, connect: daemon.connect }),
  });
  const file = (key) => path.join(DATA, 'works', SLUG, 'threads', `${key}.json`);
  const read = (key) => JSON.parse(fs.readFileSync(file(key), 'utf8'));
  const activity = (key) => {
    const f = path.join(DATA, 'works', SLUG, 'threads', `${key}.activity.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const reply = (p, text) => fs.writeFileSync(p, JSON.stringify({ blocks: [{ type: 'text', text }] }));
  return { threads, daemon, read, activity, reply };
}

const write = (id, file, status) => ({ type: 'tool_call', callId: `w-${path.basename(file)}`, name: 'Write', detail: { type: 'write', filePath: file }, status, error: null });

test('a group agent answers two findings: a message on one steers its turn, each reply lands on its own finding as it is written', async () => {
  const { threads, daemon, read, activity, reply } = setup();
  const a1 = await threads.post(SLUG, A, { text: 'Add the null check' });
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const agent = daemon.calls.created[0].id;
  assert.deepEqual(daemon.calls.worktrees[0].source, { kind: 'worktree', cwd: REPO, worktreeSlug: `cc-${a1.groupId}`, action: 'branch-off', branchName: `cocopilot/${a1.groupId}`, baseBranch: 'abc123' });

  const b1 = await threads.post(SLUG, B, { text: 'Rename the helper too' });
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

  const a2 = await threads.post(SLUG, A, { text: 'Also cover undefined' });
  await until(() => daemon.calls.sent.length === 3, 'follow-up on A');
  assert.deepEqual([daemon.calls.sent[2].behavior, daemon.calls.sent[2].busy], ['steer', true]);
  assert.match(daemon.calls.sent[2].text, /^# cocopilot · follow-up on the comment on src\/widgets\.ts:3/);
  assert.ok(read(B).waiting, 'the follow-up on A did not end the reply on B');

  reply(b1.waiting.replyPath, 'Renamed.');
  daemon.item(agent, write(agent, b1.waiting.replyPath, 'completed'));
  await until(() => !read(B).waiting, 'reply on B');
  assert.equal(read(B).messages.at(-1).text, 'Renamed.');
  assert.ok(read(A).waiting);

  reply(a2.waiting.replyPath, 'Undefined covered.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  assert.deepEqual(read(A).messages.map((m) => [m.role, m.text]), [['user', 'Add the null check'], ['agent', 'Null check added.'], ['user', 'Also cover undefined'], ['agent', 'Undefined covered.']]);
  assert.equal(activity(A).at(-1).type, 'end');
  assert.equal(activity(A).at(-1).msgId, a2.waiting.msgId);
});

test('a second message on a thread while its agent works is delivered mid-turn, shown at once, and both replies land', async () => {
  const { threads, daemon, read, reply } = setup();
  const first = await threads.post(SLUG, A, { text: 'Add the null check' });
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  const second = await threads.post(SLUG, A, { text: 'Use optional chaining instead' });
  await until(() => daemon.calls.sent.length === 2, 'steer');

  assert.deepEqual([daemon.calls.sent[1].behavior, daemon.calls.sent[1].busy], ['steer', true]);
  assert.match(daemon.calls.sent[1].text, /sent while you were still on the previous one/);
  assert.ok(daemon.calls.sent[1].text.includes(second.waiting.replyPath));
  assert.deepEqual(second.messages.map((m) => [m.text, Boolean(m.steer)]), [['Add the null check', false], ['Use optional chaining instead', true]]);
  assert.deepEqual(second.waiting.earlier.map((e) => e.msgId), [first.waiting.msgId]);

  reply(first.waiting.replyPath, 'Added a null check.');
  daemon.item(agent, write(agent, first.waiting.replyPath, 'completed'));
  await until(() => read(A).messages.length === 3, 'first reply');
  assert.ok(read(A).waiting, 'still waiting on the latest message');
  assert.deepEqual(read(A).waiting.earlier, []);

  reply(second.waiting.replyPath, 'Switched to optional chaining.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  assert.deepEqual(read(A).messages.filter((m) => m.role === 'agent').map((m) => m.text), ['Added a null check.', 'Switched to optional chaining.']);
});

test('the thread stream replays the stored activity, then live deltas and a ping on every change; deltas are not stored', async () => {
  const { threads, daemon, activity } = setup();
  const sent = await threads.post(SLUG, A, { text: 'Add the null check' });
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  daemon.item(agent, { type: 'tool_call', callId: 'b1', name: 'Bash', detail: { type: 'shell', command: 'npm test', output: 'ok' }, status: 'completed', error: null });

  const seen = [];
  const req = { method: 'GET', url: `/api/works/${SLUG}/threads/${A}/events`, on: () => {} };
  const res = { writeHead: () => {}, write: (chunk) => seen.push(JSON.parse(chunk.slice('data: '.length))) };
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
