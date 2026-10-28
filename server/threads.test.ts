import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoAgents } from './paseo-agent.ts';
import type { Exec, Req, Res } from './core-types.ts';
import type { DaemonAgent, TimelineEvent, WaitResult, WorkspaceEntry } from './paseo-agent.ts';
import { createThreads } from './threads.ts';
import { createCards } from './cards.ts';
import { createUploads } from './uploads.ts';
import type { Uploads } from './uploads.ts';
import { DEFAULTS } from './config.ts';
import { briefLines, readyText } from './agent-worktree.ts';
import { commentIdsOf, parseCommitLog } from './review-agent.ts';
import type { Readiness, Verification } from './agent-worktree.ts';

type Handler = Parameters<DaemonAgent['timeline']['subscribe']>[0];
type TimelineItem = NonNullable<TimelineEvent['item']>;
type FakeAgent = { id: string; workspaceId: string; status: string; handlers: Set<Handler>; waiters: ((r: WaitResult) => void)[] };
type Created = { id: string; [key: string]: unknown };
type Sent = { agentId: string; text: string; behavior: string | null; busy: boolean; images?: unknown[]; attachments?: { fileName: string }[] };
type ThreadFile = { waiting?: { msgId: string; replyPath: string; earlier?: { msgId: string }[] } | null; messages: { id: string; role: string; text: string; model?: string; blocks?: unknown; steer?: boolean; card?: string; files?: { fileName: string }[]; suggestion?: { kind?: string; commit?: string; state?: string; checks?: { state: string } } }[]; groupId?: string };
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

