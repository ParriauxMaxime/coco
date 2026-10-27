import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createPaseoAgents } from './paseo-agent.ts';
import type { DaemonAgent, TimelineEvent, WaitResult, WorkspaceEntry } from './paseo-agent.ts';
import { createAsk } from './ask.ts';
import { createCards } from './cards.ts';
import { DEFAULTS } from './config.ts';
import { checkPick } from './models.ts';
import type { ModelPick } from './models.ts';

type Handler = Parameters<DaemonAgent['timeline']['subscribe']>[0];
type FakeAgent = { id: string; workspaceId: string; status: string; archivedAt: string | null; handlers: Set<Handler>; waiters: ((r: WaitResult) => void)[]; last: string | null };
type Created = { id: string; title?: string; config: Record<string, unknown>; labels?: Record<string, string>; prompt?: string };
type Sent = { agentId: string; text: string; behavior: string | null; busy: boolean };

const APP = '/opt/coco';
const REPO = '/acme/widgets';
const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-'));
const until = async (cond: () => boolean, what = 'condition') => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A daemon whose turns end when the test says so: send() opens a turn on an idle agent and joins the running one otherwise.
function fakeDaemon() {
  const agents = new Map<string, FakeAgent>();
  const calls: { created: Created[]; sent: Sent[]; archived: string[] } = { created: [], sent: [], archived: [] };
  let seq = 0;
  const handle = (a: FakeAgent): DaemonAgent => ({
    id: a.id,
    workspaceId: a.workspaceId,
    get status() {
      return a.status;
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
    waitForFinish: () => (a.status === 'running' ? new Promise<WaitResult>((resolve) => a.waiters.push(resolve)) : Promise.resolve({ status: 'idle', lastMessage: a.last, final: null, error: null })),
    refresh: async () => (agents.has(a.id) ? { agent: { id: a.id, status: a.status, archivedAt: a.archivedAt } } : null),
    archive: async () => {
      a.status = 'closed';
      a.archivedAt = 'now';
      calls.archived.push(a.id);
      return { archivedAt: 'now' };
    },
  });
  const gone = (id: string): DaemonAgent => ({
    id,
    timeline: { subscribe: () => () => {} },
    send: async () => {},
    waitForFinish: async () => ({ status: 'error' }),
    refresh: async () => null,
    archive: async () => ({}),
  });
  const client = {
    workspaces: {
      list: async () => ({ entries: [{ id: 'wks_repo', projectId: 'p1', workspaceDirectory: REPO }] }),
      ref: (w: string | WorkspaceEntry) => {
        const id = typeof w === 'string' ? w : w.id;
        return {
          id,
          agents: {
            create: async (opts: Omit<Created, 'id'>) => {
              const a: FakeAgent = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, workspaceId: id, status: 'idle', archivedAt: null, handlers: new Set(), waiters: [], last: null };
              agents.set(a.id, a);
              calls.created.push({ ...opts, id: a.id });
              return handle(a);
            },
          },
        };
      },
      open: async () => {
        throw new Error('not expected');
      },
      create: async () => {
        throw new Error('not expected');
      },
    },
    agents: {
      ref: (id: string) => {
        const a = agents.get(id);
        return a ? handle(a) : gone(id);
      },
    },
  };
  const emit = (a: FakeAgent, event: TimelineEvent) => {
    for (const h of a.handlers) h({ agentId: a.id, event });
  };
  // the agent's running turn answers text (and an optional cocopilot proposal), then ends
  const finish = (id: string, text: string, { propose = null, cost = 0.1 }: { propose?: { tool: string; input: unknown } | null; cost?: number } = {}) => {
    const a = agents.get(id);
    if (!a) throw new Error(`no agent ${id}`);
    emit(a, { type: 'timeline', provider: 'claude', item: { type: 'assistant_message', text, messageId: `m${Math.random()}` } });
    if (propose) emit(a, { type: 'timeline', provider: 'claude', item: { type: 'tool_call', callId: `c${Math.random()}`, name: `mcp__cocopilot__${propose.tool}`, detail: { type: 'unknown', input: propose.input, output: { recorded: true } }, status: 'completed', error: null } });
    emit(a, { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: cost } });
    a.status = 'idle';
    a.last = text;
    for (const wake of a.waiters.splice(0)) wake({ status: 'idle', lastMessage: text, final: null, error: null });
  };
  return { connect: async () => client, calls, finish, agents, forget: (id: string) => agents.delete(id) };
}

