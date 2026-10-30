import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPick, createModels, startThinking } from './models.ts';
import type { Catalog, ModelsClient } from './models.ts';

const config = { models: { default: 'claude/claude-opus-5-5', fast: 'claude/claude-sonnet-5-5' } };
const levels = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
const RAW = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Opus 5.5 · Latest release', thinkingOptions: levels('low', 'medium', 'high', 'max'), defaultThinkingOptionId: 'medium' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', aliases: ['sonnet'], thinkingOptions: levels('low', 'medium', 'high'), defaultThinkingOptionId: 'medium' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-hidden', label: 'Hidden', isSelectable: false },
];
const catalog = (): Catalog => ({
  mode: 'auto',
  defaults: config.models,
  providers: [{ id: 'claude', error: null, models: RAW.filter((m) => m.isSelectable !== false).map((m) => ({ id: m.id, label: m.label, description: m.description || null, aliases: m.aliases || [], thinking: m.thinkingOptions || [], defaultThinking: m.defaultThinkingOptionId || null })) }],
});

type Snapshot = { provider: string; model: string; thinkingOptionId: string | null; status: string; archivedAt?: string | null };
function fakeClient({ fail = 0, agent = { provider: 'claude', model: 'claude-opus-5-5', thinkingOptionId: 'high', status: 'idle' } as Snapshot } = {}) {
  const calls = { listed: 0, model: [] as [string, string | null][], thinking: [] as [string, string | null][] };
  let failures = fail;
  const client = {
    agents: { ref: (id: string) => ({ id, refresh: async () => ({ agent: { id, ...agent } }) }) },
    providers: {
      listModels: async () => {
        calls.listed++;
        if (failures-- > 0) throw new Error('daemon busy');
        return { models: RAW };
      },
    },
    setAgentModel: async (id: string, m: string | null) => void calls.model.push([id, m]),
    setAgentThinkingOption: async (id: string, t: string | null) => void calls.thinking.push([id, t]),
  } as unknown as ModelsClient;
  return { client, calls, agent };
}

test('a pick is checked against Paseo’s list: a model by id or alias comes back as provider/id, a thinking level must be one of that model’s', () => {
  const cat = catalog();
  assert.deepEqual(checkPick(cat, {}), {});
  assert.deepEqual(checkPick(cat, { provider: 'claude/claude-opus-5-5', thinking: 'max' }), { provider: 'claude/claude-opus-5-5', thinking: 'max' });
  assert.deepEqual(checkPick(cat, { provider: 'claude/sonnet' }), { provider: 'claude/claude-sonnet-5-5' });
  assert.deepEqual(checkPick(cat, { thinking: 'low' }, config.models.fast), { thinking: 'low' });
  assert.throws(() => checkPick(cat, { provider: 'claude/claude-hidden' }), /unknown model claude\/claude-hidden/);
  assert.throws(() => checkPick(cat, { provider: 'codex/gpt' }), /unknown provider codex: pick one of claude/);
  assert.throws(() => checkPick(cat, { provider: 'claude/claude-sonnet-5-5', thinking: 'max' }), /Sonnet 5\.5 has no thinking level max: pick one of low, medium, high/);
  assert.throws(() => checkPick(cat, { thinking: 'max' }, config.models.fast), /no thinking level max/);
  assert.throws(() => checkPick(cat, { provider: 'claude/claude-haiku-4-5', thinking: 'low' }), /pick one of none/);
  assert.throws(() => checkPick(cat, { provider: 42 }), (e: Error & { status?: number }) => e.status === 400 && /provider must be a string/.test(e.message));
});