function setup(uploads?: Uploads, worktrees?: Parameters<typeof createThreads>[0]['worktrees'], trailers: (to: string) => { id: string; commit: string }[] = () => [], models?: Parameters<typeof createThreads>[0]['models'], exec: Exec = async () => ({ ok: false, stdout: '', stderr: '' }), hold?: Parameters<typeof createThreads>[0]['hold']) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const daemon = fakeDaemon();
  const work = {
    slug: SLUG,
    title: 'Widgets',
    notes: '## Do not revisit\n- No new dependency for caching',
    stack: [{ number: 7 }],
    decisions: [
      { id: 'd1', title: 'Cache or not', options: [{ key: 'cache', label: 'Cache' }, { key: 'none', label: 'No cache' }] },
      { id: 'd2', title: 'Eviction', status: 'taken', choice: 'lru', options: [{ key: 'lru', label: 'LRU' }, { key: 'ttl', label: 'TTL' }] },
    ],
  };
  const decided: { id: string; choice: string; rationale: string }[] = [];
  const comment = (id: string, body: string) => ({ id, path: 'src/widgets.ts', startLine: 3, endLine: 4, side: 'head' as const, snippet: 'const w = null;', ctxBefore: [], ctxAfter: [], body, status: id === 'bb22' ? 'declined' : 'open' });
  const reviewAgent = { rowPr: async () => ({ number: 7, head: 'feat/widgets', sha: 'abc123', url: '' }), agentsList: async () => [], trailersBetween: async (_cwd: string, _from: string, to: string) => trailers(to), timeline: () => {}, worktreeFor: async () => null, sameDir: () => false };
  // the group's commit log (`git log --no-merges <tip> --not ...`): what the test's exec answers, else the commits of `trailers` at that tip
  const run: Exec = async (cmd, args) => {
    const r = await exec(cmd, args);
    if (!args.includes('--no-merges') || (r.ok && /^[0-9a-f]{6,}\n/.test(r.stdout))) return r;
    return { ok: true, stdout: trailers(String(args[args.indexOf('--not') - 1])).map((t) => `${t.commit}\nFix\n\nCc-Comment: ${t.id}\n\0`).join(''), stderr: '' };
  };
  const threads = createThreads({
    DATA,
    REPO,
    config,
    works: { get: (slug: string) => (slug === SLUG ? work : null), list: () => [work], upsertDecision: () => {}, decide: (_slug, input) => (work.decisions[0].options.some((o) => o.key === input.choice) ? decided.push(input) : null) },
    comments: { list: () => ({ comments: [comment('aa11', 'Null check missing'), comment('bb22', 'Rename the helper')] }), update: async () => {} },
    reviewAgent,
    reviewPlan: { planOf: () => null },
    exec: run,
    agents: createPaseoAgents({ APP, connect: daemon.connect }),
    uploads,
    worktrees,
    models,
    hold,
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

test('the first prompt of a code group carries the settled decisions, the other findings on the file, the Approve mechanics and the question rule; a follow-up is a short delta', async () => {
  const { post, daemon, read, reply } = setup();
  const a1 = await post(A, 'Why is this null?');
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const first = daemon.calls.sent[0].text;
  assert.match(first, /## Settled, don't revisit\n\n- Eviction: LRU\.\n- No new dependency for caching/);
  assert.match(first, /## Other findings on src\/widgets\.ts \(this PR\)\n\n- Rename the helper \(src\/widgets\.ts:3, declined\)\n/);
  assert.doesNotMatch(first, /- Null check missing \(/);
  assert.match(first, /Recommendation is a hypothesis, not a decision/);
  assert.match(first, /trailer `Cc-Comment: aa11`[\s\S]*Alice presses Approve, which cherry-picks that commit onto the PR worktree[\s\S]*Never cherry-pick, merge or push onto the PR branch yourself[\s\S]*"dismissed" is Alice's call, not a failure/);
  assert.match(first, /message is a question[\s\S]*answer it\. Do not commit/);
  assert.match(first, /End every turn with an `ask` card of next steps, your recommendation marked/);
  assert.match(first, /`details` state the why in one sentence/);
  assert.match(first, /Blocks \(full reference/);

  reply(a1.waiting.replyPath, 'Because of the cache.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  const a2 = await post(A, 'Options?');
  await until(() => daemon.calls.sent.length === 2, 'follow-up');
  const next = daemon.calls.sent[1].text;
  assert.match(next, /Same rules as your first turn\. Reply with cocopilot `post_reply`[^\n]*fallback: the same JSON written to `[^`]+-reply\.json`/);
  assert.ok(next.includes(a2.waiting.replyPath));
  assert.doesNotMatch(next, /Blocks \(full reference|Settled, don't revisit/);
  assert.ok(next.length < first.length / 2, `follow-up ${next.length} vs first ${first.length}`);
});

test('a thread shows the agent commit that carries its comment trailer until it is on the PR branch, by trailer or by patch-id, and points at its Approve', async () => {
  const commit = 'f'.repeat(40);
  const git = { cherry: '', grep: '' };
  const exec: Exec = async (_cmd, args) => {
    const out = (stdout: string) => ({ ok: true, stdout, stderr: '' });
    if (args.includes('cherry')) return out(git.cherry);
    if (args.includes('--grep')) return out(git.grep);
    if (args.includes('--no-patch')) return out('Guard the null\n');
    if (args.includes('--shortstat')) return out(' 1 file changed, 2 insertions(+)\n');
    if (args.includes('--name-only')) return out('src/widgets.ts\n');
    if (args.includes('rev-parse')) return out('abc999\n');
    return out('diff');
  };
  const { threads, post, daemon, read, reply } = setup(undefined, undefined, () => [{ id: 'aa11', commit }], undefined, exec);
  const get = async () => {
    let body: { ready?: { commit: string; subject: string; stat: string; approve?: string } | null } = {};
    const req = { method: 'GET', url: `/api/works/${SLUG}/threads/${A}`, on: () => {} } as unknown as Req;
    await threads.handle(req, {} as Res, ['works', SLUG, 'threads', A], async () => '', (_res, _status, json) => void (body = json as typeof body));
    return body.ready;
  };
  assert.equal(await get(), null, 'no thread yet');

  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  const msg = read(A).messages.findLast((m) => m.suggestion);
  assert.deepEqual(await get(), { commit, subject: 'Guard the null', stat: '1 file changed, 2 insertions(+)', approve: msg?.id });

  git.cherry = `- ${commit} Guard the null\n`;
  assert.equal(await get(), null, 'same patch-id on the PR branch');
  git.cherry = `+ ${commit} Guard the null\n`;
  git.grep = 'a'.repeat(40);
  assert.equal(await get(), null, 'same trailer on the PR branch');
  git.grep = '';
  await threads.decideSuggestion(SLUG, A, msg!.id, 'dismiss');
  const dismissed = await get();
  assert.equal(dismissed?.commit, commit);
  assert.equal(dismissed?.approve, undefined, 'a dismissed suggestion has no Approve to point at');
});

test("the owner's Verify runs the checks on the ready commit in the group worktree: deps-pending is not cached and tries again, a finished run is reused for its sha, a new commit runs anew", async () => {
  let commit = 'f'.repeat(40);
  let deps: Readiness['state'] = 'preparing';
  let cherry = '+ x\n';
  const exec: Exec = async (_cmd, args) => ({ ok: true, stdout: args.includes('cherry') ? cherry : args.includes('--grep') ? '' : args.includes('--no-patch') ? 'Guard\n' : args.includes('rev-parse') ? 'abc999\n' : args.includes('--name-only') ? 'src/widgets.ts\n' : '', stderr: '' });
  const ran: string[] = [];
  const ok = (head: string): Verification => ({ state: 'passed', at: 'now', head, files: ['src/widgets.ts'], results: [{ id: 'lint', label: 'Lint', state: 'passed', command: 'lint src/widgets.ts', ms: 12 }] });
  const { threads, post, daemon, read, reply } = setup(undefined, {
    prepare: async () => ({ state: deps, root: '/wt/cc-group', deps: [{ path: 'node_modules', mode: deps === 'ready' ? 'linked' : 'installing' }], checks: [] }),
    whenReady: () => {},
    briefLines: (r) => briefLines(r),
    verify: async (root, { head }) => (ran.push(`${root} ${head}`), ok(head)),
    head: async () => commit,
  }, () => [{ id: 'aa11', commit }], undefined, exec, { ms: 0, pollMs: 1 });
  const call = async (method: string, payload: object = {}, sub = 'verify') => {
    let out: { code: number; body: Record<string, unknown> } = { code: 0, body: {} };
    const req = { method, url: `/api/works/${SLUG}/threads/${A}/${sub}`, on: () => {} } as unknown as Req;
    await threads.handle(req, {} as Res, ['works', SLUG, 'threads', A, sub], async () => JSON.stringify(payload), (_res, code, body) => void (out = { code, body: body as typeof out.body }));
    return out;
  };
  const stored = () => (read(A) as unknown as { verifies?: Record<string, { status: string; note?: string; checks: { name: string; ok: boolean; ms: number }[] }> }).verifies;

  assert.equal((await call('POST')).code, 400, 'no thread, no commit');
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  ran.length = 0;

  assert.equal((await call('POST')).body.status, 'running');
  await until(() => stored()?.[commit]?.status === 'deps-pending', 'deps-pending');
  assert.match(stored()![commit].note ?? '', /installing the dependencies: node_modules installing/);
  assert.deepEqual(ran, [], 'nothing ran while the deps install');

  deps = 'ready';
  await call('POST');
  await until(() => stored()?.[commit]?.status === 'pass', 'pass');
  assert.deepEqual(stored()![commit].checks.map((c) => [c.name, c.ok, c.ms]), [['Lint', true, 12]]);
  assert.deepEqual(ran, [`/wt/cc-group ${commit}`]);

  assert.equal((await call('POST')).body.status, 'pass');
  assert.equal(ran.length, 1, 'cached by sha');

  commit = 'e'.repeat(40);
  await call('POST');
  await until(() => stored()?.[commit]?.status === 'pass', 'new commit');
  assert.equal(ran.length, 2);
  assert.equal(Object.keys(stored()!).length, 2);

  assert.equal((await call('POST', { commit: '1'.repeat(40) })).code, 400, 'only the ready or a suggested commit');

  cherry = `- ${commit} x\n`;
  assert.equal((await call('POST')).body.status, 'pass', 'with no ready line, the open suggestion is verified (cached)');
});

test('Verify also takes the commit of an open suggestion that is not the ready line, and refuses to run while the worktree HEAD is past it', async () => {
  const older = 'a'.repeat(40);
  const newer = 'b'.repeat(40);
  let tip = newer;
  const exec: Exec = async (_cmd, args) => ({ ok: true, stdout: args.includes('cherry') ? '+ x\n' : args.includes('--grep') ? '' : args.includes('--no-patch') ? 'Guard\n' : args.includes('rev-parse') ? 'abc999\n' : args.includes('--name-only') ? 'src/widgets.ts\n' : '', stderr: '' });
  const ran: string[] = [];
  const { threads, post, daemon, read, reply } = setup(undefined, {
    prepare: async () => ({ state: 'ready', root: '/wt/cc-group', deps: [], checks: [] }),
    whenReady: () => {},
    briefLines: (r) => briefLines(r),
    verify: async (root, { head }) => (ran.push(head), { state: 'passed', at: 'now', head, files: [], results: [] }),
    head: async () => tip,
  }, () => [{ id: 'aa11', commit: tip }], undefined, exec);
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  tip = older;
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  tip = newer;
  ran.length = 0;
  const call = async (commit: string) => {
    let out: Record<string, unknown> = {};
    const req = { method: 'POST', url: `/api/works/${SLUG}/threads/${A}/verify`, on: () => {} } as unknown as Req;
    await threads.handle(req, {} as Res, ['works', SLUG, 'threads', A, 'verify'], async () => JSON.stringify({ commit }), (_res, _code, body) => void (out = body as typeof out));
    return out;
  };
  const stored = () => (read(A) as unknown as { verifies?: Record<string, { status: string; head?: string; note?: string }> }).verifies;
  await call(older);
  await until(() => stored()?.[older]?.status === 'stale-head', 'stale-head');
  assert.equal(stored()![older].head, newer);
  assert.match(stored()![older].note ?? '', /agent committed past aaaaaaa/);
  assert.deepEqual(ran, [], 'nothing ran on the moved tree');
  tip = older;
  await call(older);
  await until(() => stored()?.[older]?.status === 'pass', 'pass at the commit');
  assert.deepEqual(ran, [older]);
});

test('a double click on Verify starts one run, and a commit that is not a sha is refused', async () => {
  const commit = 'c'.repeat(40);
  const exec: Exec = async (_cmd, args) => ({ ok: true, stdout: args.includes('cherry') ? '+ x\n' : args.includes('--grep') ? '' : args.includes('--no-patch') ? 'Guard\n' : args.includes('rev-parse') ? 'abc999\n' : args.includes('--name-only') ? 'src/widgets.ts\n' : '', stderr: '' });
  const ran: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { threads, post, daemon, read, reply } = setup(undefined, {
    prepare: async () => ({ state: 'ready', root: '/wt/cc-group', deps: [], checks: [] }),
    whenReady: () => {},
    briefLines: (r) => briefLines(r),
    verify: async (root, { head }) => (ran.push(head), await gate, { state: 'passed', at: 'now', head, files: [], results: [] }),
    head: async () => commit,
  }, () => [{ id: 'aa11', commit }], undefined, exec);
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  const click = async () => {
    const req = { method: 'POST', url: `/api/works/${SLUG}/threads/${A}/verify`, on: () => {} } as unknown as Req;
    let out = 0;
    await threads.handle(req, {} as Res, ['works', SLUG, 'threads', A, 'verify'], async () => '{}', (_res, code) => void (out = code));
    return out;
  };
  ran.length = 0;
  assert.deepEqual(await Promise.all([click(), click(), click()]), [200, 200, 200]);
  await until(() => ran.length >= 1, 'run started');
  release();
  await until(() => (read(A) as unknown as { verifies?: Record<string, { status: string }> }).verifies?.[commit]?.status === 'pass', 'pass');
  assert.equal(ran.length, 1, 'one run for three clicks');
  const bad = { method: 'POST', url: '', on: () => {} } as unknown as Req;
  let code = 0;
  await threads.handle(bad, {} as Res, ['works', SLUG, 'threads', A, 'verify'], async () => JSON.stringify({ commit: 'zzzzzzz' }), (_res, c) => void (code = c));
  assert.equal(code, 400);
});

test('one live agent per comment: a message with another model goes to the group that holds the comment, not to a new agent', async () => {
  const { threads, post, daemon, read, reply } = setup();
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  const agent = daemon.calls.created[0].id;
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  const a2 = await threads.post(SLUG, A, { text: 'Redo it with opus', model: 'opus' });
  await until(() => daemon.calls.sent.length === 2, 'second dispatch');
  assert.equal(a2.groupId, a1.groupId);
  assert.equal(daemon.calls.created.length, 1, 'no second agent');
  assert.equal(daemon.calls.sent[1].agentId, agent);
  assert.equal(daemon.calls.worktrees.length, 1, 'no second worktree');
});

test('two first messages on different comments of one file land in one group and one agent', async () => {
  const { threads, daemon } = setup();
  const [a, b] = await Promise.all([threads.post(SLUG, A, { text: 'one' }), threads.post(SLUG, B, { text: 'two' })]);
  assert.equal(a.groupId, b.groupId);
  assert.equal(daemon.calls.created.length, 1);
});

test('messages written while the agent starts show at once, queued in order, and reach it in order once it exists; the start steps stream live', async () => {
  const { threads, daemon, read } = setup();
  const client = await daemon.connect();
  let open = () => {};
  const gate = new Promise<void>((ok) => (open = ok));
  const create = client.workspaces.create;
  client.workspaces.create = async (opts) => (await gate, create(opts));
  type Ev = { type: string; step?: { text: string; steps?: { text: string }[] } | null; inbound?: { text: string }[] };
  const seen: Ev[] = [];
  const stream = { method: 'GET', url: `/api/works/${SLUG}/threads/${A}/events`, on: () => {} } as unknown as Req;
  await threads.handle(stream, { writeHead: () => {}, write: (chunk: string) => seen.push(JSON.parse(chunk.slice('data: '.length))) } as unknown as Res, ['works', SLUG, 'threads', A, 'events'], async () => '', () => assert.fail('no JSON answer on the stream'));
  const get = async () => {
    let body: { inbound?: { text: string }[]; starting?: { steps?: { text: string }[] } | null } = {};
    const req = { method: 'GET', url: `/api/works/${SLUG}/threads/${A}`, on: () => {} } as unknown as Req;
    await threads.handle(req, {} as Res, ['works', SLUG, 'threads', A], async () => '', (_res, _status, json) => void (body = json as typeof body));
    return body;
  };

  const one = threads.post(SLUG, A, { text: 'Add the null check' });
  await until(() => seen.some((e) => e.type === 'step' && e.step?.text === 'Creating a worktree'), 'worktree step');
  const two = threads.post(SLUG, A, { text: 'And a test for it' });
  const three = threads.post(SLUG, A, { text: 'Name it null.test.ts' });
  await until(() => seen.some((e) => e.type === 'inbound' && e.inbound?.length === 3), 'all three shown');
  const mid = await get();
  assert.deepEqual(mid.inbound?.map((m) => m.text), ['Add the null check', 'And a test for it', 'Name it null.test.ts']);
  assert.deepEqual(mid.starting?.steps?.map((s) => s.text), ['Finding the agent', 'Creating a worktree', 'Starting the agent']);
  assert.equal(daemon.calls.sent.length, 0, 'nothing reaches an agent that does not exist yet');

  open();
  await Promise.all([one, two, three]);
  await until(() => daemon.calls.sent.length === 3, 'all three delivered');
  assert.deepEqual(read(A).messages.filter((m) => m.role === 'user').map((m) => m.text), ['Add the null check', 'And a test for it', 'Name it null.test.ts']);
  assert.ok(daemon.calls.sent[1].text.includes('And a test for it') && daemon.calls.sent[2].text.includes('Name it null.test.ts'));
  assert.equal(daemon.calls.created.length, 1, 'one agent takes them all');
  assert.ok(seen.some((e) => e.type === 'step' && e.step?.steps?.map((s) => s.text).join(' > ') === 'Finding the agent > Creating a worktree > Starting the agent'));
  const after = await get();
  assert.deepEqual([after.inbound, after.starting], [[], null]);
});

test('a commit on whatever branch Paseo checked the group out on becomes an approvable suggestion', async () => {
  const exec: Exec = async (_cmd, args) => {
    if (args[1] === '/wt/cc-group' && args.includes('rev-parse')) return { ok: true, stdout: 'c0ffee\n', stderr: '' };
    if (args.includes('show')) return { ok: true, stdout: args.includes('--name-only') ? 'src/widgets.ts\n' : 'diff --git a/src/widgets.ts', stderr: '' };
    return { ok: false, stdout: '', stderr: '' };
  };
  const { post, daemon, read, reply } = setup(undefined, undefined, (to) => (to === 'c0ffee' ? [{ id: 'aa11', commit: 'c0ffee' }] : []), undefined, exec);
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  reply(a1.waiting.replyPath, 'Committed.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  const suggestion = read(A).messages.findLast((m) => m.suggestion)?.suggestion;
  assert.deepEqual([suggestion?.kind, suggestion?.commit, suggestion?.state], ['commit', 'c0ffee', 'pending']);
});

test('a fresh agent for a comment whose earlier group already committed is told the sha and subject', async () => {
  let committed = false;
  const exec: Exec = async (_cmd, args) => ({ ok: args.includes('--format=%s'), stdout: args.includes('--format=%s') ? 'Add the null check\n' : '', stderr: '' });
  const { threads, post, daemon, read, reply } = setup(undefined, undefined, (to) => (committed && to.endsWith(`cocopilot/${groupOne}`) ? [{ id: 'aa11', commit: 'deadbeef1234567890' }] : []), undefined, exec);
  let groupOne = '';
  const a1 = await post(A, 'Add the null check');
  groupOne = a1.groupId ?? '';
  await until(() => daemon.calls.sent.length === 1, 'first dispatch');
  reply(a1.waiting.replyPath, 'Done.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  committed = true;
  await threads.regroup(SLUG, A, 'new');
  const a2 = await post(A, 'Try again');
  await until(() => daemon.calls.sent.length === 2, 'second dispatch');
  assert.notEqual(a2.groupId, groupOne);
  assert.equal(daemon.calls.created.length, 2);
  assert.match(daemon.calls.sent[1].text, /an earlier agent already committed deadbee: Add the null check/);
  assert.doesNotMatch(daemon.calls.sent[0].text, /earlier agent already committed/);
});

test('the first prompt of a code agent waits for the worktree deps; past the timeout it says so and the ready message follows', async () => {
  const wt = (state: Readiness['state']): Readiness => ({ state, root: '/wt/cc-group', deps: [{ path: 'node_modules', mode: state === 'ready' ? 'linked' : 'installing' }], checks: [{ id: 'lint', label: 'Lint', command: 'lint <changed files>', available: state === 'ready', why: 'coco is installing the dependencies' }] });
  let installed = false;
  const held = setup(undefined, { prepare: async () => wt(installed ? 'ready' : 'preparing'), whenReady: () => {}, briefLines: (r) => briefLines(r) }, undefined, undefined, undefined, { ms: 5000, pollMs: 5 });
  const a1 = await held.threads.post(SLUG, A, { text: 'Add the null check' });
  assert.equal(held.daemon.calls.sent.length, 0, 'the POST returned before the deps are ready; nothing sent');
  assert.equal(held.read(A).messages[0].text, 'Add the null check', 'the owner sees their message at once');
  assert.ok((held.read(A).waiting as { deps?: unknown }).deps, 'the thread says it waits for deps');
  await held.threads.ingest(SLUG, A);
  assert.ok(held.read(A).waiting, 'ingest does not end a thread whose prompt is held');
  installed = true;
  await until(() => held.daemon.calls.sent.length === 1, 'prompt after the deps');
  await until(() => !(held.read(A).waiting as { deps?: unknown } | null)?.deps, 'status cleared');
  assert.doesNotMatch(held.daemon.calls.sent[0].text, /Not available yet|still installing/);
  assert.match(held.daemon.calls.sent[0].text, /Lint: `lint <changed files>`/);
  assert.ok(a1.waiting);

  const heard: [string, string][] = [];
  const slow = setup(undefined, { prepare: async () => wt('preparing'), whenReady: (root, agentId) => void heard.push([root, agentId]), briefLines: (r) => briefLines(r) }, undefined, undefined, undefined, { ms: 30, pollMs: 5 });
  await slow.threads.post(SLUG, A, { text: 'Add the null check' });
  await until(() => slow.daemon.calls.sent.length === 1, 'prompt after the timeout');
  const agent = slow.daemon.calls.created[0].id;
  assert.match(slow.daemon.calls.sent[0].text, /dependencies are still installing[\s\S]*checks are available now/);
  assert.deepEqual(heard, [['/wt/cc-group', agent]]);
  assert.equal(await slow.threads.steerAgent(agent, readyText(wt('ready'))), true);
  await until(() => slow.daemon.calls.sent.length === 2, 'ready message');
  assert.match(slow.daemon.calls.sent[1].text, /checks are available now[\s\S]*Lint: `lint <changed files>`/);
});

test('post_reply checks the blocks like post_blocks, writes the reply file the thread waits on and lands the reply', async () => {
  const { threads, post, daemon, read } = setup();
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  assert.match(daemon.calls.sent[0].text, /call cocopilot `post_reply`/);
  await assert.rejects(threads.postReply(agent, { blocks: [{ type: 'table', columns: ['a'], rows: [['x', 'y']] }], thread: A }), /blocks\[0\]/);
  await assert.rejects(threads.postReply(agent, { blocks: [{ type: 'nope' }] }), /blocks\[0\]\.type must be one of/);
  await assert.rejects(threads.postReply(agent, { blocks: [{ type: 'text', text: 'x' }], thread: B }), /no thread "c\.7\.bb22" waits on this agent/);
  await assert.rejects(threads.postReply('other-agent', { blocks: [{ type: 'text', text: 'x' }] }), /no thread waits on this agent/);
  assert.equal(fs.existsSync(a1.waiting.replyPath), false, 'a refusal writes nothing');
  assert.ok(read(A).waiting);

  const out = await threads.postReply(agent, { blocks: [{ type: 'text', text: 'Null check added.' }], thread: A });
  assert.deepEqual(out, { ok: true, thread: A, blocks: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(a1.waiting.replyPath, 'utf8')), { blocks: [{ type: 'text', text: 'Null check added.' }] });
  assert.equal(read(A).waiting, null);
  assert.deepEqual(read(A).messages.map((m) => [m.role, m.text]), [['user', 'Add the null check'], ['agent', 'Null check added.']]);
});

test('a Cc-Comment line names its comment wherever it sits in the message and in any case; blank lines and other trailers do not hide it', () => {
  assert.deepEqual(commentIdsOf('fix: guard the null\n\nBody.\n\nCc-Comment: daa6b3861438\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'), ['daa6b3861438'], 'blank line before the last trailer paragraph');
  assert.deepEqual(commentIdsOf('fix\n\nSigned-off-by: A <a@x.io>\nCc-Comment: aa11\nCo-Authored-By: Claude <noreply@anthropic.com>'), ['aa11'], 'among other trailers');
  assert.deepEqual(commentIdsOf('fix\n\ncc-comment:AA11  \n'), ['aa11'], 'lowercase key, upper-case id, no space');
  assert.deepEqual(commentIdsOf('fix\n\nCC-COMMENT : `bb22`\n- Cc-Comment: aa11\nCc-Comment: aa11\n'), ['bb22', 'aa11'], 'quoted, listed, repeated');
  assert.deepEqual(commentIdsOf('fix the Cc-Comment: aa11 parsing'), [], 'only at the start of a line');
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  assert.deepEqual(parseCommitLog(`${a}\nfix\n\nCc-Comment: aa11\n\nCo-Authored-By: C <c@x.io>\n\0\n${b}\nno trailer\n\0\n`), [{ commit: a, ids: ['aa11'] }, { commit: b, ids: [] }]);
});

// a group branch whose log the test sets, each commit touching src/widgets.ts
const gitLog = (log: () => { commit: string; message: string }[]): Exec => async (_cmd, args) => {
  const out = (stdout: string) => ({ ok: true, stdout, stderr: '' });
  if (args.includes('--no-merges')) return out(log().map((c) => `${c.commit}\n${c.message}\n\0`).join(''));
  if (args.includes('--name-only')) return out('src/widgets.ts\n');
  if (args.includes('--no-patch')) return out(`${new Date().toISOString()}\nGuard the null\n`);
  if (args.includes('show')) return out('diff --git a/src/widgets.ts b/src/widgets.ts');
  return { ok: false, stdout: '', stderr: '' };
};
const bash = (id: string, command: string): TimelineItem => ({ type: 'tool_call', callId: id, name: 'Bash', detail: { type: 'shell', command }, status: 'completed', error: null });

test('a commit without a Cc-Comment line goes to the only item of its turn: seen as soon as it is made with the checks running, then under the reply of its turn', async () => {
  let log: { commit: string; message: string }[] = [];
  let pass: (v: Verification) => void = () => {};
  const { post, daemon, read, reply } = setup(undefined, {
    prepare: async () => ({ state: 'ready', root: '/wt/cc-group', deps: [], checks: [] }),
    whenReady: () => {},
    briefLines: (r) => briefLines(r),
    verify: () => new Promise((ok) => (pass = ok)),
  }, () => [], undefined, gitLog(() => log));
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const agent = daemon.calls.created[0].id;
  log = [{ commit: 'c0ffee1', message: 'fix: guard the null\n\nCo-Authored-By: Claude <noreply@anthropic.com>' }];
  daemon.item(agent, bash('c1', 'git commit -m "fix: guard the null"'));
  await until(() => read(A).messages.some((m) => m.suggestion), 'the commit seen mid-turn');
  assert.ok(read(A).waiting, 'the agent still works');
  assert.deepEqual(read(A).messages.at(-1)?.suggestion && [read(A).messages.at(-1)?.suggestion?.commit, read(A).messages.at(-1)?.suggestion?.checks?.state], ['c0ffee1', 'running']);

  reply(a1.waiting.replyPath, 'Committed.');
  daemon.finish(agent);
  await until(() => !read(A).waiting, 'turn end');
  assert.deepEqual(read(A).messages.map((m) => [m.role, m.text, m.suggestion?.commit]), [['user', 'Add the null check', undefined], ['agent', 'Committed.', 'c0ffee1']], 'the reply fills the bare suggestion');
  pass({ state: 'passed', at: 'now', head: 'c0ffee1', files: ['src/widgets.ts'], results: [] });
  await until(() => read(A).messages[1].suggestion?.checks?.state === 'passed', 'checks done');
});

test('a commit without a Cc-Comment line in a turn on two items goes to the item the agent answered last', async () => {
  let log: { commit: string; message: string }[] = [];
  const { post, daemon, read, reply } = setup(undefined, undefined, () => [], undefined, gitLog(() => log));
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  const b1 = await post(B, 'Rename the helper too');
  await until(() => daemon.calls.sent.length === 2, 'steer');
  log = [{ commit: 'c0ffee2', message: 'refactor: rename the helper' }];
  reply(a1.waiting.replyPath, 'Null check: nothing to change.');
  await new Promise((r) => setTimeout(r, 20));
  reply(b1.waiting.replyPath, 'Renamed.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting && !read(B).waiting, 'turn end');
  await until(() => read(B).messages.some((m) => m.suggestion), 'suggestion on B');
  assert.equal(read(B).messages.find((m) => m.suggestion)?.text, 'Renamed.');
  assert.ok(!read(A).messages.some((m) => m.suggestion));
});

test('a commit naming no item of the group waits on the group, not linked, until the owner links it to an item', async () => {
  const log = [{ commit: 'c0ffee3', message: 'fix\n\nCc-Comment: ffff99' }];
  const { threads, post, daemon, read, reply } = setup(undefined, undefined, () => [], undefined, gitLog(() => log));
  const a1 = await post(A, 'Add the null check');
  await until(() => daemon.calls.sent.length === 1, 'dispatch');
  reply(a1.waiting.replyPath, 'Committed.');
  daemon.finish(daemon.calls.created[0].id);
  await until(() => !read(A).waiting, 'turn end');
  assert.ok(!read(A).messages.some((m) => m.suggestion));
  const call = async (method: string, parts: string[], payload: object = {}) => {
    let body: unknown = null;
    const req = { method, url: `/api/works/${parts.join('/')}`, on: () => {} } as unknown as Req;
    await threads.handle(req, {} as Res, ['works', SLUG, ...parts], async () => JSON.stringify(payload), (_res, _code, json) => void (body = json));
    return body as { id: string; unlinked?: { commit: string; subject: string }[] }[] & { unlinked?: unknown[] };
  };
  const [group] = await call('GET', ['groups']);
  assert.deepEqual(group.unlinked?.map((u) => [u.commit, u.subject]), [['c0ffee3', 'Guard the null']]);
  const linked = await call('POST', ['groups', group.id, 'link'], { commit: 'c0ffee3', key: A });
  assert.deepEqual(linked.unlinked, []);
  assert.equal(read(A).messages.findLast((m) => m.suggestion)?.suggestion?.commit, 'c0ffee3');
});