const works = { get: () => undefined, save: () => {}, prInfo: async () => null };
const setup = (DATA = tmpDir(), daemon = fakeDaemon(), opts: { idleMs?: number } = {}) => ({ DATA, daemon, ask: createAsk({ DATA, APP, REPO, config, works, agents: createPaseoAgents({ APP, connect: daemon.connect }), ...opts }) });
type Events = { events: { type: string }[] };
const types = (conv: Events) => conv.events.filter((e) => e.type !== 'meta').map((e) => e.type);
const ends = (conv: Events) => conv.events.filter((e) => e.type === 'end').length;

test('a follow-up goes to the same agent as a new turn, with only the new message', async () => {
  const { ask, daemon, DATA } = setup();
  const conv = ask.start({ prompt: 'Who reviews the widgets export?' });
  await until(() => daemon.calls.sent.length === 1, 'first send');
  const [agent] = daemon.calls.created;
  assert.equal(agent.config.modeId, 'auto');
  assert.equal(agent.prompt, undefined);
  daemon.finish(agent.id, 'Bob reviews it.');
  await until(() => ends(conv) === 1, 'first turn end');
  assert.equal(conv.status, 'idle');

  await ask.say(conv.id, 'And the API part?');
  await until(() => daemon.calls.sent.length === 2, 'follow-up send');
  assert.equal(conv.status, 'running');
  daemon.finish(agent.id, 'Carol does.', { propose: { tool: 'propose_work_scaffold', input: { slug: 'widgets-export' } } });
  await until(() => ends(conv) === 2, 'second turn end');

  assert.equal(daemon.calls.created.length, 1);
  assert.deepEqual(daemon.calls.sent.map((s) => [s.agentId, s.text, s.busy]), [[agent.id, 'Who reviews the widgets export?', false], [agent.id, 'And the API part?', false]]);
  assert.deepEqual(types(conv), ['user', 'text', 'end', 'user', 'text', 'tool', 'end']);
  assert.equal(conv.turns, 2);
  assert.deepEqual(daemon.calls.archived, []);
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'asks', `${conv.id}.json`), 'utf8'));
  assert.equal(saved.agentId, agent.id);
  assert.equal(saved.status, 'idle');
});

test('a message while the agent works steers its turn instead of interrupting it, and the turn ends once', async () => {
  const { ask, daemon } = setup();
  const nonce = 'n-1';
  const conv = ask.start({ prompt: 'Scaffold the widgets export', nonce });
  await until(() => daemon.calls.sent.length === 1, 'first send');
  await ask.say(conv.id, 'Keep it to two PRs.', { nonce: 'n-2' });

  assert.deepEqual(daemon.calls.sent.map((s) => [s.text, s.behavior, s.busy]), [['Scaffold the widgets export', 'steer', false], ['Keep it to two PRs.', 'steer', true]]);
  const users = conv.events.filter((e) => e.type === 'user');
  assert.deepEqual(users.map((u) => [u.text, Boolean(u.steer), u.nonce]), [['Scaffold the widgets export', false, nonce], ['Keep it to two PRs.', true, 'n-2']]);
  assert.equal(ends(conv), 0);
  daemon.finish(daemon.calls.created[0].id, 'Two PRs: API, then UI.');
  await until(() => ends(conv) === 1, 'turn end');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ends(conv), 1);
  assert.equal(conv.status, 'idle');
  assert.equal(daemon.calls.created.length, 1);
});

