// A work's agents: the Paseo agents labelled with it, the agents linked to its rows and its Ask conversations, each with a status, live over SSE;
// and any of them as a chat: its Paseo timeline replayed then followed, follow-ups sent to it.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { TITLE_PREFIX, activityEvents, createFollower, timelineOf } from './paseo-agent.ts';
import type { ActivityEvent, DaemonClient } from './paseo-agent.ts';
import { fromPaseo } from './agent-usage.ts';
import type { AgentUsage, PaseoUsage } from './agent-usage.ts';
import type { AgentSnapshot } from './permissions.ts';
import type { ReadBody, Req, Res, RowKey, Send } from './core-types.ts';

const PAGE = 200;
const SETTLE_MS = 500;
const REFRESH_MS = 30000;
const TITLE_MAX = 80;
const TURN_END = ['turn_completed', 'turn_failed', 'turn_canceled'];

export type WorkAgentStatus = 'running' | 'done' | 'failed' | 'archived';
// id is the agent's tab: ask-<conversation> or ag-<Paseo agent>
export type WorkAgent = { id: string; agentId: string | null; askId: string | null; kind: string; title: string; pr: string | null; status: WorkAgentStatus; updatedAt: string | null } & Metrics;
// estimated tokens of the first prompt and the system prompt; inputTokens (cached reads included) and costUsd as Paseo reports them for the whole agent
type Metrics = { promptTokens: number | null; systemTokens: number | null; inputTokens: number | null; costUsd: number | null };

type AskMeta = { id: string; prompt: string; kind: string; pr?: RowKey | null; status: string; agentId: string | null; lastActivity?: string; startedAt: string };
type Linked = { agentId: string; key: RowKey; title: string | null };
type Options = {
  client: () => Promise<DaemonClient>;
  asks: (slug: string) => AskMeta[];
  linked: (slug: string) => Linked[];
  onAgent: (l: (agent: AgentSnapshot | null) => void) => () => void;
  serverId: () => Promise<string | null>;
  usage?: (agentId: string) => AgentUsage | null;
};

const statusOf = (a: { archivedAt?: unknown; status?: string | null }): WorkAgentStatus => (a.archivedAt || a.status === 'closed' ? 'archived' : a.status === 'error' ? 'failed' : a.status === 'idle' ? 'done' : 'running');
const ASK_STATUS: Record<string, WorkAgentStatus> = { running: 'running', idle: 'done', error: 'failed' };
const titleOf = (title: string | null | undefined, id: string) => (title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX) || id.slice(0, 8);

const openStream = (res: Res) => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });

