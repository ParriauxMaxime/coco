// A work's agents: the Paseo agents labelled with it, the agents linked to its rows and its Ask conversations, each with a status, live over SSE;
// and any of them as a chat: its Paseo timeline replayed then followed, follow-ups sent to it.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import { TITLE_PREFIX, activityEvents, createFollower, timelineOf } from './paseo-agent.ts';
import type { ActivityEvent, DaemonClient } from './paseo-agent.ts';
import { fromPaseo } from './agent-usage.ts';
import type { AgentUsage, PaseoUsage } from './agent-usage.ts';
import type { AgentSnapshot } from './permissions.ts';
import type { ReadBody, Req, Res, RowKey, Send } from './core-types.ts';
import { defaultExec } from './placement.ts';
import type { Exec } from './placement.ts';
import { randomUUID } from 'node:crypto';
import { FILES_ONLY, agentInput, uploadRef } from './uploads.ts';
import type { Upload, UploadRef, Uploads } from './uploads.ts';
import type { Models } from './models.ts';
import type { SubagentCount, Subagents } from './subagents.ts';

const PAGE = 200;
const SETTLE_MS = 500;
const REFRESH_MS = 30000;
const TITLE_MAX = 80;
const TURN_END = ['turn_completed', 'turn_failed', 'turn_canceled'];

export type WorkAgentStatus = 'running' | 'done' | 'failed' | 'archived';
// id is the agent's tab: ask-<conversation> or ag-<Paseo agent>
export type WorkAgent = { id: string; agentId: string | null; askId: string | null; kind: string; title: string; pr: string | null; status: WorkAgentStatus; updatedAt: string | null; subagents: SubagentCount } & Metrics;
// estimated tokens of the first prompt and the system prompt; inputTokens (cached reads included) and costUsd as Paseo reports them for the whole agent
// contextTokens of contextMax: its context window at its last turn
// openCards: asks it waits on the owner for, shown as waiting on you like a pending permission
type Metrics = { promptTokens: number | null; systemTokens: number | null; inputTokens: number | null; costUsd: number | null; contextTokens: number | null; contextMax: number | null; openCards: number };
type CardFeed = { ofAgent(agentId: string): unknown[]; openCount(agentId: string): number; onChange(l: (agentId: string) => void): () => void; chatted?(agentIds: string[]): unknown };

type AskMeta = { id: string; prompt: string; kind: string; pr?: RowKey | null; status: string; agentId: string | null; lastActivity?: string; startedAt: string };
type Linked = { agentId: string; key: RowKey; title: string | null };
type Options = {
  client: () => Promise<DaemonClient>;
  asks: (slug: string) => AskMeta[];
  linked: (slug: string) => Linked[];
  onAgent: (l: (agent: AgentSnapshot | null) => void) => () => void;
  serverId: () => Promise<string | null>;
  usage?: (agentId: string) => AgentUsage | null;
  cards?: CardFeed;
  uploads?: Pick<Uploads, 'resolve' | 'record' | 'pairer' | 'latest'>;
  exec?: Exec;
  // lines added to the owner's follow-up of a code-writing agent: its readied worktree, when that changed
  beforeTurn?: (agentId: string) => Promise<string[]>;
  closeAsk?: (id: string) => Promise<unknown>;
  // a follow-up's model or thinking pick, applied to the agent before the message
  models?: Pick<Models, 'apply'>;
  subagents?: Pick<Subagents, 'counts' | 'onChange'>;
};
const withFiles = (attachments?: UploadRef[]) => (attachments?.length ? { attachments } : {});

const statusOf = (a: { archivedAt?: unknown; status?: string | null }): WorkAgentStatus => (a.archivedAt || a.status === 'closed' ? 'archived' : a.status === 'error' ? 'failed' : a.status === 'idle' ? 'done' : 'running');
const ASK_STATUS: Record<string, WorkAgentStatus> = { running: 'running', idle: 'done', error: 'failed' };
const titleOf = (title: string | null | undefined, id: string) => (title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX) || id.slice(0, 8);


