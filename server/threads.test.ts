import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoAgents } from './paseo-agent.ts';
import type { Req, Res } from './core-types.ts';
import type { DaemonAgent, TimelineEvent, WaitResult, WorkspaceEntry } from './paseo-agent.ts';
import { createThreads } from './threads.ts';
import { createCards } from './cards.ts';
import { createUploads } from './uploads.ts';
import type { Uploads } from './uploads.ts';
import { DEFAULTS } from './config.ts';
import { briefLines } from './agent-worktree.ts';
import type { Readiness, Verification } from './agent-worktree.ts';

type Handler = Parameters<DaemonAgent['timeline']['subscribe']>[0];
type TimelineItem = NonNullable<TimelineEvent['item']>;
type FakeAgent = { id: string; workspaceId: string; status: string; handlers: Set<Handler>; waiters: ((r: WaitResult) => void)[] };
type Created = { id: string; [key: string]: unknown };
type Sent = { agentId: string; text: string; behavior: string | null; busy: boolean; images?: unknown[]; attachments?: { fileName: string }[] };
type ThreadFile = { waiting?: { msgId: string; replyPath: string; earlier?: { msgId: string }[] } | null; messages: { id: string; role: string; text: string; model?: string; blocks?: unknown; steer?: boolean; card?: string; files?: { fileName: string }[]; suggestion?: { checks?: { state: string } } }[]; groupId?: string };
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
      calls.sent.push({ agentId: a.id, text, behavior: opts.activeTurnBehavior || null, busy: a.status === 'running', images: opts.images, attachments: opts.attachments });
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

function setup(uploads?: Uploads, worktrees?: Parameters<typeof createThreads>[0]['worktrees'], trailers: () => { id: string; commit: string }[] = () => [], models?: Parameters<typeof createThreads>[0]['models']) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const daemon = fakeDaemon();
  const work = { slug: SLUG, title: 'Widgets', stack: [{ number: 7 }], decisions: [{ id: 'd1', title: 'Cache or not', options: [{ key: 'cache', label: 'Cache' }, { key: 'none', label: 'No cache' }] }] };
  const decided: { id: string; choice: string; rationale: string }[] = [];
  const comment = (id: string, body: string) => ({ id, path: 'src/widgets.ts', startLine: 3, endLine: 4, side: 'head' as const, snippet: 'const w = null;', ctxBefore: [], ctxAfter: [], body });
  const reviewAgent = { rowPr: async () => ({ number: 7, head: 'feat/widgets', sha: 'abc123', url: '' }), agentsList: async () => [], trailersBetween: async () => trailers(), timeline: () => {}, worktreeFor: async () => null, sameDir: () => false };
  const threads = createThreads({
    DATA,
    REPO,
    config,
    works: { get: (slug: string) => (slug === SLUG ? work : null), list: () => [work], upsertDecision: () => {}, decide: (_slug, input) => (work.decisions[0].options.some((o) => o.key === input.choice) ? decided.push(input) : null) },
    comments: { list: () => ({ comments: [comment('aa11', 'Null check missing'), comment('bb22', 'Rename the helper')] }), update: async () => {} },
    reviewAgent,
    reviewPlan: { planOf: () => null },
    exec: async () => ({ ok: false, stdout: '', stderr: '' }),
    agents: createPaseoAgents({ APP, connect: daemon.connect }),
    uploads,
    worktrees,
    models,
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
  return { threads, post, daemon, read, activity, reply, decided };
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

const cardsFor = (threads: ReturnType<typeof setup>['threads']) => createCards({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'thread-cards-')), place: async () => ({ work: SLUG, pr: '7' }), deliver: async () => assert.fail('a thread card goes through its thread'), threads: threads.cardHook });
const choiceCard = (agentId: string, options: Record<string, unknown>[], thread?: string) => ({ agentId, kind: 'choice', title: 'Which way?', options, ...(thread ? { thread } : {}) });