test('closing archives the agent; a quiet conversation is parked by the reaper; either restarts with a new agent on the next message', async () => {
  const { ask, daemon } = setup(tmpDir(), fakeDaemon(), { idleMs: 1000 });
  const a = ask.start({ prompt: 'What is blocked on widgets?' });
  const b = ask.start({ prompt: 'Who owns gadgets?' });
  await until(() => daemon.calls.created.length === 2 && daemon.calls.sent.length === 2, 'two sends');
  const [ia, ib] = daemon.calls.created.map((c) => c.id);
  daemon.finish(ia, 'Nothing.');
  daemon.finish(ib, 'Dave.');
  await until(() => ends(a) === 1 && ends(b) === 1, 'both turns');

  await ask.close(a.id);
  assert.equal(a.status, 'closed');
  assert.deepEqual(daemon.calls.archived, [ia]);

  assert.deepEqual(await ask.reap(Date.now()), []);
  assert.deepEqual(await ask.reap(Date.now() + 2000), [b.id]);
  assert.equal(b.status, 'parked');
  assert.deepEqual(daemon.calls.archived, [ia, ib]);
  assert.equal(b.events.at(-1)?.type, 'closed');

  await ask.say(a.id, 'Anything new since?');
  await until(() => daemon.calls.sent.length === 3, 'restart send');
  assert.equal(daemon.calls.created.length, 3);
  assert.equal(a.agentId, daemon.calls.created[2].id);
  assert.match(daemon.calls.sent[2].text, /previous agent is gone[\s\S]*\*\*Alice:\*\* What is blocked on widgets\?[\s\S]*\*\*coco:\*\* Nothing\.[\s\S]*## Alice's new message\n\nAnything new since\?$/);
});

test('after a coco restart a conversation re-attaches to its agent: a follow-up reuses it, a turn left running gets its end', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon();
  const before = setup(DATA, daemon).ask;
  const idle = before.start({ prompt: 'Summarise the widgets work' });
  const busy = before.start({ prompt: 'List the open widgets PRs' });
  await until(() => daemon.calls.sent.length === 2, 'two sends');
  const [ii, ib] = daemon.calls.created.map((c) => c.id);
  daemon.finish(ii, 'Two PRs left.');
  await until(() => ends(idle) === 1, 'first turn');

  const after = setup(DATA, daemon).ask;
  await after.resume();
  daemon.finish(ib, '#12 and #13.');
  const resumed = after.load(busy.id);
  assert.ok(resumed);
  await until(() => ends(resumed) === 1, 'resumed turn end');
  assert.equal(resumed.status, 'idle');
  assert.ok(resumed.events.some((e) => e.type === 'meta' && /re-attached/.test(String(e.text))));
  assert.equal(resumed.events.filter((e) => e.type === 'text').at(-1)?.text, '#12 and #13.');

  await after.say(idle.id, 'Which one first?');
  await until(() => daemon.calls.sent.length === 3, 'follow-up send');
  assert.deepEqual(daemon.calls.sent[2], { agentId: ii, text: 'Which one first?', behavior: 'steer', busy: false });
  assert.equal(daemon.calls.created.length, 2);
});

test('after a restart, a conversation whose agent is gone starts a new one fed the conversation so far, a proposal saved before cards included', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon();
  const before = setup(DATA, daemon).ask;
  const conv = before.start({ prompt: 'Scaffold the gadgets import' });
  await until(() => daemon.calls.sent.length === 1, 'first send');
  const old = daemon.calls.created[0].id;
  daemon.finish(old, 'Proposed.', { propose: { tool: 'propose_work_scaffold', input: { slug: 'gadgets-import' } } });
  await until(() => ends(conv) === 1, 'first turn');
  daemon.forget(old);
  const file = path.join(DATA, 'asks', `${conv.id}.json`);
  const { proposed: _none, ...saved } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...saved, proposal: { slug: 'gadgets-import', title: 'Gadgets import' }, rulesProposal: null }));

  const after = setup(DATA, daemon).ask;
  await after.say(conv.id, 'Split the UI PR.');
  await until(() => daemon.calls.sent.length === 2, 'fallback send');
  const reloaded = after.load(conv.id);
  assert.ok(reloaded);
  assert.notEqual(reloaded.agentId, old);
  assert.equal(daemon.calls.created.length, 2);
  assert.ok(reloaded.events.some((e) => e.type === 'meta' && /is gone: a new one starts/.test(String(e.text))));
  const prompt = daemon.calls.sent[1].text;
  assert.match(prompt, /\*\*Alice:\*\* Scaffold the gadgets import\n\n\*\*coco:\*\* Proposed\./);
  assert.match(prompt, /You already proposed a work scaffold "Gadgets import" on a card/);
  assert.deepEqual(after.list('global').find((c) => c.id === conv.id)?.proposed, { kind: 'work', title: 'Gadgets import' });
  assert.ok(prompt.endsWith('Split the UI PR.'));
  daemon.finish(reloaded.agentId ?? '', 'Split.');
  await until(() => ends(reloaded) === 2, 'fallback turn');
  assert.equal(reloaded.status, 'idle');
});

