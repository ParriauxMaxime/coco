// "Waiting on you": one read model of everything that stops until the owner answers: open cards, Ask chats and cc-group threads whose agent
// ended its turn with the last word, suggestions with an open Approve. Nothing acts by itself: each item lists the existing endpoints its buttons call.
// GET /api/waiting · GET /api/works/<slug>/waiting · POST /api/waiting/ack { ids } hides agent questions until the agent speaks again · SSE topic `waiting`
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import { swrCache } from './swr.ts';
import type { Sink } from './events.ts';
import type { Card } from './cards.ts';

const TTL_MS = 30000;
const SETTLE_MS = 500;
const EXCERPT = 300;

// kind: pick an option / approve / dismiss go through their endpoint as is; reply sends { [field]: text }; ack only hides the item here
export type WaitingAction = { id: string; kind: 'pick' | 'approve' | 'dismiss' | 'reply' | 'ack'; label: string; url: string; body?: Record<string, unknown>; field?: string };
export type WaitingItem = { id: string; kind: 'card' | 'approve' | 'thread' | 'ask'; work: string | null; pr: string | null; key?: string; title: string; excerpt: string; at: string; link: string; actions: WaitingAction[] };
export type WaitingView = { items: WaitingItem[]; count: number };

type Queued = { key: string; pr: string | null; title: string; link: string; busy: boolean; agentLast: boolean; code: boolean; at: string; text: string; asks: number; suggestion: { msg: string; kind: string; commit?: string; files?: string[] } | null };
type AskMeta = { id: string; prompt: string; workSlug: string | null; pr?: string | number | null; kind: string; status: string; turns: number; text: string; agentIds: string[]; lastActivity: string; once?: boolean };
type Ready = { commit: string; subject: string; stat: string } | null;
type Options = {
  DATA?: string;
  works: { list(): { slug: string; title: string; archived?: unknown }[] };
  cards: { open(): Card[] };
  threads: { queue(slug: string): Queued[]; ready(slug: string, key: string): Promise<Ready>; link?: (slug: string, key: string) => string };
  ask: { list(): AskMeta[] };
  // the Ask chat an agent belongs to, to open its cards there
  convOf?: (agentId: string) => { id: string; workSlug: string | null } | null;
  now?: () => number;
};

const cut = (s: string, n = EXCERPT) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const enc = encodeURIComponent;
const reply = (url: string, field = 'text'): WaitingAction => ({ id: 'reply', kind: 'reply', label: 'Send', url, field });
const ackOf = (id: string): WaitingAction => ({ id: 'ack', kind: 'ack', label: 'Dismiss', url: '/api/waiting/ack', body: { ids: [id] } });

function cardActions(c: Card): WaitingAction[] {
  const url = `/api/cards/${c.id}`;
  const picks: WaitingAction[] =
    c.kind === 'choice' && !c.multi ? (c.options || []).map((o) => ({ id: `pick:${o.key}`, kind: 'pick', label: o.label, url: `${url}/answer`, body: { picked: [o.key] } }))
    : c.kind === 'confirm' && !c.fields?.length ? [{ id: 'approve', kind: 'approve', label: c.confirmLabel || 'Approve', url: `${url}/answer`, body: { approved: true } }, { id: 'reject', kind: 'pick', label: c.rejectLabel || 'Reject', url: `${url}/answer`, body: { approved: false } }]
    : [];
  return [...picks, ...(c.other && c.kind !== 'form' ? [reply(`${url}/answer`, 'other')] : []), { id: 'dismiss', kind: 'dismiss', label: 'Dismiss', url: `${url}/cancel` }];
}

