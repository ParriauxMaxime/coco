import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubagents } from './subagents.ts';
import type { SubagentApi, SubagentUpdate } from './subagents.ts';
import { createWorkAgents } from './work-agents.ts';
import type { DaemonClient } from './paseo-agent.ts';
import type { Sink } from './events.ts';

const PARENT = 'parent-1';
const sub = (id: string, status: string, createdAt: string, description = `do ${id}`) => ({ id, parentAgentId: PARENT, provider: 'claude', title: 'fork', description, status, createdAt, updatedAt: createdAt, toolCallId: id, subtitle: 'fork · Opus' });
const tool = (callId: string, command: string, status = 'completed') => ({ type: 'tool_call', callId, name: 'Bash', status, detail: { type: 'shell', command, output: 'ok' } });

function fakeSink() {
  const sent: { data: unknown; event?: string }[] = [];
  const closers: (() => void)[] = [];
  const sink: Sink & { close(): void } = {
    send: (json, event) => void sent.push({ data: JSON.parse(json), event }),
    onClose: (fn) => void closers.push(fn),
    closed: false,
    close: () => closers.forEach((fn) => fn()),
  };
  return { sink, sent };
}

function fakeClient({ subagents = [] as ReturnType<typeof sub>[], pages = [] as { rows: unknown[]; hasOlder: boolean }[], live = true } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let update: ((m: { type: string; payload?: unknown }) => void) | null = null;
  const client: SubagentApi = {
    listProviderSubagents: async (parent) => (calls.push({ method: 'list', args: [parent] }), { subagents: subagents.filter((s) => s.parentAgentId === parent) }),
    fetchProviderSubagentTimeline: async (parent, id, opts) => {
      calls.push({ method: 'timeline', args: [parent, id, opts] });
      const i = opts?.direction === 'before' ? (opts.cursor?.seq ?? 0) - 1 : pages.length - 1;
      const page = pages[i];
      return { epoch: 'e1', rows: page.rows as never, hasOlder: page.hasOlder, startCursor: { epoch: 'e1', seq: i }, endCursor: { epoch: 'e1', seq: 99 } };
    },
    ...(live
      ? {
          observeEvents: () => ({
            subscribe: (o) => void (update = o.update),
            ready: Promise.resolve(),
            release: async () => {},
          }),
        }
      : {}),
  };
  const push = (payload: SubagentUpdate) => update?.({ type: 'agent.provider_subagents.update', payload });
  return { client, calls, push };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("an agent's subagents: listed oldest first from Paseo, counted per parent, only parents that have some keyed", async () => {
  const { client } = fakeClient({ subagents: [sub('b', 'completed', '2026-10-27T10:05:00Z'), sub('a', 'running', '2026-10-27T10:00:00Z')] });
  const subs = createSubagents({ client: async () => client });
  assert.deepEqual((await subs.list(PARENT)).map((s) => [s.id, s.status, s.provider, s.description, s.subtitle]), [['a', 'running', 'claude', 'do a', 'fork · Opus'], ['b', 'completed', 'claude', 'do b', 'fork · Opus']]);
  assert.deepEqual(await subs.counts([PARENT, 'other']), { [PARENT]: { running: 1, total: 2 } });
  subs.close();
});

test('a daemon without subagent calls lists none and says it cannot show a timeline', async () => {
  const subs = createSubagents({ client: async () => ({}) });
  assert.deepEqual(await subs.list(PARENT), []);
  const { sink, sent } = fakeSink();
  await subs.watchTimeline(sink, PARENT, 'a');
  assert.deepEqual(sent.map((s) => s.data), [{ type: 'stderr', text: 'this Paseo daemon cannot show subagents' }]);
});

test("a subagent's timeline: older pages first as activity events, then live steps Paseo pushes, the ones already replayed skipped, then its end", async () => {
  const pages = [
    { rows: [{ item: { type: 'user_message', text: 'Split the PR' }, seq: 1 }, { item: tool('t1', 'git status'), seq: 2 }], hasOlder: false },
    { rows: [{ item: { type: 'assistant_message', text: 'Done with ', messageId: 'm1' }, seq: 3 }, { item: { type: 'assistant_message', text: 'PR 1.', messageId: 'm1' }, seq: 4 }], hasOlder: true },
  ];
  const { client, calls, push } = fakeClient({ subagents: [sub('a', 'running', '2026-10-27T10:00:00Z')], pages });
  const subs = createSubagents({ client: async () => client });
  const { sink, sent } = fakeSink();
  await subs.watchTimeline(sink, PARENT, 'a');
  assert.deepEqual(calls.filter((c) => c.method === 'timeline').map((c) => (c.args[2] as { direction: string }).direction), ['tail', 'before']);
  assert.deepEqual(sent.map((s) => s.data), [
    { type: 'user', text: 'Split the PR' },
    { type: 'tool', id: 't1', name: 'Bash', kind: 'shell', summary: 'git status', input: '', output: 'ok', status: 'completed' },
    { type: 'text', text: 'Done with PR 1.' },
  ]);
  sent.length = 0;
  push({ kind: 'timeline', parentAgentId: PARENT, subagentId: 'a', item: tool('t1', 'git status') as never, seq: 2, epoch: 'e1' });
  push({ kind: 'timeline', parentAgentId: PARENT, subagentId: 'other', item: tool('x', 'ls') as never, seq: 9, epoch: 'e1' });
  push({ kind: 'timeline', parentAgentId: PARENT, subagentId: 'a', item: tool('t2', 'npm test') as never, seq: 5, epoch: 'e1' });
  push({ kind: 'upsert', subagent: sub('a', 'completed', '2026-10-27T10:00:00Z') });
  assert.deepEqual(sent.map((s) => s.data), [
    { type: 'tool', id: 't2', name: 'Bash', kind: 'shell', summary: 'npm test', input: '', output: 'ok', status: 'completed' },
    { type: 'end', status: 'completed' },
  ]);
  sink.close();
  subs.close();
});

test('the list topic sends the subagents on subscribe and again when Paseo reports one started or stopped', async () => {
  const { client, push } = fakeClient({ subagents: [sub('a', 'running', '2026-10-27T10:00:00Z')] });
  const subs = createSubagents({ client: async () => client });
  const { sink, sent } = fakeSink();
  subs.watchList(sink, PARENT);
  await tick();
  assert.deepEqual(sent.map((s) => (s.data as { subagents: { id: string; status: string }[] }).subagents.map((x) => [x.id, x.status])), [[['a', 'running']]]);
  push({ kind: 'upsert', subagent: sub('a', 'completed', '2026-10-27T10:00:00Z') });
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual((sent.at(-1)?.data as { subagents: { status: string }[] }).subagents.map((x) => x.status), ['completed']);
  sink.close();
  subs.close();
});

test("a work's agents carry how many subagents each runs; archived agents are not asked", async () => {
  const asked: string[][] = [];
  const client = {
    agents: {
      list: async () => ({ entries: [{ agent: { id: 'busy', title: 'coco · Busy', labels: { work: 'csv' }, status: 'running' } }, { agent: { id: 'old', title: 'coco · Old', labels: { work: 'csv' }, status: 'idle', archivedAt: '2026-10-26T10:00:00Z' } }] }),
      ref: () => ({ refresh: async () => ({ agent: null }) }),
    },
  } as unknown as DaemonClient;
  const agents = createWorkAgents({
    client: async () => client,
    asks: () => [],
    linked: () => [],
    onAgent: () => () => {},
    serverId: async () => null,
    subagents: { counts: async (ids) => (asked.push(ids), { busy: { running: 2, total: 3 } }), onChange: () => () => {} },
  });
  assert.deepEqual((await agents.list('csv')).map((a) => [a.id, a.subagents]), [['ag-busy', { running: 2, total: 3 }], ['ag-old', { running: 0, total: 0 }]]);
  assert.deepEqual(asked, [['busy']]);
});