test('a thread card option that leaves the code dismisses the finding without a new turn; any other answer goes to the agent through the thread', async () => {
  const { threads, post, daemon, read, reply } = setup();
  const acted: { id: string; action: string; reason: string }[] = [];
  threads.setFindingActor(async (_slug, _n, id, a) => void acted.push({ id, ...a }));
  const cards = cardsFor(threads);
  const a = await post(A, 'Which way?');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  assert.match(daemon.calls.sent[0].text, /thread: "c\.7\.aa11"/);
  assert.match(daemon.calls.sent[0].text, /"dismiss_finding"/);
  const keep = { key: 'keep', label: 'Keep the read unscoped', effect: { type: 'dismiss_finding' } };
  const scope = { key: 'scope', label: 'Scope the read' };

  await assert.rejects(cards.create(choiceCard(agent, [{ ...scope, effect: { type: 'take_decision', option: 'cache' } }, keep])), /options\[0\]\.effect: take_decision is only for a decision thread/);
  await assert.rejects(cards.create(choiceCard('22222222-0000-4000-8000-000000000000', [keep, scope], A)), /not a thread of this agent/);
  const onA = await cards.create(choiceCard(agent, [keep, scope]));
  assert.equal(onA.thread, A, 'the one thread waiting on the agent');
  reply(a.waiting.replyPath, 'Keep it or scope it?');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'reply');

  const kept = await cards.answer(onA.id, { picked: ['keep'] });
  await until(() => acted.length === 1, 'dismiss');
  assert.deepEqual(acted, [{ id: 'aa11', action: 'dismiss', reason: 'Picked Keep the read unscoped' }]);
  assert.deepEqual([kept.result?.ok, kept.delivery?.skipped], [true, true]);
  assert.equal(daemon.calls.sent.length, 1);
  const note = read(A).messages.at(-1);
  assert.deepEqual([note?.role, note?.card], ['system', onA.id]);

  await post(B, 'And the helper?');
  await until(() => daemon.calls.sent.length === 2, 'dispatch on B');
  const onB = await cards.create(choiceCard(agent, [keep, scope], B));
  const answered = await cards.answer(onB.id, { picked: ['scope'] });
  assert.equal(answered.delivery?.ok, true);
  assert.equal(answered.result, undefined);
  await until(() => daemon.calls.sent.length === 3, 'the answer reaches the agent');
  assert.match(daemon.calls.sent[2].text, /\[coco card \w+ answered\] Which way\?\nPicked: Scope the read/);
  const last = read(B).messages.at(-1);
  assert.deepEqual([last?.role, last?.card, last?.steer], ['user', onB.id, true]);
  assert.equal(acted.length, 1);
});

test('a thread card option taking a decision card option takes it without a new turn; an option the card lacks is refused', async () => {
  const { threads, post, daemon, read, decided } = setup();
  const cards = cardsFor(threads);
  const D = 'd.d1';
  await post(D, 'Cache it?');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  assert.match(daemon.calls.sent[0].text, /"take_decision", "option": "<card option key>"/);
  const agent = daemon.calls.created[0].id;
  const cache = { key: 'a', label: 'Cache for 5 min', effect: { type: 'take_decision', option: 'cache' } };

  await assert.rejects(cards.create(choiceCard(agent, [cache, { key: 'b', label: 'Bogus', effect: { type: 'take_decision', option: 'nope' } }], D)), /options\[1\]\.effect\.option: the decision has no option "nope"/);
  await assert.rejects(cards.create(choiceCard(agent, [cache, { key: 'b', label: 'Drop it', effect: { type: 'dismiss_finding' } }], D)), /dismiss_finding is only for a finding thread/);
  const card = await cards.create(choiceCard(agent, [cache, { key: 'b', label: 'Ask the team' }], D));
  const answered = await cards.answer(card.id, { picked: ['a'] });
  assert.deepEqual(decided, [{ id: 'd1', choice: 'cache', rationale: 'Picked Cache for 5 min' }]);
  assert.deepEqual([answered.result?.detail, answered.delivery?.skipped], ['Decision taken: cache', true]);
  assert.equal(daemon.calls.sent.length, 1);
  assert.deepEqual(read(D).messages.slice(-1).map((m) => [m.role, m.text]), [['system', 'Decision taken: cache.']]);
});

test('files sent on a thread go to the agent as images and attachments and stay on the message', async () => {
  const uploads = createUploads({ DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'thread-uploads-')) });
  const { threads, daemon, read } = setup(uploads);
  const png = uploads.store('shot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]));
  const log = uploads.store('run.log', 'text/plain', Buffer.from('boom'));
  const t = await threads.post(SLUG, A, { attachments: [png.id, log.id] });
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const sent = daemon.calls.sent[0];
  assert.deepEqual([sent.images?.length, sent.attachments?.map((x) => x.fileName)], [1, ['run.log']]);
  assert.equal(t.messages[0].text, 'See the attached files.');
  assert.deepEqual(read(A).messages[0].files?.map((f) => f.fileName), ['shot.png', 'run.log']);
});