export function createWorkAgents({ client, asks, linked, onAgent, serverId, usage }: Options) {
  let server: Promise<string | null> | null = null;
  const serverOf = () => (server ||= serverId().catch(() => ((server = null), null)));
  const metrics = (agentId: string | null, live?: PaseoUsage | null): Metrics => {
    const kept = agentId ? usage?.(agentId) : null;
    const now = fromPaseo(live);
    return { promptTokens: kept?.promptTokens ?? null, systemTokens: kept?.systemTokens ?? null, inputTokens: now.inputTokens ?? kept?.inputTokens ?? null, costUsd: now.costUsd ?? kept?.costUsd ?? null };
  };

  async function list(slug: string): Promise<WorkAgent[]> {
    const c = await client();
    if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
    const page = await c.agents.list({ includeBackground: true, filter: { labels: { work: slug }, includeArchived: true, includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: PAGE } });
    const labelled = page.entries.map((e) => e.agent).filter((a) => !a.labels?.ask);
    const seen = new Set(labelled.map((a) => a.id));
    const links = await Promise.all(linked(slug).filter((l) => !seen.has(l.agentId)).map(async (l) => ({ l, a: (await c.agents.ref(l.agentId).refresh().catch(() => null))?.agent ?? null })));
    return [
      ...asks(slug).map((m) => ({ id: `ask-${m.id}`, agentId: m.agentId, askId: m.id, kind: 'ask', title: m.prompt.split('\n')[0].slice(0, TITLE_MAX), pr: m.pr == null ? null : String(m.pr), status: ASK_STATUS[m.status] || 'archived', updatedAt: m.lastActivity || m.startedAt, ...metrics(m.agentId) })),
      ...labelled.map((a) => ({ id: `ag-${a.id}`, agentId: a.id, askId: null, kind: a.labels?.kind || 'agent', title: titleOf(a.title, a.id), pr: a.labels?.pr ? a.labels.pr.replaceAll('~', ':') : null, status: statusOf(a), updatedAt: a.updatedAt || null, ...metrics(a.id, a.lastUsage) })),
      ...links.map(({ l, a }) => ({ id: `ag-${l.agentId}`, agentId: l.agentId, askId: null, kind: 'linked', title: titleOf(a?.title ?? l.title, l.agentId), pr: String(l.key), status: a ? statusOf(a) : 'archived', updatedAt: a?.updatedAt || null, ...metrics(l.agentId) })),
    ];
  }

  // the list on connect, then again shortly after Paseo reports a change on one of them, and every REFRESH_MS
  function watchList(req: Req, res: Res, slug: string) {
    openStream(res);
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
      if (body !== last) res.write(`data: ${(last = body)}\n\n`);
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
    const tick = setInterval(soon, REFRESH_MS);
    req.on('close', () => {
      off();
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    });
  }

  // what the agent did so far, then each new step while the tab watches; the owner's messages come as user events
  async function watchChat(req: Req, res: Res, agentId: string) {
    openStream(res);
    const write = (ev: ActivityEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    let off: (() => void) | null = null;
    let closed = false;
    req.on('close', () => {
      closed = true;
      off?.();
    });
    try {
      const agent = (await client()).agents.ref(agentId);
      if (!(await agent.refresh())?.agent) return write({ type: 'meta', text: 'Paseo no longer knows this agent' });
      const stream = activityEvents({ keep: write, live: write });
      const past = createFollower({ onEntry: stream.onEntry, agentId });
      for (const { item } of await timelineOf(agent)) {
        if (item?.type === 'user_message') {
          past.end();
          write({ type: 'user', text: item.text });
        } else if (item) past.push({ agentId, event: { type: 'timeline', item } });
      }
      past.end();
      if (closed) return;
      const live = createFollower({ onEntry: stream.onEntry, onDelta: stream.onDelta, onToolStart: stream.onToolStart, agentId });
      off = agent.timeline.subscribe((m) => {
        const ev = m?.event;
        if (ev?.type === 'timeline' && ev.item?.type === 'user_message') {
          live.end();
          stream.flush();
          return write({ type: 'user', text: ev.item.text });
        }
        live.push(m);
        if (ev && TURN_END.includes(ev.type)) write({ type: 'end', status: ev.type.slice(5) });
      });
    } catch (e) {
      write({ type: 'stderr', text: errorMessage(e) });
    }
  }

  async function say(agentId: string, text: string) {
    const agent = (await client()).agents.ref(agentId);
    const found = (await agent.refresh())?.agent;
    if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
    if (statusOf(found) === 'archived') throw new HttpError(409, 'this agent is archived');
    await agent.send(text, { activeTurnBehavior: 'steer' });
    return { ok: true };
  }

  // GET /api/works/<slug>/agents[/events] · GET /api/agent-chat/<agentId>/events · POST /api/agent-chat/<agentId>/messages
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b, c] = parts;
    try {
      if (root === 'works' && b === 'agents' && c === 'events') return watchList(req, res, a);
      if (root === 'works' && b === 'agents' && !c) return send(res, 200, { agents: await list(a), serverId: await serverOf() });
      if (root === 'agent-chat' && a && b === 'events') return await watchChat(req, res, a);
      if (root === 'agent-chat' && a && b === 'messages' && req.method === 'POST') {
        const { text } = JSON.parse((await readBody(req)) || '{}');
        if (!String(text || '').trim()) throw new HttpError(400, 'text required');
        return send(res, 200, await say(a, String(text).trim()));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { list, handle };
}
