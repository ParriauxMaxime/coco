// The subagents a Paseo agent starts itself (Claude's Agent/Task tool), as Paseo exposes them: listed per parent, counted for the work's agents,
// and a subagent's timeline replayed as coco activity events then followed live. Paseo pushes every change on one event feed; without it, polled.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import { activityEvents, createFollower } from './paseo-agent.ts';
import type { ActivityEvent, TimelineEvent } from './paseo-agent.ts';
import type { Req, Res, Send } from './core-types.ts';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'canceled';
// provider: as Paseo's descriptor names it; Paseo reports no model for a subagent
export type Subagent = { id: string; parentAgentId: string; provider: string | null; title: string | null; description: string | null; status: SubagentStatus; createdAt: string; updatedAt: string; toolCallId: string | null; subtitle: string | null };
export type SubagentCount = { running: number; total: number };
type Raw = Partial<Omit<Subagent, 'status'>> & { id: string; parentAgentId: string; status?: string; parentSubagentId?: string | null; cwd?: string | null };
type Cursor = { epoch: string; seq: number };
type Item = NonNullable<TimelineEvent['item']>;
type Row = { item: Item; timestamp?: string; seq: number; seqEnd?: number };
type Page = { epoch: string; rows: Row[]; startCursor?: Cursor | null; endCursor?: Cursor | null; hasOlder: boolean };
export type SubagentUpdate =
  | { kind: 'upsert'; subagent: Raw }
  | { kind: 'timeline'; parentAgentId: string; subagentId: string; item: Item; seq: number; epoch: string }
  | { kind: 'remove'; parentAgentId: string; subagentId: string };
type Observation = { subscribe(o: { snapshot: () => void; update: (m: { type: string; payload?: unknown }) => void; error?: (e: unknown) => void }): unknown; ready?: Promise<unknown>; release(): Promise<unknown> };
// the daemon client calls this needs; a daemon without them lists no subagent
export type SubagentApi = {
  listProviderSubagents?(parentAgentId: string): Promise<{ subagents: Raw[] }>;
  fetchProviderSubagentTimeline?(parentAgentId: string, subagentId: string, opts?: { direction?: 'tail' | 'before' | 'after'; cursor?: Cursor; limit?: number }): Promise<Page>;
  observeEvents?(events: string[]): Observation;
};

const EVENT = 'agent.provider_subagents.update';
const STATUSES: SubagentStatus[] = ['running', 'completed', 'failed', 'canceled'];
const PAGE = 200;
const MAX_PAGES = 20;
const FRESH_MS = 5000;
const LIVE_FRESH_MS = 30000;
const THROTTLE_MS = 1000;
const IDLE_MS = 30000;

const normalize = (s: Raw): Subagent => ({
  id: s.id,
  parentAgentId: s.parentAgentId,
  provider: s.provider ?? null,
  title: s.title ?? null,
  description: s.description ?? null,
  status: STATUSES.find((x) => x === s.status) ?? 'running',
  createdAt: s.createdAt ?? '',
  updatedAt: s.updatedAt ?? s.createdAt ?? '',
  toolCallId: s.toolCallId ?? null,
  subtitle: s.subtitle ?? null,
});
const parentOf = (u: SubagentUpdate) => (u.kind === 'upsert' ? u.subagent.parentAgentId : u.parentAgentId);
const lastSeq = (r: Row) => r.seqEnd ?? r.seq;