test('the model list is read once per provider coco uses and cached; a failed read is retried soon instead of kept', async () => {
  const { client, calls } = fakeClient({ fail: 2 });
  const models = createModels({ client: async () => client, config, retryMs: 0 });
  const failed = await models.list();
  assert.equal(failed.mode, 'auto');
  assert.deepEqual(failed.providers, [{ id: 'claude', models: [], error: 'daemon busy' }]);
  await assert.rejects(models.check({ provider: 'claude/claude-opus-5-5' }), /no model list from Paseo: daemon busy/);
  const listed = await models.list();
  assert.deepEqual(listed.providers[0].models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
  assert.deepEqual(listed.defaults, config.models);
  await models.list();
  await models.check({ provider: 'claude/sonnet' });
  assert.equal(calls.listed, 3);
});

test('a live agent switches model and thinking in place, only what changed, and never to another provider', async () => {
  const { client, calls, agent } = fakeClient();
  const models = createModels({ client: async () => client, config });
  assert.deepEqual(await models.apply('a1', { thinking: 'high' }), { provider: 'claude/claude-opus-5-5', thinking: 'high', changed: false });
  assert.deepEqual(await models.apply('a1', { provider: 'claude/sonnet', thinking: 'low' }), { provider: 'claude/claude-sonnet-5-5', thinking: 'low', changed: true });
  assert.deepEqual(calls.model, [['a1', 'claude-sonnet-5-5']]);
  assert.deepEqual(calls.thinking, [['a1', 'low']]);
  await assert.rejects(models.apply('a1', { thinking: 'ultra' }), /Opus 5\.5 has no thinking level ultra/);
  Object.assign(agent, { provider: 'codex', model: 'gpt-5' });
  await assert.rejects(models.apply('a1', { provider: 'claude/claude-opus-5-5' }), /a live codex agent cannot switch to claude/);
  Object.assign(agent, { provider: 'claude', model: 'claude-opus-5-5', archivedAt: 'now' });
  await assert.rejects(models.apply('a1', { thinking: 'low' }), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(calls.model.length, 1);
});

test('every provider Paseo has ready is offered after the ones coco uses, with its label and modes; one not ready or listing no model is left out', async () => {
  const listed: string[] = [];
  const entries = [
    { provider: 'claude', status: 'ready', label: 'Claude', modes: [{ id: 'auto', label: 'Auto mode' }], defaultModeId: 'auto' },
    { provider: 'codex', status: 'unavailable', label: 'Codex' },
    { provider: 'opencode', status: 'ready', label: 'OpenCode', modes: [{ id: 'build', label: 'Build' }] },
    { provider: 'omp', status: 'ready', enabled: false },
    { provider: 'claude-perso', status: 'ready', label: 'Claude (Perso)', modes: [{ id: 'plan', label: 'Plan Mode', colorTier: 'planning' }], defaultModeId: 'auto' },
  ];
  const client = {
    providers: {
      snapshot: async () => ({ entries }),
      listModels: async (id: string) => (listed.push(id), id === 'opencode' ? { models: [], error: 'no auth' } : { models: RAW }),
    },
  } as unknown as ModelsClient;
  const cat = await createModels({ client: async () => client, config }).list();
  assert.deepEqual(listed, ['claude', 'claude-perso', 'opencode']);
  assert.deepEqual(cat.providers.map((p) => [p.id, p.label, p.models.length, p.modes?.map((m) => m.id), p.defaultMode]), [['claude', 'Claude', 3, ['auto'], 'auto'], ['claude-perso', 'Claude (Perso)', 3, ['plan'], 'auto']]);
  assert.deepEqual(checkPick(cat, { provider: 'claude-perso/sonnet', thinking: 'low' }), { provider: 'claude-perso/claude-sonnet-5-5', thinking: 'low' });
});

test('the starting thinking level is models.thinking on the default provider family only, else the call site’s own level', () => {
  const models = { default: 'omp/openrouter-deepseek', fast: 'omp/openrouter-deepseek', thinking: 'auto' };
  assert.equal(startThinking(models, 'omp/openrouter-deepseek'), 'auto');
  assert.equal(startThinking(models, 'omp/another-model', 'high'), 'auto');
  assert.equal(startThinking(models, 'claude/claude-opus-5-5', 'high'), 'high');
  assert.equal(startThinking(models, 'claude/claude-opus-5-5'), undefined);
  assert.equal(startThinking({ default: 'omp/x' }, 'omp/y', 'high'), 'high');
  assert.equal(startThinking({ default: 'omp/y' }, 'claude/x', 'high'), 'high');
});
