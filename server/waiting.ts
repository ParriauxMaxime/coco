// "Waiting on you": the one read model of everything that stops until the owner answers, which every counter reads (sidebar, status bar, dock,
// Agents page, work tree): open cards, Paseo permissions of coco's agents, suggestions with an open Approve, Ask chats and cc-group threads whose
// agent ended its turn with the last word. Each item names its agent and work, and one thing counts once. Nothing acts by itself: each item lists
// the existing endpoints its buttons call.
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
const MAX_IDS = 100;
const MAX_ID = 200;
const ACK_TTL_MS = 30 * 24 * 3600 * 1000;
// an agent's last word left unanswered this long is read and let go: questions and permissions stay until answered
const LAST_WORD_MS = 2 * 24 * 3600 * 1000;

// kind: pick an option / approve / dismiss go through their endpoint as is; reply sends { [field]: text }; ack only hides the item here
export type WaitingAction = { id: string; kind: 'pick' | 'approve' | 'dismiss' | 'reply' | 'ack' | 'open'; label: string; url: string; body?: Record<string, unknown>; field?: string };
// diagrams: how many Mermaid diagrams a card carries, named on its row and shown on the card itself
export type WaitingItem = { id: string; kind: 'card' | 'permission' | 'approve' | 'thread' | 'ask'; agentId: string | null; work: string | null; pr: string | null; key?: string; title: string; excerpt: string; at: string; link: string; actions: WaitingAction[]; diagrams?: number };
// byAgent, byWork: how many items each Paseo agent id and each work slug holds
export type WaitingView = { items: WaitingItem[]; count: number; byAgent: Record<string, number>; byWork: Record<string, number> };

