// A work's agents: the Paseo agents labelled with it, the agents linked to its rows and its Ask conversations, each with a status, live over SSE;
// and any of them as a chat: its Paseo timeline replayed then followed, follow-ups sent to it.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import { TITLE_PREFIX, activityEvents, createFollower, timelineAfter, timelineWithCursor } from './paseo-agent.ts';
import type { ActivityEvent, DaemonAgent, DaemonClient } from './paseo-agent.ts';
import type { ChatSnapshot, ChatSnapshots } from './chat-snapshots.ts';
import { fromPaseo } from './agent-usage.ts';
import type { AgentUsage, PaseoUsage } from './agent-usage.ts';
import type { AgentSnapshot } from './permissions.ts';
import { autoArchivable } from './finished-agents.ts';
import type { ReadBody, Req, Res, RowKey, Send } from './core-types.ts';
import { defaultExec } from './placement.ts';
import { swrCache } from './swr.ts';
import type { Exec } from './placement.ts';
import { randomUUID } from 'node:crypto';
import { FILES_ONLY, agentInput, uploadRef } from './uploads.ts';
import type { Upload, UploadRef, Uploads, UserItem } from './uploads.ts';
import type { Models } from './models.ts';
import type { SubagentCount, Subagents } from './subagents.ts';

const PAGE = 200;
const SETTLE_MS = 500;
const REFRESH_MS = 30000;
const LIST_TTL_MS = 5000;
const TITLE_MAX = 80;
const TURN_END = ['turn_completed', 'turn_failed', 'turn_canceled'];

export type WorkAgentStatus = 'running' | 'done' | 'failed' | 'archived';
// id is the agent's tab: ask-<conversation> or ag-<Paseo agent>; autoArchive: its job is done and its chat archives it on a visible timer
export type WorkAgent = { id: string; agentId: string | null; askId: string | null; kind: string; title: string; pr: string | null; status: WorkAgentStatus; updatedAt: string | null; autoArchive: boolean; subagents: SubagentCount } & Metrics;
// estimated tokens of the first prompt and the system prompt; inputTokens (cached reads included) and costUsd as Paseo reports them for the whole agent
// contextTokens of contextMax: its context window at its last turn
// openCards: asks it waits on the owner for, shown as waiting on you like a pending permission
type Metrics = { promptTokens: number | null; systemTokens: number | null; inputTokens: number | null; costUsd: number | null; contextTokens: number | null; contextMax: number | null; openCards: number };
type CardFeed = { ofAgent(agentId: string): unknown[]; openCount(agentId: string): number; onChange(l: (agentId: string) => void): () => void; chatted?(agentIds: string[]): unknown };

type AskMeta = { id: string; prompt: string; title?: string | null; kind: string; pr?: RowKey | null; status: string; agentId: string | null; lastActivity?: string; startedAt: string };
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
  // archives one agent through coco, which keeps its cards as when coco archives it itself; false once it is archived already
  archiveAgent?: (agentId: string) => Promise<boolean>;
  // agents a hand-off started: they never archive themselves
  handedOff?: () => string[];
  // a follow-up's model or thinking pick, applied to the agent before the message
  models?: Pick<Models, 'apply'>;
  subagents?: Pick<Subagents, 'counts' | 'onChange'>;
  snapshots?: Pick<ChatSnapshots, 'get' | 'put' | 'drop'>;
  // the row a label's key names now: a branch key of a row that since got its PR is its number
  keyOf?: (slug: string, key: string) => string;
};
type TimelineEntries = Awaited<ReturnType<typeof timelineWithCursor>>['entries'];
const withFiles = (attachments?: UploadRef[]) => (attachments?.length ? { attachments } : {});

const statusOf = (a: { archivedAt?: unknown; status?: string | null }): WorkAgentStatus => (a.archivedAt || a.status === 'closed' ? 'archived' : a.status === 'error' ? 'failed' : a.status === 'idle' ? 'done' : 'running');
const ASK_STATUS: Record<string, WorkAgentStatus> = { running: 'running', idle: 'done', error: 'failed' };
const titleOf = (title: string | null | undefined, id: string) => (title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX) || id.slice(0, 8);