test('a conversation runs at its tier: global without work or repo, the repo’s from its page, the work’s; one saved before tiers reads as global', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon();
  const placed: unknown[] = [];
  const place = async (scope: unknown) => (placed.push(scope), { workspaceId: 'wks_repo', cwd: REPO });
  const saved: { slug: string; repo?: string }[] = [];
  const repoConfig = { ...config, repos: [{ id: 'widgets', name: 'widgets', github: 'acme/widgets', path: REPO }] };
  const ask = createAsk({ DATA, APP, REPO, config: repoConfig, works: { ...works, save: (w) => saved.push(w) }, agents: createPaseoAgents({ APP, connect: daemon.connect }), place });
  const global = ask.start({ prompt: 'What is blocked across repos?' });
  const repo = ask.start({ prompt: 'Scaffold the CSV export', repoId: 'widgets' });
  const work = ask.start({ prompt: 'What is next?', workSlug: 'csv-export' });
  await until(() => daemon.calls.created.length === 3, 'three agents');
  assert.deepEqual(placed, [{ kind: 'global' }, { kind: 'repo', repoId: 'widgets' }, { kind: 'work', slug: 'csv-export' }]);
  const prompts = daemon.calls.created.map((c) => String(c.config.systemPrompt));
  assert.match(prompts[0], /global Ask coco/);
  assert.match(prompts[1], /Ask coco of the widgets repo/);
  assert.match(prompts[2], /Current work: csv-export/);

  const call = async (method: string, url: string, parts: string[]) => {
    const req = new IncomingMessage(new Socket());
    Object.assign(req, { method, url });
    let out: unknown;
    await ask.handle(req, new ServerResponse(req), parts, async () => '{}', (_res, _code, body) => void (out = body));
    return out;
  };

  const repoAgent = daemon.calls.created[1].id;
  daemon.finish(repoAgent, 'Here.');
  await until(() => ends(repo) === 1, 'repo turn end');
  const cards = createCards({ DATA, actions: ask.actions, deliver: async () => {} });
  const card = await cards.create({ agentId: repoAgent, action: { type: 'work_scaffold', input: { slug: 'csv-export', title: 'CSV export' } } });
  await cards.answer(card.id, { approved: true });
  assert.equal(saved[0].repo, 'widgets');

  const old = { ...JSON.parse(fs.readFileSync(path.join(DATA, 'asks', `${global.id}.json`), 'utf8')), id: '00000000-0000-4000-8000-0000000000aa', scope: undefined };
  fs.writeFileSync(path.join(DATA, 'asks', `${old.id}.json`), JSON.stringify(old));
  const listed = async (scope: string) => (await call('GET', `/api/ask?scope=${scope}`, ['ask'])) as { id: string }[];
  assert.deepEqual((await listed('global')).map((c) => c.id).sort(), [global.id, old.id].sort());
  assert.deepEqual((await listed('repo:widgets')).map((c) => c.id), [repo.id]);
  assert.deepEqual((await listed('work:csv-export')).map((c) => c.id), [work.id]);
});

test('a one-shot run (rules) archives its agent after the first turn and stays known as one-shot after a restart', async () => {
  const { ask, daemon, DATA } = setup();
  const ended: { conv?: ReturnType<typeof ask.start> } = {};
  const conv = ask.start({ prompt: 'Distill rules' }, { once: true, onEnd: (c) => (ended.conv = c) });
  await until(() => daemon.calls.sent.length === 1, 'send');
  const agentId = daemon.calls.created[0].id;
  daemon.finish(agentId, 'None.');
  await until(() => conv.status === 'closed', 'closed');
  assert.equal(ended.conv, conv);
  assert.deepEqual(daemon.calls.archived, [agentId]);
  assert.equal(setup(DATA, daemon).ask.convOf(agentId)?.once, true);
});