export function createSubagents({ client, pollMs = 5000, idleMs = IDLE_MS }: { client: () => Promise<SubagentApi>; pollMs?: number; idleMs?: number }) {
  const cache = new Map<string, { at: number; by: Map<string, Subagent> }>();
  const listeners = new Set<(u: SubagentUpdate) => void>();
  let feed: Observation | null = null;
  let starting: Promise<boolean> | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (u: SubagentUpdate) => {
    const hit = cache.get(parentOf(u));
    if (hit && u.kind === 'upsert') hit.by.set(u.subagent.id, normalize(u.subagent));
    if (hit && u.kind === 'remove') hit.by.delete(u.subagentId);
    for (const l of listeners) l(u);
  };

  // one observation of Paseo's subagent feed while anyone listens, kept a while after the last one leaves
  const startFeed = () =>
    (starting ||= (async () => {
      try {
        const c = await client();
        if (!c.observeEvents) return false;
        const obs = c.observeEvents([EVENT]);
        obs.subscribe({ snapshot: () => {}, update: (m) => m.type === EVENT && m.payload && dispatch(m.payload as SubagentUpdate), error: () => stopFeed() });
        await obs.ready;
        feed = obs;
        return true;
      } catch {
        starting = null;
        return false;
      }
    })());
  function stopFeed() {
    void feed?.release().catch(() => {});
    feed = null;
    starting = null;
  }
  function listen(fn: (u: SubagentUpdate) => void) {
    if (idle) clearTimeout(idle);
    idle = null;
    listeners.add(fn);
    const live = startFeed();
    const off = () => {
      listeners.delete(fn);
      if (!listeners.size && !idle) idle = setTimeout(() => ((idle = null), listeners.size || stopFeed()), idleMs);
    };
    return { live, off };
  }

  async function list(parentAgentId: string): Promise<Subagent[]> {
    const hit = cache.get(parentAgentId);
    if (!hit || Date.now() - hit.at > (feed ? LIVE_FRESH_MS : FRESH_MS)) {
      const c = await client();
      const found = c.listProviderSubagents ? (await c.listProviderSubagents(parentAgentId)).subagents : [];
      cache.set(parentAgentId, { at: Date.now(), by: new Map(found.map((s) => [s.id, normalize(s)])) });
    }
    return [...(cache.get(parentAgentId)?.by.values() ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // only agents with subagents are keyed; one Paseo cannot answer for counts as none
  async function counts(parentAgentIds: string[]) {
    const out: Record<string, SubagentCount> = {};
    await Promise.all(
      [...new Set(parentAgentIds)].map(async (id) => {
        const subs = await list(id).catch(() => []);
        if (subs.length) out[id] = { running: subs.filter((s) => s.status === 'running').length, total: subs.length };
      }),
    );
    return out;
  }

  // a parent gains or loses a subagent, or one changes status
  function onChange(fn: (parentAgentId: string) => void) {
    const status = new Map<string, string>();
    const { off } = listen((u) => {
      if (u.kind === 'timeline') return;
      const key = `${parentOf(u)}\n${u.kind === 'upsert' ? u.subagent.id : u.subagentId}`;
      const now = u.kind === 'upsert' ? String(u.subagent.status) : '';
      if (status.get(key) === now) return;
      if (now) status.set(key, now);
      else status.delete(key);
      fn(parentOf(u));
    });
    return off;
  }

  // topic subagents:<agentId>: { subagents } on subscribe and on each change
  function watchList(sink: Sink, parentAgentId: string) {
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = async () => {
      const body = await list(parentAgentId).then(
        (subagents) => JSON.stringify({ subagents }),
        (e) => JSON.stringify({ subagents: [], error: errorMessage(e) }),
      );
      if (body !== last && !sink.closed) sink.send((last = body));
    };
    const soon = () => {
      timer ||= setTimeout(() => {
        timer = null;
        void push();
      }, THROTTLE_MS);
    };
    const { live, off } = listen((u) => u.kind !== 'timeline' && parentOf(u) === parentAgentId && soon());
    let poll: ReturnType<typeof setInterval> | null = null;
    sink.onClose(() => {
      off();
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    });
    void push();
    void live.then((ok) => {
      if (!ok && !sink.closed) poll = setInterval(() => void push(), pollMs);
    });
  }

  async function history(parentAgentId: string, subagentId: string) {
    const c = await client();
    const get = c.fetchProviderSubagentTimeline?.bind(c);
    if (!get) throw new HttpError(501, 'this Paseo daemon cannot show subagents');
    const fetch = (opts: { direction: 'tail' | 'before'; cursor?: Cursor }) => get(parentAgentId, subagentId, { ...opts, limit: PAGE });
    const newest = await fetch({ direction: 'tail' });
    const pages: Page[] = [newest];
    for (let page = newest; page.hasOlder && page.startCursor && pages.length < MAX_PAGES; ) {
      page = await fetch({ direction: 'before', cursor: page.startCursor });
      pages.unshift(page);
    }
    return { rows: pages.flatMap((p) => p.rows), epoch: newest.epoch };
  }

  // topic subagent:<agentId>:<subagentId>: what it did so far, then each new step; it ends with an `end` event once it stopped
  async function watchTimeline(sink: Sink, parentAgentId: string, subagentId: string) {
    const write = (ev: ActivityEvent) => sink.send(JSON.stringify(ev));
    const stream = activityEvents({ keep: write, live: write });
    const follow = createFollower({ onEntry: stream.onEntry, onDelta: stream.onDelta, onToolStart: stream.onToolStart });
    let seen = -1;
    let epoch = '';
    let ready = false;
    let status: string | null = null;
    const held: SubagentUpdate[] = [];
    const take = (u: SubagentUpdate) => {
      if (u.kind === 'upsert') {
        const was = status;
        status = u.subagent.status ?? status;
        if (was === 'running' && status !== 'running') {
          follow.end();
          stream.flush();
          write({ type: 'end', status: status ?? 'completed' });
        }
        return;
      }
      if (u.kind !== 'timeline') return;
      if (u.epoch === epoch && u.seq <= seen) return;
      epoch = u.epoch;
      seen = u.seq;
      if (u.item.type === 'user_message') {
        follow.end();
        stream.flush();
        write({ type: 'user', text: u.item.text });
      } else follow.push({ event: { type: 'timeline', item: u.item } });
    };
    const mine = (u: SubagentUpdate) => parentOf(u) === parentAgentId && (u.kind === 'upsert' ? u.subagent.id : u.subagentId) === subagentId;
    const { live, off } = listen((u) => mine(u) && (ready ? take(u) : held.push(u)));
    let poll: ReturnType<typeof setInterval> | null = null;
    sink.onClose(() => {
      off();
      if (poll) clearInterval(poll);
    });
    try {
      const [{ rows, epoch: at }, subs] = await Promise.all([history(parentAgentId, subagentId), list(parentAgentId).catch(() => [])]);
      if (sink.closed) return;
      const past = createFollower({ onEntry: stream.onEntry, onToolStart: stream.onToolStart });
      for (const { item } of rows) {
        if (item.type === 'user_message') {
          past.end();
          write({ type: 'user', text: item.text });
        } else past.push({ event: { type: 'timeline', item } });
      }
      past.end();
      epoch = at;
      seen = rows.reduce((m, r) => Math.max(m, lastSeq(r)), -1);
      status = subs.find((s) => s.id === subagentId)?.status ?? null;
      if (status && status !== 'running') write({ type: 'end', status });
      ready = true;
      held.splice(0).forEach(take);
      if (!(await live) && !sink.closed && status === 'running') {
        const c = await client();
        poll = setInterval(() => {
          void c.fetchProviderSubagentTimeline?.(parentAgentId, subagentId, { direction: 'after', cursor: { epoch, seq: seen }, limit: PAGE }).then(
            (p) => p.rows.forEach((r) => take({ kind: 'timeline', parentAgentId, subagentId, item: r.item, seq: lastSeq(r), epoch: p.epoch })),
            () => {},
          );
        }, pollMs);
      }
    } catch (e) {
      write({ type: 'stderr', text: errorMessage(e) });
    }
  }

  // GET /api/agent-chat/<agentId>/subagents · GET /api/agent-chat/<agentId>/subagents/<subagentId>/events (SSE)
  async function handle(req: Req, res: Res, parts: string[], send: Send) {
    const [, agentId, , subagentId, action] = parts;
    try {
      if (!subagentId && req.method === 'GET') return send(res, 200, { subagents: await list(agentId) });
      if (subagentId && action === 'events' && req.method === 'GET') return void (await watchTimeline(sseSink(req, res), agentId, subagentId));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  const close = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    stopFeed();
  };
  return { list, counts, onChange, watchList, watchTimeline, handle, close };
}
export type Subagents = ReturnType<typeof createSubagents>;