export function createWorkAgents({ client, asks, linked, onAgent, serverId, usage, cards, uploads, exec = defaultExec, beforeTurn, closeAsk, archiveAgent, handedOff = () => [], models, subagents, snapshots, keyOf = (_slug, key) => key }: Options) {
  const selfArchiving = (a: Parameters<typeof autoArchivable>[0] | null | undefined) => {
    if (!a) return false;
    const handed = new Set(handedOff());
    return autoArchivable(a, { openCards: cards?.openCount(a.id) ?? 0, handedOff: (id) => handed.has(id) });
  };
  const labelKey = (labels: Record<string, string> | null | undefined) => (labels?.pr ? keyOf(labels.work || '', labels.pr.replaceAll('~', ':')) : null);
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

  // the GET's read: the last list at once, Paseo asked again in the background; a live watcher's refresh keeps it current
  const cached = swrCache<WorkAgent[]>(LIST_TTL_MS);
  onAgent((a) => a?.labels?.work && cached.expire(a.labels.work));

  async function listAgents(slug: string): Promise<Omit<WorkAgent, 'subagents'>[]> {
    const c = await client();
    if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
    const page = await c.agents.list({ includeBackground: true, filter: { labels: { work: slug }, includeArchived: true, includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: PAGE } });
    const labelled = page.entries.map((e) => e.agent).filter((a) => !a.labels?.ask);
    const seen = new Set(labelled.map((a) => a.id));
    const links = await Promise.all(linked(slug).filter((l) => !seen.has(l.agentId)).map(async (l) => ({ l, a: (await c.agents.ref(l.agentId).refresh().catch(() => null))?.agent ?? null })));
    return [
      ...asks(slug).map((m) => ({ id: `ask-${m.id}`, agentId: m.agentId, askId: m.id, kind: 'ask', title: (m.title || m.prompt.split('\n')[0]).slice(0, TITLE_MAX), pr: m.pr == null ? null : String(m.pr), status: ASK_STATUS[m.status] || 'archived', updatedAt: m.lastActivity || m.startedAt, autoArchive: false, ...metrics(m.agentId) })),
      ...labelled.map((a) => ({ id: `ag-${a.id}`, agentId: a.id, askId: null, kind: a.labels?.kind || 'agent', title: titleOf(a.title, a.id), pr: labelKey(a.labels), status: statusOf(a), updatedAt: a.updatedAt || null, autoArchive: selfArchiving(a), ...metrics(a.id, a.lastUsage) })),
      ...links.map(({ l, a }) => ({ id: `ag-${l.agentId}`, agentId: l.agentId, askId: null, kind: 'linked', title: titleOf(a?.title ?? l.title, l.agentId), pr: String(l.key), status: a ? statusOf(a) : 'archived', updatedAt: a?.updatedAt || null, autoArchive: selfArchiving(a && { ...a, id: l.agentId }), ...metrics(l.agentId, a?.lastUsage) })),
    ];
  }

  // the list on connect, then again shortly after Paseo reports a change on one of them, and every REFRESH_MS
  function watchList(sink: Sink, slug: string) {
    let last = '';
    let ids = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async (fresh = true) => {
      const body = await Promise.all([cached(slug, () => list(slug), fresh), serverOf()]).then(
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
    // a list seen before shows at once, the fresh one follows
    if (cached.has(slug)) void refresh(false).then(() => refresh());
    else void refresh();
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

  // timeline entries as chat events, the owner's messages as user events with their files
  function replay(agentId: string, entries: TimelineEntries, filesOf?: (item: UserItem) => UploadRef[] | undefined) {
    const events: ActivityEvent[] = [];
    const keep = (ev: ActivityEvent) => events.push(ev);
    const past = createFollower({ onEntry: activityEvents({ keep, live: keep }).onEntry, agentId });
    for (const { item } of entries) {
      if (item?.type === 'user_message') {
        past.end();
        keep({ type: 'user', text: item.text, ...withFiles(filesOf?.(item)) });
      } else if (item) past.push({ agentId, event: { type: 'timeline', item } });
    }
    past.end();
    return events;
  }

  // the chat so far: the snapshot and the entries after it, or the whole timeline when there is none or its epoch is gone;
  // kept as the new snapshot once the agent is idle, snapshots ending on a finished turn so the next entries replay on their own
  async function history(agentId: string, agent: DaemonAgent, found: { status?: string | null; archivedAt?: unknown; updatedAt?: string | null }, kept: ChatSnapshot | null) {
    const since = kept && (await timelineAfter(agent, kept.cursor));
    const { events, cursor } = kept && since
      ? { events: [...kept.events, ...replay(agentId, since.entries, (item) => uploads?.latest(agentId, item))], cursor: since.cursor }
      : await timelineWithCursor(agent).then(({ entries, cursor }) => ({ events: replay(agentId, entries, uploads?.pairer(agentId)), cursor }));
    if (cursor && statusOf(found) !== 'running') snapshots?.put(agentId, { updatedAt: found.updatedAt ?? null, cursor, events });
    return events;
  }

  // a coco agent ending a turn gets its snapshot while Paseo still holds its timeline
  const running = new Set<string>();
  onAgent((a) => {
    if (!a || !snapshots) return;
    if (statusOf(a) === 'running') return void running.add(a.id);
    if (!running.delete(a.id) || !(a.labels?.work || snapshots.get(a.id))) return;
    void (async () => {
      const agent = (await client()).agents.ref(a.id);
      const found = (await agent.refresh())?.agent;
      const kept = snapshots.get(a.id);
      if (found && kept?.updatedAt !== (found.updatedAt ?? null)) await history(a.id, agent, found, kept);
    })().catch(() => {});
  });

  // what the agent did so far as one history event (its snapshot first when Paseo has newer), then each new step while the tab watches
  async function watchChat(sink: Sink, agentId: string) {
    const write = (ev: ActivityEvent) => sink.send(JSON.stringify(ev));
    const writeHistory = (events: ActivityEvent[]) => sink.send(JSON.stringify(events), 'history');
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
      const found = (await agent.refresh())?.agent;
      if (!found) {
        snapshots?.drop(agentId);
        return write({ type: 'meta', text: 'Paseo no longer knows this agent' });
      }
      const kept = snapshots?.get(agentId) ?? null;
      if (kept) writeHistory(kept.events);
      if (kept?.updatedAt !== (found.updatedAt ?? null)) {
        const events = await history(agentId, agent, found, kept);
        if (!sink.closed) writeHistory(events);
      }
      if (sink.closed) return;
      const stream = activityEvents({ keep: write, live: write });
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

  // an archived or deleted work's agents lose their snapshots
  async function forget(slug: string) {
    if (!snapshots) return;
    for (const a of await listAgents(slug)) if (a.agentId) snapshots.drop(a.agentId);
  }

  // the work and stack row an agent's labels name
  async function placeOf(agentId: string) {
    const labels = (await (await client()).agents.ref(agentId).refresh())?.agent?.labels;
    return { work: labels?.work || null, pr: labelKey(labels) };
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
      pr: labelKey(l),
      status: statusOf(found),
      updatedAt: found.updatedAt || null,
      autoArchive: selfArchiving({ ...found, id: agentId }),
      provider: found.provider && found.model ? `${found.provider}/${found.model}` : found.provider || null,
      thinking: found.thinkingOptionId ?? null,
      mode: found.currentModeId ?? null,
      workspaceId: found.workspaceId ?? null,
      serverId: await serverOf(),
      ...metrics(agentId, found.lastUsage),
    };
  }

  // every listed work's agents in one answer, as GET /api/works/<slug>/agents gives each: the sidebar's one read for all of them
  async function summary(slugs: string[]) {
    const serverId = await serverOf();
    const entries = await Promise.all(slugs.map(async (slug) => [slug, await list(slug).then((agents) => ({ agents, serverId }), (e) => ({ agents: [], serverId, error: errorMessage(e) }))] as const));
    return { serverId, works: Object.fromEntries(entries) };
  }

  // an archived agent back as it was, as the Paseo app's Unarchive does it
  async function unarchive(agentId: string) {
    const c = await client();
    if (!c.refreshAgent) throw new HttpError(501, 'this Paseo client cannot unarchive an agent');
    const found = (await c.agents.ref(agentId).refresh())?.agent;
    if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
    if (!found.archivedAt) return { ok: true, unarchived: false };
    await c.refreshAgent(agentId);
    return { ok: true, unarchived: true };
  }

  // GET /api/works/<slug>/agents[/events] · GET /api/agent-chat/<agentId>[/events|place] · POST /api/agent-chat/<agentId>/messages|stop|archive|unarchive
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b, c] = parts;
    try {
      if (root === 'agent-chat' && a && b === 'archive' && req.method === 'POST') {
        if (!archiveAgent) throw new HttpError(501, 'archiving is not wired');
        return send(res, 200, { ok: true, archived: await archiveAgent(a) });
      }
      if (root === 'agent-chat' && a && b === 'unarchive' && req.method === 'POST') return send(res, 200, await unarchive(a));
      if (root === 'works' && b === 'agents' && c === 'events') return watchList(sseSink(req, res), a);
      if (root === 'works' && b === 'agents' && !c) return send(res, 200, { agents: await cached(a, () => list(a)), serverId: await serverOf() });
      if (root === 'works' && b === 'agents' && c === 'archive' && req.method === 'POST') {
        const { ids } = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'ids required');
        const done = await archive(a, ids.map(String));
        cached.drop(a);
        return send(res, 200, done);
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

  return { list, summary, handle, watchList, watchChat, say, placeOf, info, forget };
}