test('a proposal card shows what the agent proposes, is refused when it cannot run, runs only once approved, and its outcome reaches the card and the agent', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon();
  const work = JSON.parse('{"slug":"csv-export","title":"CSV export","stack":[{"number":12}],"timeline":[]}');
  const saved: { slug: string; stack?: { planned?: { branch?: string } }[] }[] = [];
  const dispatched: string[] = [];
  const ask = createAsk({
    DATA, APP, REPO, config,
    works: { get: (slug) => (slug === 'csv-export' ? work : undefined), save: (w) => void saved.push(w), prInfo: async () => null },
    agents: createPaseoAgents({ APP, connect: daemon.connect }),
    place: async () => ({ workspaceId: 'wks_repo', cwd: REPO }),
    dispatch: async (slug, input) => {
      dispatched.push(`${slug} ${input.entry} ${input.key ?? ''}`);
      if (input.entry === 'broken') throw new Error('no catalog entry broken');
      return { title: 'Ask on #12', agentId: 'agent-d' };
    },
    addRepo: async (source) => ({ ok: true, repo: { id: 'gadgets', name: 'gadgets', path: '/acme/gadgets', github: source, defaultBranch: 'main' }, how: 'cloned', project: { name: 'gadgets' } }),
  });
  const conv = ask.start({ prompt: 'Plan the CSV export', workSlug: 'csv-export' });
  await until(() => daemon.calls.sent.length === 1, 'send');
  const agentId = daemon.calls.created[0].id;
  daemon.finish(agentId, 'Proposed.');
  await until(() => ends(conv) === 1, 'turn end');
  const told: string[] = [];
  const cards = createCards({ DATA, actions: ask.actions, deliver: async (_id, text) => void told.push(text) });
  const propose = (type: string, input: Record<string, unknown>, by = agentId) => cards.create({ agentId: by, action: { type, input } });

  const scaffold = await propose('work_scaffold', { slug: 'csv-export', title: 'CSV export v2', summary: 'Export invoices as CSV.', tier: 'stack', stack: [{ order: 1, title: 'API', scope: 'endpoint', branch: 'feat/csv-api', personas: ['bob'] }], personas: ['bob'] });
  assert.deepEqual([scaffold.kind, scaffold.title, scaffold.question, scaffold.confirmLabel], ['confirm', 'Update work: CSV export v2', 'Export invoices as CSV.', 'Update work']);
  assert.deepEqual(scaffold.blocks?.map((b) => b.type), ['text', 'callout', 'table']);
  assert.deepEqual(scaffold.fields?.map((f) => [f.key, f.type, f.default]), [['replaceStack', 'toggle', false]]);
  assert.deepEqual(ask.list('work:csv-export')[0].proposed, { kind: 'work', title: 'CSV export v2' });
  const applied = await cards.answer(scaffold.id, { approved: true, values: { replaceStack: true } });
  assert.deepEqual([applied.result?.ok, applied.result?.detail, applied.result?.link], [true, 'updated work csv-export', '#/work/csv-export']);
  assert.equal(saved[0].stack?.[0].planned?.branch, 'feat/csv-api');
  assert.match(told[0], /\nApproved\nReplace its 1 stack rows with the planned stack: yes\nDone: updated work csv-export\n/);
  assert.equal(JSON.parse(told[0].split('```json\n')[1].split('\n```')[0]).result.link, '#/work/csv-export');

  const rejected = await propose('dispatch', { entry: 'ask', pr: 12, prompt: 'What is left?' });
  assert.equal(rejected.title, 'Start agent: ask on #12');
  const no = await cards.answer(rejected.id, { approved: false, other: 'Not now' });
  assert.deepEqual([no.result, dispatched], [undefined, []]);
  const failed = await cards.answer((await propose('dispatch', { entry: 'broken' })).id, { approved: true });
  assert.deepEqual([failed.result?.ok, failed.result?.detail], [false, 'no catalog entry broken']);
  assert.match(told.at(-1) ?? '', /\nFailed: no catalog entry broken\n/);
  const sent = await cards.answer((await propose('dispatch', { entry: 'ask', pr: 12 })).id, { approved: true });
  assert.deepEqual([sent.result?.detail, sent.result?.link, dispatched.at(-1)], ['started Ask on #12', '#/work/csv-export/ag-agent-d', 'csv-export ask 12']);

  const agent = await propose('paseo_agent', { title: 'PR 1: endpoint', prompt: 'Build the endpoint', why: 'Starts PR 1', workspaceId: 'wks_repo', workSlug: 'csv-export' });
  assert.deepEqual([agent.title, agent.blocks?.map((b) => b.type)], ['Start agent: PR 1: endpoint', ['text', 'code']]);
  const started = await cards.answer(agent.id, { approved: true });
  const newAgent = daemon.calls.created[1];
  assert.equal(newAgent.prompt, 'Build the endpoint');
  assert.equal(newAgent.labels?.work, 'csv-export');
  assert.equal(started.result?.link, `#/work/csv-export/ag-${newAgent.id}`);
  assert.match(work.timeline[0].text, /^started Paseo agent "PR 1: endpoint" \(\w{8}\) from ask \w{8}: "Plan the CSV export"$/);

  const repo = await cards.answer((await propose('repo', { source: 'acme/gadgets', why: 'Its importer' })).id, { approved: true });
  assert.deepEqual([repo.result?.detail, repo.result?.link], ['gadgets cloned into /acme/gadgets · Paseo project gadgets', '#/repo/gadgets']);

  await assert.rejects(propose('dispatch', { entry: 'ask' }, '99999999-0000-4000-8000-000000000000'), /a dispatch needs a work: pass workSlug/);
  await assert.rejects(propose('work_scaffold', { slug: 'Bad Slug', title: 'x' }), /slug must be kebab-case/);
  await assert.rejects(propose('launch', {}), /action\.type must be one of work_scaffold, paseo_agent, dispatch, repo/);
});

