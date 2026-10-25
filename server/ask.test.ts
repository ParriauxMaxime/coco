import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaseoAgents } from './paseo-agent.ts';
import { createAsk } from './ask.ts';
import { DEFAULTS } from './config.ts';

const APP = '/opt/coco';
const REPO = '/acme/widgets';
const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ask-test-'));
const until = async (cond, what = 'condition') => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// A daemon whose turns end when the test says so: send() opens a turn on an idle agent and joins the running one otherwise.
function fakeDaemon() {
  const agents = new Map();
  const calls = { created: [], sent: [], archived: [] };
  let seq = 0;
  const handle = (a) => ({
    id: a.id,
    workspaceId: a.workspaceId,
    get status() {
      return a.status;
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
    waitForFinish: () => (a.status === 'running' ? new Promise((resolve) => a.waiters.push(resolve)) : Promise.resolve({ status: 'idle', lastMessage: a.last, final: null, error: null })),
    refresh: async () => (agents.has(a.id) ? { agent: { id: a.id, status: a.status, archivedAt: a.archivedAt } } : null),
    archive: async () => {
      a.status = 'closed';
      a.archivedAt = 'now';
      calls.archived.push(a.id);
      return { archivedAt: 'now' };
    },
  });
  const client = {
    workspaces: {
      list: async () => ({ entries: [{ id: 'wks_repo', projectId: 'p1', workspaceDirectory: REPO }] }),
      ref: (w) => {
        const id = typeof w === 'string' ? w : w.id;
        return {
          id,
          agents: {
            create: async (opts) => {
              const a = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, workspaceId: id, status: 'idle', archivedAt: null, handlers: new Set(), waiters: [], last: null };
              agents.set(a.id, a);
              calls.created.push({ ...opts, id: a.id });
              return handle(a);
            },
          },
        };
      },
    },
    agents: { ref: (id) => (agents.has(id) ? handle(agents.get(id)) : { id, refresh: async () => null }) },
  };
  const emit = (a, event) => {
    for (const h of a.handlers) h({ agentId: a.id, event });
  };
  // the agent's running turn answers text (and an optional cocopilot proposal), then ends
  const finish = (id, text, { propose = null, cost = 0.1 } = {}) => {
    const a = agents.get(id);
    emit(a, { type: 'timeline', provider: 'claude', item: { type: 'assistant_message', text, messageId: `m${Math.random()}` } });
    if (propose) emit(a, { type: 'timeline', provider: 'claude', item: { type: 'tool_call', callId: `c${Math.random()}`, name: `mcp__cocopilot__${propose.tool}`, detail: { type: 'unknown', input: propose.input, output: { recorded: true } }, status: 'completed', error: null } });
    emit(a, { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: cost } });
    a.status = 'idle';
    a.last = text;
    for (const wake of a.waiters.splice(0)) wake({ status: 'idle', lastMessage: text, final: null, error: null });
  };
  return { connect: async () => client, calls, finish, agents, forget: (id) => agents.delete(id) };
}

const setup = (DATA = tmpDir(), daemon = fakeDaemon(), opts = {}) => ({ DATA, daemon, ask: createAsk({ DATA, APP, REPO, config, works: {}, agents: createPaseoAgents({ APP, connect: daemon.connect }), ...opts }) });
const types = (conv) => conv.events.filter((e) => e.type !== 'meta').map((e) => e.type);
const ends = (conv) => conv.events.filter((e) => e.type === 'end').length;

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
  assert.deepEqual(conv.proposal, { slug: 'widgets-export' });
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
  assert.equal(b.events.at(-1).type, 'closed');

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
  await until(() => ends(resumed) === 1, 'resumed turn end');
  assert.equal(resumed.status, 'idle');
  assert.ok(resumed.events.some((e) => e.type === 'meta' && /re-attached/.test(e.text)));
  assert.equal(resumed.events.filter((e) => e.type === 'text').at(-1).text, '#12 and #13.');

  await after.say(idle.id, 'Which one first?');
  await until(() => daemon.calls.sent.length === 3, 'follow-up send');
  assert.deepEqual(daemon.calls.sent[2], { agentId: ii, text: 'Which one first?', behavior: 'steer', busy: false });
  assert.equal(daemon.calls.created.length, 2);
});

test('after a restart, a conversation whose agent is gone starts a new one fed the conversation so far', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon();
  const before = setup(DATA, daemon).ask;
  const conv = before.start({ prompt: 'Scaffold the gadgets import' });
  await until(() => daemon.calls.sent.length === 1, 'first send');
  const old = daemon.calls.created[0].id;
  daemon.finish(old, 'Proposed.', { propose: { tool: 'propose_work_scaffold', input: { slug: 'gadgets-import' } } });
  await until(() => ends(conv) === 1, 'first turn');
  daemon.forget(old);

  const after = setup(DATA, daemon).ask;
  await after.say(conv.id, 'Split the UI PR.');
  await until(() => daemon.calls.sent.length === 2, 'fallback send');
  const reloaded = after.load(conv.id);
  assert.notEqual(reloaded.agentId, old);
  assert.equal(daemon.calls.created.length, 2);
  assert.ok(reloaded.events.some((e) => e.type === 'meta' && /is gone: a new one starts/.test(e.text)));
  const prompt = daemon.calls.sent[1].text;
  assert.match(prompt, /\*\*Alice:\*\* Scaffold the gadgets import\n\n\*\*coco:\*\* Proposed\./);
  assert.match(prompt, /You already proposed a work scaffold for `gadgets-import`/);
  assert.ok(prompt.endsWith('Split the UI PR.'));
  daemon.finish(reloaded.agentId, 'Split.');
  await until(() => ends(reloaded) === 2, 'fallback turn');
  assert.equal(reloaded.status, 'idle');
});

test('a one-shot run (rules) archives its agent after the first turn', async () => {
  const { ask, daemon } = setup();
  let ended = null;
  const conv = ask.start({ prompt: 'Distill rules' }, { once: true, onEnd: (c) => (ended = c) });
  await until(() => daemon.calls.sent.length === 1, 'send');
  daemon.finish(daemon.calls.created[0].id, 'None.', { propose: { tool: 'propose_rules', input: { rules: [] } } });
  await until(() => conv.status === 'closed', 'closed');
  assert.deepEqual(ended.rulesProposal, { rules: [] });
  assert.deepEqual(daemon.calls.archived, [daemon.calls.created[0].id]);
});