export function createWorkAgents({ client, asks, linked, onAgent, serverId, usage, cards, uploads, exec = defaultExec, beforeTurn, closeAsk, models, subagents }: Options) {
  let server: Promise<string | null> | null = null;
  const serverOf = () => (server ||= serverId().catch(() => ((server = null), null)));
  const metrics = (agentId: string | null, live?: PaseoUsage | null): Metrics => {
    const kept = agentId ? usage?.(agentId) : null;
    const now = fromPaseo(live);
    return { promptTokens: kept?.promptTokens ?? null, systemTokens: kept?.systemTokens ?? null, inputTokens: now.inputTokens ?? kept?.inputTokens ?? null, costUsd: now.costUsd ?? kept?.costUsd ?? null, contextTokens: now.contextTokens ?? kept?.contextTokens ?? null, contextMax: now.contextMax ?? kept?.contextMax ?? null, openCards: agentId ? cards?.openCount(agentId) ?? 0 : 0 };
  };

  async function list(slug: string): Promise<WorkAgent[]> {
    const listed = await listAgents(slug);
    const live = listed.flatMap((a) => (a.agentId && a.status !== 'archived' ? [a.agentId] : []));
    const counts = subagents ? await subagents.counts(live) : {};
    return listed.map((a) => ({ ...a, subagents: (a.agentId && counts[a.agentId]) || { running: 0, total: 0 } }));
  }

  async function listAgents(slug: string): Promise<Omit<WorkAgent, 'subagents'>[]> {
    const c = await client();
    if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
    const page = await c.agents.list({ includeBackground: true, filter: { labels: { work: slug }, includeArchived: true, includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: PAGE } });
    const labelled = page.entries.map((e) => e.agent).filter((a) => !a.labels?.ask);
    const seen = new Set(labelled.map((a) => a.id));
    const links = await Promise.all(linked(slug).filter((l) => !seen.has(l.agentId)).map(async (l) => ({ l, a: (await c.agents.ref(l.agentId).refresh().catch(() => null))?.agent ?? null })));
    return [
      ...asks(slug).map((m) => ({ id: `ask-${m.id}`, agentId: m.agentId, askId: m.id, kind: 'ask', title: m.prompt.split('\n')[0].slice(0, TITLE_MAX), pr: m.pr == null ? null : String(m.pr), status: ASK_STATUS[m.status] || 'archived', updatedAt: m.lastActivity || m.startedAt, ...metrics(m.agentId) })),
      ...labelled.map((a) => ({ id: `ag-${a.id}`, agentId: a.id, askId: null, kind: a.labels?.kind || 'agent', title: titleOf(a.title, a.id), pr: a.labels?.pr ? a.labels.pr.replaceAll('~', ':') : null, status: statusOf(a), updatedAt: a.updatedAt || null, ...metrics(a.id, a.lastUsage) })),
      ...links.map(({ l, a }) => ({ id: `ag-${l.agentId}`, agentId: l.agentId, askId: null, kind: 'linked', title: titleOf(a?.title ?? l.title, l.agentId), pr: String(l.key), status: a ? statusOf(a) : 'archived', updatedAt: a?.updatedAt || null, ...metrics(l.agentId, a?.lastUsage) })),
    ];
  }

  // the list on connect, then again shortly after Paseo reports a change on one of them, and every REFRESH_MS
  function watchList(sink: Sink, slug: string) {
    let last = '';
    let ids = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      const body = await Promise.all([list(slug), serverOf()]).then(
        ([agents, serverId]) => {
          ids = new Set(agents.flatMap((a) => (a.agentId ? [a.agentId] : [])));
          return JSON.stringify({ agents, serverId });
        },
        (e) => JSON.stringify({ error: errorMessage(e) }),
      );
      if (body !== last) sink.send((last = body));
    };
    const soon = () => {
      timer ||= setTimeout(() => {
        timer = null;
        void refresh();
      }, SETTLE_MS);
    };
    void refresh();
    const off = onAgent((a) => {
      if (!a || a.labels?.work === slug || ids.has(a.id)) soon();
    });
    const offCards = cards?.onChange((id) => ids.has(id) && soon());
    const offSubs = subagents?.onChange((id) => ids.has(id) && soon());
    const tick = setInterval(soon, REFRESH_MS);
    sink.onClose(() => {
      off();
      offCards?.();
      offSubs?.();
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    });
  }

  // what the agent did so far, then each new step while the tab watches; the owner's messages come as user events
  async function watchChat(sink: Sink, agentId: string) {
    const write = (ev: ActivityEvent) => sink.send(JSON.stringify(ev));
    const writeCards = () => cards && sink.send(JSON.stringify(cards.ofAgent(agentId)), 'cards');
    writeCards();
    const offCards = cards?.onChange((id) => id === agentId && writeCards());
    let off: (() => void) | null = null;
    sink.onClose(() => {
      off?.();
      offCards?.();
    });
    try {
      const agent = (await client()).agents.ref(agentId);
      if (!(await agent.refresh())?.agent) return write({ type: 'meta', text: 'Paseo no longer knows this agent' });
      const stream = activityEvents({ keep: write, live: write });
      const past = createFollower({ onEntry: stream.onEntry, agentId });
      const filesOf = uploads?.pairer(agentId);
      for (const { item } of await timelineOf(agent)) {
        if (item?.type === 'user_message') {
          past.end();
          write({ type: 'user', text: item.text, ...withFiles(filesOf?.(item)) });
        } else if (item) past.push({ agentId, event: { type: 'timeline', item } });
      }
      past.end();
      if (sink.closed) return;
      const live = createFollower({ onEntry: stream.onEntry, onDelta: stream.onDelta, onToolStart: stream.onToolStart, agentId });
      off = agent.timeline.subscribe((m) => {
        const ev = m?.event;
        if (ev?.type === 'subscription_restored') return write({ type: 'meta', text: 'Paseo reconnected: reopen this tab to see what the agent did meanwhile' });
        if (ev?.type === 'timeline' && ev.item?.type === 'user_message') {
          live.end();
          stream.flush();
          return write({ type: 'user', text: ev.item.text, ...withFiles(uploads?.latest(agentId, ev.item)) });
        }
        live.push(m);
        if (ev && TURN_END.includes(ev.type)) write({ type: 'end', status: ev.type.slice(5) });
      });
    } catch (e) {
      write({ type: 'stderr', text: errorMessage(e) });
    }
  }

  // files go along as Paseo images and attachments; coco records them since Paseo's timeline keeps only the text
  async function say(agentId: string, text: string, files: Upload[] = []) {
    const agent = (await client()).agents.ref(agentId);
    const found = (await agent.refresh())?.agent;
    if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
    if (statusOf(found) === 'archived') throw new HttpError(409, 'this agent is archived');
    const messageId = files.length ? randomUUID() : null;
    if (messageId) uploads?.record(agentId, { messageId, text, at: new Date().toISOString(), attachments: files.map(uploadRef) });
    await agent.send(text, { activeTurnBehavior: 'steer', ...(messageId ? { ...agentInput(files), messageId } : {}) });
    return { ok: true };
  }

  // the SDK has no interrupt: the CLI's `agent stop` ends the turn in flight (no-op on an idle agent)
  async function stop(agentId: string) {
    const r = await exec('paseo', ['agent', 'stop', agentId]);
    if (!r.ok) throw new HttpError(502, `paseo agent stop: ${(r.stderr || r.stdout).trim().slice(0, 200) || 'failed'}`);
    return { ok: true };
  }

  // ids are the work's listed agent ids; an Ask conversation is closed so it can start a new agent later
  async function archive(slug: string, ids: string[]) {
    const c = await client();
    const listed = (await listAgents(slug)).filter((a) => ids.includes(a.id) && a.status !== 'archived');
    const failed: { id: string; error: string }[] = [];
    await Promise.all(listed.map(async (a) => {
      try {
        if (a.askId && closeAsk) await closeAsk(a.askId);
        else if (a.agentId) await c.agents.ref(a.agentId).archive();
      } catch (e) {
        failed.push({ id: a.id, error: errorMessage(e) });
      }
    }));
    return { archived: listed.map((a) => a.id).filter((id) => !failed.some((f) => f.id === id)), failed };
  }

  // the work and stack row an agent's labels name
  async function placeOf(agentId: string) {
    const labels = (await (await client()).agents.ref(agentId).refresh())?.agent?.labels;
    return { work: labels?.work || null, pr: labels?.pr ? labels.pr.replaceAll('~', ':') : null };
  }

  // any Paseo agent, in a work or not: what its own page shows above its chat
  async function info(agentId: string) {
    const found = (await (await client()).agents.ref(agentId).refresh())?.agent;
    if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
    const l = found.labels;
    return {
      agentId,
      title: titleOf(found.title, agentId),
      kind: l?.kind || l?.ritual || 'agent',
      work: l?.work || null,
      pr: l?.pr ? l.pr.replaceAll('~', ':') : null,
      status: statusOf(found),
      updatedAt: found.updatedAt || null,
      provider: found.provider && found.model ? `${found.provider}/${found.model}` : found.provider || null,
      thinking: found.thinkingOptionId ?? null,
      mode: found.currentModeId ?? null,
      serverId: await serverOf(),
      ...metrics(agentId, found.lastUsage),
    };
  }

  // GET /api/works/<slug>/agents[/events] · GET /api/agent-chat/<agentId>[/events|place] · POST /api/agent-chat/<agentId>/messages|stop
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b, c] = parts;
    try {
      if (root === 'works' && b === 'agents' && c === 'events') return watchList(sseSink(req, res), a);
      if (root === 'works' && b === 'agents' && !c) return send(res, 200, { agents: await list(a), serverId: await serverOf() });
      if (root === 'works' && b === 'agents' && c === 'archive' && req.method === 'POST') {
        const { ids } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids required');
        return send(res, 200, await archive(a, ids.map(String)));
      }
      if (root === 'agent-chat' && a && b === 'events') return await watchChat(sseSink(req, res), a);
      if (root === 'agent-chat' && a && !b && req.method === 'GET') return send(res, 200, await info(a));
      if (root === 'agent-chat' && a && b === 'place' && req.method === 'GET') return send(res, 200, await placeOf(a));
      if (root === 'agent-chat' && a && b === 'stop' && req.method === 'POST') return send(res, 200, await stop(a));
      if (root === 'agent-chat' && a && b === 'messages' && req.method === 'POST') {
        const { text, attachments, provider, thinking } = JSON.parse((await readBody(req)) || '{}');
        const files = uploads?.resolve(attachments) ?? [];
        const said = String(text || '').trim() || (files.length ? FILES_ONLY : '');
        if (!said) throw new HttpError(400, 'text required');
        if (models && (provider != null || thinking != null)) await models.apply(a, { provider, thinking });
        const setup = (await beforeTurn?.(a).catch(() => [])) ?? [];
        const r = await say(a, setup.length ? `${said}\n\n${setup.join('\n')}` : said, files);
        cards?.chatted?.([a]);
        return send(res, 200, r);
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { list, handle, watchList, watchChat, say, placeOf, info };
}