test('a code group readies its worktree before every turn: the first prompt names the checks, a follow-up repeats them only once they changed', async () => {
  const states: Readiness[] = [
    { state: 'failed', root: '/wt/cc-group', deps: [{ path: 'node_modules', mode: 'missing', note: 'the main checkout has no node_modules' }], checks: [{ id: 'lint', label: 'Lint', command: 'lint <changed files>', available: false, why: 'the main checkout has no node_modules' }] },
    { state: 'ready', root: '/wt/cc-group', deps: [{ path: 'node_modules', mode: 'linked' }], checks: [{ id: 'lint', label: 'Lint', command: 'lint <changed files>', available: true }] },
  ];
  const prepared: string[] = [];
  const waiting: [string, string][] = [];
  const { post, daemon, read, reply } = setup(undefined, {
    prepare: async (root) => (prepared.push(root), states[Math.min(prepared.length - 1, 1)]),
    whenReady: (root, agentId) => void waiting.push([root, agentId]),
    briefLines: (r) => briefLines(r),
  });
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const agent = daemon.calls.created[0].id;
  assert.deepEqual(prepared, ['/wt/cc-group']);
  assert.deepEqual(waiting, [['/wt/cc-group', agent]]);
  assert.match(daemon.calls.sent[0].text, /## Your worktree and its checks[\s\S]*Not available yet: Lint \(the main checkout has no node_modules\)/);

  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  await post(A, 'Also cover undefined');
  await until(() => daemon.calls.sent.length === 2, 'follow-up');
  assert.match(daemon.calls.sent[1].text, /## Changed since: Your worktree and its checks[\s\S]*Lint: `lint <changed files>`/);
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'second turn end');
  await post(A, 'One more thing');
  await until(() => daemon.calls.sent.length === 3, 'third turn');
  assert.doesNotMatch(daemon.calls.sent[2].text, /worktree and its checks/);
  assert.equal(prepared.length, 3, 'readied on every turn');
});

test("coco checks a suggested commit: a failure goes back to the agent once, a second failing commit waits on the owner, the owner's message re-arms it", async () => {
  const ready: Readiness = { state: 'ready', root: '/wt/cc-group', deps: [], checks: [{ id: 'lint', label: 'Lint', command: 'lint <changed files>', available: true }] };
  let commit = 'c0ffee1';
  const verified: [string, string, string][] = [];
  const failing = (head: string): Verification => ({ state: 'failed', at: 'now', head, files: ['src/widgets.ts'], results: [{ id: 'lint', label: 'Lint', state: 'failed', command: 'lint src/widgets.ts', output: 'no-unused-vars at src/widgets.ts:3' }] });
  const { post, daemon, read, reply } = setup(undefined, {
    prepare: async () => ready,
    whenReady: () => {},
    briefLines: (r) => briefLines(r),
    verify: async (root, { base, head }) => (verified.push([root, base, head]), failing(head)),
  }, () => [{ id: 'aa11', commit }]);
  const checksOf = () => read(A).messages.findLast((m) => m.suggestion)?.suggestion?.checks;

  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const agent = daemon.calls.created[0].id;
  reply(a1.waiting.replyPath, 'Added.');
  daemon.finish(agent);
  await until(() => daemon.calls.sent.length === 2, 'the failure sent back');
  assert.deepEqual(verified[0], ['/wt/cc-group', 'c0ffee1^', 'c0ffee1']);
  assert.equal(checksOf()?.state, 'failed');
  assert.match(daemon.calls.sent[1].text, /coco re-ran the checks on your commit for this comment \(c0ffee1\): Lint failed[\s\S]*no-unused-vars[\s\S]*Cc-Comment: aa11/);

  commit = 'c0ffee2';
  fs.writeFileSync(read(A).waiting!.replyPath, JSON.stringify({ blocks: [{ type: 'text', text: 'Fixed.' }] }));
  daemon.finish(agent);
  await until(() => read(A).messages.some((m) => m.role === 'system' && /still fail on c0ffee2/.test(m.text)), 'the second failure noted');
  assert.equal(daemon.calls.sent.length, 2, 'sent back only once');
  assert.equal(checksOf()?.state, 'failed');

  commit = 'c0ffee3';
  const a3 = await post(A, 'Try again');
  await until(() => daemon.calls.sent.length === 3, 'owner message');
  reply(a3.waiting.replyPath, 'Again.');
  daemon.finish(agent);
  await until(() => daemon.calls.sent.length === 4, 'sent back again after the owner spoke');
});

test('a thread’s first message starts its group agent on the picked model and thinking, checked first; the sonnet shorthand keeps the fast model', async () => {
  const checked: unknown[] = [];
  const models = { check: async (pick: { provider?: unknown; thinking?: unknown }, fallback?: string | null) => {
    checked.push([pick, fallback]);
    if (pick.provider === 'claude/nope') throw new Error('unknown model claude/nope');
    return { ...(pick.provider ? { provider: String(pick.provider) } : {}), ...(pick.thinking ? { thinking: String(pick.thinking) } : {}) };
  } };
  const { threads, daemon, read } = setup(undefined, undefined, undefined, models);
  await assert.rejects(threads.post(SLUG, A, { text: 'Fix it', model: 'claude/nope' }), /unknown model claude\/nope/);
  await threads.post(SLUG, A, { text: 'Fix it', model: 'claude/claude-opus-5-5', thinking: 'max' });
  await threads.post(SLUG, 'd.d1', { text: 'Which one?', model: 'sonnet' });
  await until(() => daemon.calls.created.length === 2, 'two group agents');
  const configs = daemon.calls.created.map((c) => c.config as Record<string, unknown>);
  assert.deepEqual(configs.map((c) => [c.provider, c.thinkingOptionId]), [['claude/claude-opus-5-5', 'max'], [config.models.fast, 'high']]);
  assert.equal(read(A).messages[0].model, 'claude/claude-opus-5-5');
  assert.equal(checked.length, 2);
});