export function createWaiting({ DATA, works, cards, threads, ask, convOf, now = Date.now }: Options) {
  const file = DATA ? path.join(DATA, 'waiting-acks.json') : null;
  const acks: Record<string, string> = (() => {
    try {
      return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    } catch {
      return {};
    }
  })();
  const cache = swrCache<WaitingItem[]>(TTL_MS);
  const watchers = new Set<() => void>();
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const acked = (id: string, at: string) => (acks[id] ? acks[id] >= at : false);

  async function build(): Promise<WaitingItem[]> {
    const live = works.list().filter((w) => !w.archived);
    const slugs = new Set(live.map((w) => w.slug));
    const items: WaitingItem[] = [];
    const asked = new Set<string>();

    for (const c of cards.open()) {
      const conv = convOf?.(c.agentId) || null;
      const work = c.work ?? conv?.workSlug ?? null;
      if (work && !slugs.has(work)) continue;
      asked.add(c.agentId);
      const link = c.thread && c.work ? (threads.link?.(c.work, c.thread) ?? `#/work/${c.work}`) : conv ? (work ? `#/work/${work}/ask-${conv.id}` : `#/ask/${conv.id}`) : work ? `#/work/${work}/ag-${c.agentId}` : '#/agents';
      items.push({ id: `card:${c.id}`, kind: 'card', work, pr: c.pr, title: c.title, excerpt: cut(c.question || ''), at: c.createdAt, link, actions: cardActions(c) });
    }

    for (const m of ask.list()) {
      if (!['idle', 'parked'].includes(m.status) || !m.turns || m.once || !m.text || m.agentIds.some((a) => asked.has(a))) continue;
      if (m.workSlug && !slugs.has(m.workSlug)) continue;
      const id = `ask:${m.id}`;
      if (acked(id, m.lastActivity)) continue;
      items.push({ id, kind: 'ask', work: m.workSlug, pr: m.pr == null ? null : String(m.pr), title: cut(m.prompt.split('\n')[0], 120), excerpt: cut(m.text), at: m.lastActivity, link: m.workSlug ? `#/work/${m.workSlug}/ask-${m.id}` : `#/ask/${m.id}`, actions: [reply(`/api/ask/${m.id}/messages`), ackOf(id)] });
    }

    for (const w of live) {
      for (const q of threads.queue(w.slug)) {
        if (q.busy) continue;
        const base = `/api/works/${w.slug}/threads/${enc(q.key)}`;
        const s = q.suggestion;
        if (s) {
          const ready = s.kind === 'commit' && q.code ? await threads.ready(w.slug, q.key).catch(() => null) : null;
          const what = s.kind === 'commit' ? `commit ${(ready?.commit || s.commit || '').slice(0, 7)} ready${ready?.subject ? `: ${ready.subject}` : s.files?.length ? `: ${s.files.join(', ')}` : ''}${ready?.stat ? ` (${ready.stat})` : ''}` : 'card change ready';
          const sug = `${base}/suggestions/${s.msg}`;
          items.push({
            id: `approve:${w.slug}:${q.key}:${s.msg}`, kind: 'approve', work: w.slug, pr: q.pr, key: q.key, title: q.title, excerpt: cut(`${what}. ${q.text}`), at: q.at, link: q.link,
            actions: [{ id: 'approve', kind: 'approve', label: 'Approve', url: sug, body: { action: 'approve' } }, { id: 'dismiss', kind: 'dismiss', label: 'Dismiss', url: sug, body: { action: 'dismiss' } }, reply(base)],
          });
          continue;
        }
        const id = `thread:${w.slug}:${q.key}`;
        if (!q.agentLast || q.asks || !q.text || acked(id, q.at)) continue;
        items.push({ id, kind: 'thread', work: w.slug, pr: q.pr, key: q.key, title: q.title, excerpt: cut(q.text), at: q.at, link: q.link, actions: [reply(base), ackOf(id)] });
      }
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  const all = () => {
    const fresh = dirty;
    dirty = false;
    return cache('all', build, fresh);
  };
  const view = async (slug?: string): Promise<WaitingView> => {
    const items = (await all()).filter((i) => !slug || i.work === slug);
    return { items, count: items.length };
  };

  // something that may change the queue happened: the next read is fresh and watchers hear of it shortly
  function touch() {
    dirty = true;
    if (!watchers.size) return;
    timer ||= setTimeout(() => {
      timer = null;
      watchers.forEach((w) => w());
    }, SETTLE_MS);
    timer.unref();
  }

  // the queue now, then again whenever it changed
  function watch(sink: Sink) {
    let last = '';
    const send = () => view().then((v) => {
      const body = JSON.stringify(v);
      if (body !== last) sink.send((last = body));
    }, () => {});
    watchers.add(send);
    sink.onClose(() => watchers.delete(send));
    return send();
  }

  function ack(ids: unknown) {
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) throw new HttpError(400, 'ids must list item ids');
    const at = new Date(now()).toISOString();
    for (const id of ids as string[]) acks[id] = at;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(acks));
    }
    touch();
    return { ok: true };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b] = parts;
    try {
      if (root === 'waiting' && !a && req.method === 'GET') return send(res, 200, await view());
      if (root === 'waiting' && a === 'ack' && req.method === 'POST') {
        let body: { ids?: unknown };
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        return send(res, 200, ack(body.ids));
      }
      if (root === 'works' && b === 'waiting' && a && req.method === 'GET') return send(res, 200, await view(a));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { view, touch, watch, ack, handle };
}