test('the composer’s model and thinking start the agent, switch the live one on a follow-up, carry to the next agent, and a bad pick starts nothing', async () => {
  const daemon = fakeDaemon();
  const catalog = { mode: 'auto', defaults: config.models, providers: [{ id: 'claude', error: null, models: ['claude-opus-5-5', 'claude-sonnet-5-5'].map((id) => ({ id, label: id, description: null, aliases: [], thinking: [{ id: 'low', label: 'low' }, { id: 'max', label: 'max' }], defaultThinking: null })) }] };
  const applied: unknown[] = [];
  const models = { check: async (pick: ModelPick, fallback?: string | null) => checkPick(catalog, pick, fallback), apply: async (id: string, pick: ModelPick) => (applied.push([id, pick]), { provider: null, thinking: null, changed: true }) };
  const ask = createAsk({ DATA: tmpDir(), APP, REPO, config, works, agents: createPaseoAgents({ APP, connect: daemon.connect }), models });
  const call = async (parts: string[], body: Record<string, unknown>) => {
    const req = new IncomingMessage(new Socket());
    Object.assign(req, { method: 'POST', url: `/api/${parts.join('/')}` });
    let out: { code: number; body: { id?: string; error?: string } } = { code: 0, body: {} };
    await ask.handle(req, new ServerResponse(req), parts, async () => JSON.stringify(body), (_res, code, b) => void (out = { code, body: b as { id?: string; error?: string } }));
    return out;
  };

  const bad = await call(['ask'], { prompt: 'Review it', provider: 'claude/claude-sonnet-5-5', thinking: 'medium' });
  assert.deepEqual([bad.code, bad.body.error], [400, 'claude-sonnet-5-5 has no thinking level medium: pick one of low, max']);
  assert.equal(daemon.calls.created.length, 0);

  const { body } = await call(['ask'], { prompt: 'Review it', provider: 'claude/claude-sonnet-5-5', thinking: 'low' });
  await until(() => daemon.calls.sent.length === 1, 'first send');
  const [first] = daemon.calls.created;
  assert.deepEqual([first.config.provider, first.config.thinkingOptionId], ['claude/claude-sonnet-5-5', 'low']);
  assert.match(String(first.config.systemPrompt), /subagents on the fast model claude-sonnet-5-5/);
  const conv = ask.load(String(body.id));
  assert.ok(conv);
  daemon.finish(first.id, 'Done.');
  await until(() => ends(conv) === 1, 'first turn end');

  assert.equal((await call(['ask', conv.id, 'messages'], { text: 'Go deeper', provider: 'claude/claude-opus-5-5', thinking: 'max' })).code, 200);
  await call(['ask', conv.id, 'messages'], { text: 'And again', provider: 'claude/claude-opus-5-5', thinking: 'max' });
  assert.deepEqual(applied, [[first.id, { provider: 'claude/claude-opus-5-5', thinking: 'max' }]]);
  assert.deepEqual([conv.model, conv.thinking], ['claude/claude-opus-5-5', 'max']);
  assert.ok(conv.events.some((e) => e.type === 'meta' && e.text === 'model claude/claude-opus-5-5 · thinking max'));

  await until(() => daemon.calls.sent.length === 3, 'follow-up and steer sends');
  daemon.finish(first.id, 'Deeper.');
  await until(() => conv.status === 'idle', 'idle again');
  await ask.close(conv.id);
  await ask.say(conv.id, 'Once more');
  await until(() => daemon.calls.created.length === 2, 'next agent');
  assert.deepEqual([daemon.calls.created[1].config.provider, daemon.calls.created[1].config.thinkingOptionId], ['claude/claude-opus-5-5', 'max']);
});