type Queued = { key: string; pr: string | null; agentId?: string | null; title: string; link: string; busy: boolean; agentLast: boolean; code: boolean; at: string; text: string; asks: number; suggestion: { msg: string; kind: string; commit?: string; files?: string[] } | null };
type AskMeta = { id: string; prompt: string; workSlug: string | null; pr?: string | number | null; kind: string; status: string; turns: number; text: string; agentIds: string[]; lastActivity: string; once?: boolean };
type Ready = { commit: string; subject: string; stat: string } | null;
type Permission = { agentId: string; agentTitle: string | null; request: { id: string; kind: string; name: string; title?: string; description?: string }; since: string; where: { label: string; href: string } | null; work?: string | null; pr?: string | null };
type Options = {
  DATA?: string;
  works: { list(): { slug: string; title: string; archived?: unknown }[] };
  cards: { open(): Card[] };
  threads: { queue(slug: string): Queued[]; ready(slug: string, key: string): Promise<Ready>; link?: (slug: string, key: string) => string };
  ask: { list(): AskMeta[] };
  permissions?: { list(): Permission[] };
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

const openOf = (link: string): WaitingAction => ({ id: 'open', kind: 'open', label: 'Open', url: link });
// a question an agent asks through Paseo while it has a card open is that card asked twice (its ask tool call held for approval, or AskUserQuestion)
const asksTwice = (p: Permission) => p.request.kind === 'question' || /cocopilot[\W_]*ask$/.test(p.request.name);
const PERMISSION_TITLE: Record<string, string> = { question: 'The agent asks', plan: 'Plan to approve', mode: 'Mode change' };
const tally = (keys: (string | null)[]) => {
  const out: Record<string, number> = {};
  for (const k of keys) if (k) out[k] = (out[k] || 0) + 1;
  return out;
};
// a card whose approval acts outside (an action proposal, a thread card, an option with an effect: GitHub, an agent, the stack) is answered on its own page, never inline
const hasEffect = (c: Card) => Boolean(c.action || c.thread || c.options?.some((o) => o.effect));

function cardActions(c: Card, link: string): WaitingAction[] {
  const url = `/api/cards/${c.id}`;
  if (hasEffect(c)) return [openOf(link), { id: 'dismiss', kind: 'dismiss', label: 'Dismiss', url: `${url}/cancel` }];
  const picks: WaitingAction[] =
    c.kind === 'choice' && !c.multi ? (c.options || []).map((o) => ({ id: `pick:${o.key}`, kind: 'pick', label: o.label, url: `${url}/answer`, body: { picked: [o.key] } }))
    : c.kind === 'confirm' && !c.fields?.length ? [{ id: 'approve', kind: 'approve', label: c.confirmLabel || 'Approve', url: `${url}/answer`, body: { approved: true } }, { id: 'reject', kind: 'pick', label: c.rejectLabel || 'Reject', url: `${url}/answer`, body: { approved: false } }]
    : [];
  return [...picks, ...(c.other && c.kind !== 'form' ? [reply(`${url}/answer`, 'other')] : []), { id: 'dismiss', kind: 'dismiss', label: 'Dismiss', url: `${url}/cancel` }];
}

export function createWaiting({ DATA, works, cards, threads, ask, permissions, convOf, now = Date.now }: Options) {
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

  const acked = (id: string, at: string) => (acks[id] ? acks[id] >= at : false) || now() - Date.parse(at) > LAST_WORD_MS;

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
      const link = c.thread && c.work ? (threads.link?.(c.work, c.thread) ?? `#/work/${c.work}`) : conv ? (work ? `#/work/${work}/ask-${conv.id}` : `#/ask/${conv.id}`) : work ? `#/work/${work}/ag-${c.agentId}` : `#/agents/${c.agentId}`;
      const diagrams = (c.diagram ? 1 : 0) + (c.options ?? []).filter((o) => o.diagram).length;
      items.push({ id: `card:${c.id}`, kind: 'card', agentId: c.agentId, work, pr: c.pr, title: c.title, excerpt: cut(c.question || ''), at: c.createdAt, link, actions: cardActions(c, link), ...(diagrams ? { diagrams } : {}) });
    }

    // an agent held on a permission is not also waiting for your word on its last turn
    const held = new Set<string>();
    for (const p of permissions?.list() || []) {
      if (asked.has(p.agentId) && asksTwice(p)) continue;
      const work = convOf?.(p.agentId)?.workSlug ?? p.work ?? null;
      if (work && !slugs.has(work)) continue;
      held.add(p.agentId);
      const r = p.request;
      const link = p.where?.href || `#/agents/${enc(p.agentId)}/waiting`;
      const title = r.kind === 'tool' ? `Allow ${r.name}` : r.title || PERMISSION_TITLE[r.kind] || r.name;
      items.push({ id: `perm:${p.agentId}:${r.id}`, kind: 'permission', agentId: p.agentId, work, pr: p.pr ?? null, title, excerpt: cut([p.agentTitle, r.kind === 'tool' ? r.title : '', r.description].filter(Boolean).join(' · ')), at: p.since, link, actions: [openOf(link)] });
    }

    for (const m of ask.list()) {
      if (!['idle', 'parked'].includes(m.status) || !m.turns || m.once || !m.text || m.agentIds.some((a) => asked.has(a) || held.has(a))) continue;
      if (m.workSlug && !slugs.has(m.workSlug)) continue;
      const id = `ask:${m.id}`;
      if (acked(id, m.lastActivity)) continue;
      items.push({ id, kind: 'ask', agentId: m.agentIds.at(-1) ?? null, work: m.workSlug, pr: m.pr == null ? null : String(m.pr), title: cut(m.prompt.split('\n')[0], 120), excerpt: cut(m.text), at: m.lastActivity, link: m.workSlug ? `#/work/${m.workSlug}/ask-${m.id}` : `#/ask/${m.id}`, actions: [reply(`/api/ask/${m.id}/messages`), ackOf(id)] });
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
            id: `approve:${w.slug}:${q.key}:${s.msg}`, kind: 'approve', agentId: q.agentId ?? null, work: w.slug, pr: q.pr, key: q.key, title: q.title, excerpt: cut(`${what}. ${q.text}`), at: q.at, link: q.link,
            actions: [openOf(q.link), { id: 'approve', kind: 'approve', label: 'Approve', url: sug, body: { action: 'approve' } }, { id: 'dismiss', kind: 'dismiss', label: 'Dismiss', url: sug, body: { action: 'dismiss' } }, reply(base)],
          });
          continue;
        }
        const id = `thread:${w.slug}:${q.key}`;
        if (!q.agentLast || q.asks || !q.text || acked(id, q.at) || (q.agentId && held.has(q.agentId))) continue;
        items.push({ id, kind: 'thread', agentId: q.agentId ?? null, work: w.slug, pr: q.pr, key: q.key, title: q.title, excerpt: cut(q.text), at: q.at, link: q.link, actions: [reply(base), ackOf(id)] });
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
    return { items, count: items.length, byAgent: tally(items.map((i) => i.agentId)), byWork: tally(items.map((i) => i.work)) };
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
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string' || i.length > MAX_ID)) throw new HttpError(400, `ids must list item ids of at most ${MAX_ID} chars`);
    if (ids.length > MAX_IDS) throw new HttpError(400, `at most ${MAX_IDS} ids per call`);
    const at = new Date(now()).toISOString();
    for (const id of ids as string[]) acks[id] = at;
    const old = new Date(now() - ACK_TTL_MS).toISOString();
    for (const id of Object.keys(acks)) if (acks[id] < old) delete acks[id];
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
