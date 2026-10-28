import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createAgentControls } from './agent-controls.ts';
import { createModels } from './models.ts';
import type { ModelsClient } from './models.ts';

const MODES = [{ id: 'plan', label: 'Plan Mode' }, { id: 'default', label: 'Always Ask' }, { id: 'auto', label: 'Auto mode', colorTier: 'moderate' }, { id: 'bypassPermissions', label: 'Bypass', colorTier: 'dangerous' }];
type Agent = { id: string; title: string; provider: string; currentModeId: string; availableModes?: typeof MODES; status: string; archivedAt?: string | null };

function setup(agents: Record<string, Agent>) {
  const calls = { mode: [] as [string, string][], names: [] as [string, unknown][], renamed: [] as [string, string][], fetched: [] as unknown[] };
  const client = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents[id] ?? null }),
        commands: async () => ({ commands: [{ name: 'review', description: 'Review the diff', argumentHint: '[pr]', kind: 'skill' }, { name: '__remote-workflow', description: 'internal' }, { name: 'compact', kind: 'command' }], error: null }),
        timeline: { refetch: async (opts: unknown) => (calls.fetched.push(opts), { entries: [{ item: { type: 'user_message', text: 'Look back at the whole afternoon, then plan the next steps in full' } }] }) },
      }),
    },
    providers: { listModels: async () => ({ models: [{ id: 'opus', label: 'Opus' }] }), snapshot: async () => ({ entries: [{ provider: 'claude', status: 'ready', modes: MODES, defaultModeId: 'auto' }] }) },
    setAgentMode: async (id: string, m: string) => void calls.mode.push([id, m]),
    updateAgent: async (id: string, u: unknown) => void calls.names.push([id, u]),
    listAgentTimelinePrompts: async () => ({ epoch: 'ep1', prompts: [{ seq: 1, timestamp: '2026-10-28T17:00:00Z', preview: 'Look back at the whole afternoon…' }, { seq: 40, timestamp: '2026-10-28T18:00:00Z', preview: '/goal ship it' }], error: null }),
  };
  const models = createModels({ client: async () => client as unknown as ModelsClient, config: { models: { default: 'claude/opus', fast: 'claude/opus' } } });
  const controls = createAgentControls({ client: async () => client as never, models, renamed: (id, t) => void calls.renamed.push([id, t]) });
  const call = async (method: string, u: string, body?: unknown) => {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = u;
    await controls.handle(req, new ServerResponse(req), u.split('/').filter(Boolean).slice(1), async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)), (_r, status, b) => void Object.assign(out, { status, body: b }));
    return out;
  };
  return { call, calls };
}

const live: Agent = { id: 'a1', title: 'coco · Fix review #12', provider: 'claude', currentModeId: 'auto', availableModes: MODES, status: 'idle' };

test("a live agent's mode: read with the modes it can take, switched now to one of them, refused when unknown, missing or archived", async () => {
  const { call, calls } = setup({ a1: live, old: { ...live, id: 'old', archivedAt: '2026-10-27T10:00:00Z' }, bare: { ...live, id: 'bare', availableModes: undefined } });
  const got = await call('GET', '/api/agent-chat/a1/mode');
  assert.equal(got.status, 200);
  assert.deepEqual([got.body?.mode, (got.body?.modes as { id: string }[]).map((m) => m.id), got.body?.defaultMode], ['auto', ['plan', 'default', 'auto', 'bypassPermissions'], 'auto']);
  assert.deepEqual((await call('GET', '/api/agent-chat/bare/mode')).body?.modes, [{ id: 'plan', label: 'Plan Mode', description: null, tier: null }, { id: 'default', label: 'Always Ask', description: null, tier: null }, { id: 'auto', label: 'Auto mode', description: null, tier: 'moderate' }, { id: 'bypassPermissions', label: 'Bypass', description: null, tier: 'dangerous' }]);
  assert.equal((await call('POST', '/api/agent-chat/a1/mode', { mode: 'plan' })).body?.changed, true);
  assert.equal((await call('POST', '/api/agent-chat/a1/mode', { mode: 'auto' })).body?.changed, false);
  assert.deepEqual(calls.mode, [['a1', 'plan']]);
  assert.match(String((await call('POST', '/api/agent-chat/a1/mode', { mode: 'yolo' })).body?.error), /claude has no mode yolo: pick one of plan, default, auto, bypassPermissions/);
  for (const body of [{}, { mode: 3 }, { mode: ' ' }]) assert.equal((await call('POST', '/api/agent-chat/a1/mode', body)).status, 400);
  assert.equal((await call('POST', '/api/agent-chat/a1/mode', '{oops')).status, 400);
  assert.equal((await call('POST', '/api/agent-chat/old/mode', { mode: 'plan' })).status, 409);
  assert.equal((await call('GET', '/api/agent-chat/gone/mode')).status, 404);
  assert.equal((await call('GET', '/api/agent-chat/..%2Fx/mode')).status, 400);
  assert.equal(calls.mode.length, 1);
});

test('its slash commands sorted without internal ones, and its latest prompts oldest first with a clipped one read in full', async () => {
  const { call, calls } = setup({ a1: live });
  assert.deepEqual((await call('GET', '/api/agent-chat/a1/commands')).body, { commands: [{ name: 'compact', description: '', hint: '', kind: 'command' }, { name: 'review', description: 'Review the diff', hint: '[pr]', kind: 'skill' }], error: null });
  assert.deepEqual((await call('GET', '/api/agent-chat/a1/prompts')).body, { prompts: [{ text: 'Look back at the whole afternoon, then plan the next steps in full', at: '2026-10-28T17:00:00Z' }, { text: '/goal ship it', at: '2026-10-28T18:00:00Z' }] });
  assert.deepEqual(calls.fetched, [{ direction: 'after', cursor: { epoch: 'ep1', seq: 0 }, limit: 1, projection: 'projected' }]);
});

test('a rename goes to Paseo, keeps the coco prefix of an agent coco started and tells coco; a bad name is refused before Paseo', async () => {
  const { call, calls } = setup({ a1: live, mine: { ...live, id: 'mine', title: 'my session' } });
  assert.deepEqual((await call('POST', '/api/agent-chat/a1/rename', { name: '  CSV   export\nfix ' })).body, { ok: true, title: 'CSV export fix' });
  assert.equal((await call('POST', '/api/agent-chat/mine/rename', { name: 'Leboncoin' })).status, 200);
  assert.deepEqual(calls.names, [['a1', { name: 'coco · CSV export fix' }], ['mine', { name: 'Leboncoin' }]]);
  assert.deepEqual(calls.renamed, [['a1', 'CSV export fix'], ['mine', 'Leboncoin']]);
  for (const body of [{}, { name: 42 }, { name: '   ' }, { name: 'x'.repeat(81) }]) assert.equal((await call('POST', '/api/agent-chat/a1/rename', body)).status, 400);
  assert.equal((await call('POST', '/api/agent-chat/gone/rename', { name: 'x' })).status, 404);
  assert.equal((await call('GET', '/api/agent-chat/a1/rename')).status, 404);
  assert.equal(calls.names.length, 2);
});
