import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createWorkAgents } from './work-agents.ts';
import type { DaemonClient } from './paseo-agent.ts';
import type { AgentSnapshot } from './permissions.ts';
import type { ChatSnapshot } from './chat-snapshots.ts';

const ASK = '11111111-2222-3333-4444-555555555555';

function setup({ listed = [], refreshed = {} }: { listed?: AgentSnapshot[]; refreshed?: Record<string, AgentSnapshot> }) {
  const filters: unknown[] = [];
  const client = {
    agents: {
      list: async (opts: Record<string, unknown>) => (filters.push(opts.filter), { entries: listed.map((agent) => ({ agent })) }),
      ref: (id: string) => ({ refresh: async () => ({ agent: refreshed[id] ?? null }) }),
    },
  } as unknown as DaemonClient;
  const agents = createWorkAgents({
    client: async () => client,
    asks: () => [{ id: ASK, prompt: 'Who reviews #12?\nmore', kind: 'ask', pr: 12, status: 'parked', agentId: 'ask-agent', startedAt: '2026-10-26T09:00:00Z' }],
    linked: () => [{ agentId: 'hand', key: 'b:feat:csv', title: null }, { agentId: 'review', key: 12, title: null }],
    onAgent: () => () => {},
    serverId: async () => 'srv_1',
  });
  return { agents, filters };
}

const cur = (seq: number, epoch = 'e1') => ({ epoch, seq });
const said = (text: string) => ({ item: { type: 'user_message', text } });
const answered = (text: string) => ({ item: { type: 'assistant_message', text } });

// one agent with a timeline: tail returns `tail`, after returns `after` (or a reset); every refetch and kept snapshot recorded
function chat({ updatedAt = 't2', status = 'idle', kept = null, tail = [], after = [], reset = false }: { updatedAt?: string; status?: string; kept?: ChatSnapshot | null; tail?: unknown[]; after?: unknown[]; reset?: boolean }) {
  const fetched: { direction: string; cursor?: unknown }[] = [];
  const put: ChatSnapshot[] = [];
  const agent = {
    refresh: async () => ({ agent: { id: 'a1', status, updatedAt } }),
    timeline: {
      subscribe: () => () => {},
      refetch: async ({ direction, cursor }: { direction: string; cursor?: unknown }) => {
        fetched.push({ direction, ...(cursor ? { cursor } : {}) });
        if (direction === 'after') return reset ? { reset: true, entries: tail, endCursor: cur(9, 'e2') } : { entries: after, endCursor: after.length ? cur(7) : null, hasNewer: false };
        return { entries: tail, endCursor: cur(5), hasOlder: false };
      },
    },
  };
  const client = { agents: { ref: () => agent } } as unknown as DaemonClient;
  const agents = createWorkAgents({
    client: async () => client,
    asks: () => [],
    linked: () => [],
    onAgent: () => () => {},
    serverId: async () => null,
    snapshots: { get: () => kept, put: (_id, s) => void put.push(s), drop: () => {} },
  });
  const sent: { event?: string; data: unknown }[] = [];
  const sink = { send: (json: string, event?: string) => void sent.push({ ...(event ? { event } : {}), data: JSON.parse(json) }), onClose: () => {}, closed: false };
  return { run: () => agents.watchChat(sink, 'a1'), fetched, put, histories: () => sent.filter((s) => s.event === 'history').map((s) => s.data) };
}

test('an agent without a snapshot replays its whole timeline as one history event, kept as its snapshot once idle', async () => {
  const c = chat({ tail: [said('go'), answered('done')] });
  await c.run();
  assert.deepEqual(c.histories(), [[{ type: 'user', text: 'go' }, { type: 'text', text: 'done' }]]);
  assert.deepEqual(c.put, [{ updatedAt: 't2', cursor: cur(5), events: [{ type: 'user', text: 'go' }, { type: 'text', text: 'done' }] }]);
});

test('a running agent is replayed but not kept', async () => {
  const c = chat({ status: 'running', tail: [said('go')] });
  await c.run();
  assert.equal(c.histories().length, 1);
  assert.deepEqual(c.put, []);
});

test('a snapshot as recent as the agent is sent alone, without reading Paseo', async () => {
  const events = [{ type: 'text', text: 'kept' }];
  const c = chat({ kept: { updatedAt: 't2', cursor: cur(5), events } });
  await c.run();
  assert.deepEqual(c.histories(), [events]);
  assert.deepEqual(c.fetched, []);
});

test('an older snapshot is sent first, then with the entries after its cursor', async () => {
  const c = chat({ kept: { updatedAt: 't1', cursor: cur(5), events: [{ type: 'text', text: 'kept' }] }, after: [said('more'), answered('again')] });
  await c.run();
  assert.deepEqual(c.fetched, [{ direction: 'after', cursor: cur(5) }]);
  assert.deepEqual(c.histories(), [[{ type: 'text', text: 'kept' }], [{ type: 'text', text: 'kept' }, { type: 'user', text: 'more' }, { type: 'text', text: 'again' }]]);
  assert.deepEqual(c.put.map((s) => [s.updatedAt, s.cursor]), [['t2', cur(7)]]);
});

