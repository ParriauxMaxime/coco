// The models and thinking levels a composer can pick, from Paseo, for the providers coco's config uses; a pick is checked against them on every start and say.
import { HttpError, errorMessage } from './core-types.ts';
import { AGENT_MODE } from './paseo-agent.ts';
import type { DaemonClient } from './paseo-agent.ts';

export type Thinking = { id: string; label: string };
export type ModelEntry = { id: string; label: string; description: string | null; aliases: string[]; thinking: Thinking[]; defaultThinking: string | null };
export type ProviderEntry = { id: string; models: ModelEntry[]; error: string | null };
export type Catalog = { mode: string; defaults: { default: string; fast: string }; providers: ProviderEntry[] };
export type ModelPick = { provider?: unknown; thinking?: unknown };
export type Picked = { provider?: string; thinking?: string };
export type Applied = { provider: string | null; thinking: string | null; changed: boolean };

type RawModel = { id: string; label?: string; description?: string; isSelectable?: boolean; aliases?: string[]; thinkingOptions?: { id: string; label?: string }[]; defaultThinkingOptionId?: string };
export type ModelsClient = Pick<DaemonClient, 'agents' | 'providers' | 'setAgentModel' | 'setAgentThinkingOption'>;
type Options = { client: () => Promise<ModelsClient>; config: { models: { default: string; fast: string } }; ttlMs?: number; retryMs?: number };

const TTL_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const family = (provider: string) => provider.split('/')[0];
const modelOf = (provider: string) => provider.split('/').slice(1).join('/');

const entryOf = (m: RawModel): ModelEntry => ({
  id: m.id,
  label: m.label || m.id,
  description: m.description || null,
  aliases: m.aliases || [],
  thinking: (m.thinkingOptions || []).map((t) => ({ id: t.id, label: t.label || t.id })),
  defaultThinking: m.defaultThinkingOptionId || null,
});

// a pick against the catalog: provider is `<provider>/<model id or alias>`, thinking one of that model's (fallback's when no provider is picked)
export function checkPick(catalog: Catalog, pick: ModelPick, fallback?: string | null): Picked {
  const provider = typeof pick.provider === 'string' && pick.provider.trim() ? pick.provider.trim() : null;
  const thinking = typeof pick.thinking === 'string' && pick.thinking.trim() ? pick.thinking.trim() : null;
  if (pick.provider != null && typeof pick.provider !== 'string') throw new HttpError(400, 'provider must be a string');
  if (pick.thinking != null && typeof pick.thinking !== 'string') throw new HttpError(400, 'thinking must be a string');
  if (!provider && !thinking) return {};
  const find = (p: string) => {
    const entry = catalog.providers.find((x) => x.id === family(p));
    const id = modelOf(p);
    return entry?.models.find((m) => m.id === id) || entry?.models.find((m) => m.aliases.includes(id)) || null;
  };
  const known = catalog.providers.filter((p) => p.models.length).map((p) => p.id);
  if (provider && !known.includes(family(provider))) throw new HttpError(400, known.length ? `unknown provider ${family(provider)}: pick one of ${known.join(', ')}` : `no model list from Paseo: ${catalog.providers.map((p) => p.error).filter(Boolean).join('; ') || 'no provider'}`);
  const model = provider ? find(provider) : fallback ? find(fallback) : null;
  if (provider && !model) throw new HttpError(400, `unknown model ${provider}`);
  if (thinking && model && !model.thinking.some((t) => t.id === thinking)) throw new HttpError(400, `${model.label} has no thinking level ${thinking}: pick one of ${model.thinking.map((t) => t.id).join(', ') || 'none'}`);
  if (thinking && !model) throw new HttpError(400, `cannot check thinking ${thinking}: unknown model ${fallback || '(none)'}`);
  return { ...(provider ? { provider: `${family(provider)}/${model?.id}` } : {}), ...(thinking ? { thinking } : {}) };
}

export function createModels({ client, config, ttlMs = TTL_MS, retryMs = RETRY_MS }: Options) {
  let cached: { at: number; ttl: number; value: Promise<Catalog> } | null = null;
  const families = () => [...new Set([config.models.default, config.models.fast].filter(Boolean).map(family))];

  async function load(): Promise<Catalog> {
    const c = await client();
    const providers = await Promise.all(
      families().map(async (id): Promise<ProviderEntry> => {
        try {
          if (!c.providers) throw new Error('this Paseo client cannot list models');
          const r = await c.providers.listModels(id);
          const models = (r.models || []).filter((m) => m.isSelectable !== false).map(entryOf);
          return { id, models, error: models.length ? null : r.error || 'no model listed' };
        } catch (e) {
          return { id, models: [], error: errorMessage(e) };
        }
      }),
    );
    return { mode: AGENT_MODE, defaults: { default: config.models.default, fast: config.models.fast }, providers };
  }

  // a list with a provider that failed is kept only briefly, so the next open retries
  function list(): Promise<Catalog> {
    if (cached && Date.now() - cached.at < cached.ttl) return cached.value;
    const value = load().catch((e) => ({ mode: AGENT_MODE, defaults: { default: config.models.default, fast: config.models.fast }, providers: families().map((id) => ({ id, models: [], error: errorMessage(e) })) }));
    const entry = { at: Date.now(), ttl: ttlMs, value };
    cached = entry;
    value.then((cat) => { if (cat.providers.some((p) => p.error)) entry.ttl = retryMs; });
    return value;
  }

  const check = async (pick: ModelPick, fallback?: string | null) => checkPick(await list(), pick, fallback);

  // changes a live agent's model and thinking in place; a pick of another provider cannot apply to it
  async function apply(agentId: string, pick: ModelPick): Promise<Applied> {
    const c = await client();
    const found = (await c.agents.ref(agentId).refresh())?.agent;
    if (!found || found.archivedAt || found.status === 'closed') throw new HttpError(409, 'this agent is archived');
    const current = found.provider && found.model ? `${found.provider}/${found.model}` : null;
    const picked = await check(pick, current);
    const now = { provider: current, thinking: found.thinkingOptionId ?? null, changed: false };
    if (picked.provider && found.provider && family(picked.provider) !== found.provider) throw new HttpError(400, `a live ${found.provider} agent cannot switch to ${family(picked.provider)}: start a new agent for it`);
    if (picked.provider && picked.provider !== current) {
      if (!c.setAgentModel) throw new HttpError(501, 'this Paseo client cannot change a model');
      await c.setAgentModel(agentId, modelOf(picked.provider));
      Object.assign(now, { provider: picked.provider, changed: true });
    }
    if (picked.thinking && picked.thinking !== now.thinking) {
      if (!c.setAgentThinkingOption) throw new HttpError(501, 'this Paseo client cannot change a thinking level');
      await c.setAgentThinkingOption(agentId, picked.thinking);
      Object.assign(now, { thinking: picked.thinking, changed: true });
    }
    return now;
  }

  return { list, check, apply };
}
export type Models = ReturnType<typeof createModels>;