test('a snapshot whose epoch Paseo no longer knows gives way to the whole timeline', async () => {
  const c = chat({ kept: { updatedAt: 't1', cursor: cur(5), events: [{ type: 'text', text: 'stale' }] }, reset: true, tail: [answered('fresh')] });
  await c.run();
  assert.deepEqual(c.fetched.map((f) => f.direction), ['after', 'tail']);
  assert.deepEqual(c.histories().at(-1), [{ type: 'text', text: 'fresh' }]);
});

test("an archived or deleted work's agents lose their snapshots, and so does an agent Paseo forgot", async () => {
  const dropped: string[] = [];
  const client = { agents: { list: async () => ({ entries: [{ agent: { id: 'review', labels: { work: 'csv' }, status: 'idle' } }] }), ref: () => ({ refresh: async () => ({ agent: null }) }) } } as unknown as DaemonClient;
  const agents = createWorkAgents({
    client: async () => client,
    asks: () => [],
    linked: () => [{ agentId: 'hand', key: 12, title: null }],
    onAgent: () => () => {},
    serverId: async () => null,
    snapshots: { get: () => null, put: () => {}, drop: (id) => void dropped.push(id) },
  });
  await agents.forget('csv');
  assert.deepEqual(dropped, ['review', 'hand']);
  await agents.watchChat({ send: () => {}, onClose: () => {}, closed: false }, 'gone');
  assert.deepEqual(dropped, ['review', 'hand', 'gone']);
});

test("a work's agents: its Ask conversations, the Paseo agents labelled with it and those linked to its rows, each once with its status and row", async () => {
  const { agents, filters } = setup({
    listed: [
      { id: 'review', title: 'coco · Fix review #12 (3)', labels: { kind: 'review', work: 'csv', pr: '12' }, status: 'running' },
      { id: 'brief', title: 'coco · Brief', labels: { kind: 'brief', work: 'csv', pr: 'b~feat~csv' }, status: 'idle' },
      { id: 'gate', title: 'coco · Gate tests', labels: { kind: 'gate', work: 'csv' }, status: 'idle', archivedAt: '2026-10-26T10:00:00Z' },
      { id: 'ask-agent', title: 'coco · Ask: Who reviews #12?', labels: { kind: 'ask', ask: ASK.slice(0, 8), work: 'csv' }, status: 'error' },
    ],
    refreshed: { hand: { id: 'hand', title: 'my session', status: 'error' } },
  });
  const list = await agents.list('csv');
  assert.deepEqual(filters, [{ labels: { work: 'csv' }, includeArchived: true, includeBackground: true }]);
  assert.deepEqual(list.map((a) => [a.id, a.kind, a.status, a.pr, a.title]), [
    [`ask-${ASK}`, 'ask', 'archived', '12', 'Who reviews #12?'],
    ['ag-review', 'review', 'running', '12', 'Fix review #12 (3)'],
    ['ag-brief', 'brief', 'done', 'b:feat:csv', 'Brief'],
    ['ag-gate', 'gate', 'archived', null, 'Gate tests'],
    ['ag-hand', 'linked', 'failed', 'b:feat:csv', 'my session'],
  ]);
});

const call = async (handle: ReturnType<typeof createWorkAgents>['handle'], method: string, u: string, body?: unknown) => {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = u;
  await handle(req, new ServerResponse(req), u.split('/').filter(Boolean).slice(1), async () => (body === undefined ? '' : JSON.stringify(body)), (_r, status, b) => void Object.assign(out, { status, body: b }));
  return out;
};

test('any agent, in a work or not: its info for its own page, and a message to it closes its open cards as answered in chat', async () => {
  const said: [string, unknown][] = [];
  const chatted: string[][] = [];
  const ritual = { id: 'rit', title: 'coco · Persona refresh', labels: { kind: 'ritual' }, status: 'idle', provider: 'claude', model: 'opus', thinkingOptionId: 'high' };
  const client = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === 'rit' ? ritual : null }), send: async (text: string, opts: unknown) => void said.push([text, opts]) }) } } as unknown as DaemonClient;
  const agents = createWorkAgents({ client: async () => client, asks: () => [], linked: () => [], onAgent: () => () => {}, serverId: async () => 'srv_1', cards: { ofAgent: () => [], openCount: () => 2, onChange: () => () => {}, chatted: (ids) => void chatted.push(ids) } });
  const info = await call(agents.handle, 'GET', '/api/agent-chat/rit');
  assert.deepEqual(info.body && [info.body.title, info.body.kind, info.body.work, info.body.status, info.body.provider, info.body.thinking, info.body.serverId, info.body.openCards], ['Persona refresh', 'ritual', null, 'done', 'claude/opus', 'high', 'srv_1', 2]);
  assert.equal((await call(agents.handle, 'GET', '/api/agent-chat/gone')).status, 404);
  const r = await call(agents.handle, 'POST', '/api/agent-chat/rit/messages', { text: "Let's go with a sample of 6 months" });
  assert.equal(r.status, 200);
  assert.deepEqual(said, [["Let's go with a sample of 6 months", { activeTurnBehavior: 'steer' }]]);
  assert.deepEqual(chatted, [['rit']]);
  assert.equal((await call(agents.handle, 'POST', '/api/agent-chat/gone/messages', { text: 'hi' })).status, 404);
  assert.equal(chatted.length, 1);
});
