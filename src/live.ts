// Every live update of every coco tab over one SSE stream (browsers allow 6 HTTP/1.1 connections per host): the tab holding the
// `cocopilot-live` lock opens it for the topics of all tabs and fans its events out on a BroadcastChannel; another tab takes over
// when it closes. GET /api/events carries the subscribed topics, POST /api/events/<id>/subs changes them; a topic followed twice is
// replayed to every follower, `open` starting each replay.
// by event: open, message (the topic's plain events), error ({ error, status }: the topic cannot be followed), or the topic's own (cards)
export type Handlers = Record<string, ((data: never) => void) | undefined>;

type Msg =
  | { type: 'event'; topic: string; event: string; data: unknown }
  | { type: 'subs'; tab: string; topics: string[]; replay: string[] }
  | { type: 'bye'; tab: string }
  | { type: 'leader' }
  | { type: 'conn'; up: boolean };

const MAX_BACKOFF_MS = 30000;
const IDLE_MS = 5000;
// the server pings every 25s: a stream silent this long is dead behind a proxy that kept it open
const STALE_MS = 60000;
// background tabs run timers once a minute at most
const ANNOUNCE_MS = 20000;
const TAB_GONE_MS = 150000;

const local = new Map<string, Set<Handlers>>();
const tabs = new Map<string, { topics: string[]; seen: number }>();
const replay = new Set<string>();
const self = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel !== 'undefined' && typeof navigator !== 'undefined' && navigator.locks ? new BroadcastChannel('cocopilot-live') : null;
let leader = false;
let held = new Set<string>();
let source: EventSource | null = null;
let conn: string | null = null;
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setInterval> | undefined;
let heard = 0;
let queued = false;
let syncing = false;
let up = true;
const watchers = new Set<(up: boolean) => void>();

function setUp(v: boolean, share = true) {
  if (v === up) return;
  up = v;
  watchers.forEach((w) => w(v));
  if (share) channel?.postMessage({ type: 'conn', up: v } satisfies Msg);
}
// whether the stream reaches the server: false from a drop (a restart, a rebuild, the server down) until it says hello again
export const connected = () => up;
export function onConnection(fn: (up: boolean) => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

export const topic = (name: string, ...args: (string | number)[]) => [name, ...args.map((a) => encodeURIComponent(String(a)))].join(':');

const wanted = () => new Set([...local.keys(), ...[...tabs.values()].flatMap((t) => t.topics)]);

function dispatch(t: string, event: string, data: unknown) {
  local.get(t)?.forEach((on) => (on[event] as ((d: unknown) => void) | undefined)?.(data));
}

function drop() {
  source?.close();
  source = null;
  conn = null;
  clearInterval(watchdog);
}

function retry() {
  drop();
  setUp(false);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (wanted().size) connect();
  }, Math.min(500 * 2 ** retries++, MAX_BACKOFF_MS));
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  drop();
  held = wanted();
  replay.clear();
  const query = [...held].map((t) => `sub=${encodeURIComponent(t)}`).join('&');
  const es = new EventSource(`/api/events${query ? `?${query}` : ''}`);
  source = es;
  heard = Date.now();
  watchdog = setInterval(() => Date.now() - heard > STALE_MS && retry(), STALE_MS / 4);
  es.addEventListener('hello', (m) => {
    heard = Date.now();
    conn = (JSON.parse((m as MessageEvent<string>).data) as { id: string }).id;
    retries = 0;
    setUp(true);
    schedule();
  });
  es.addEventListener('ping', () => (heard = Date.now()));
  es.onmessage = (m: MessageEvent<string>) => {
    heard = Date.now();
    const { topic: t, event, data } = JSON.parse(m.data) as { topic: string; event: string; data: unknown };
    dispatch(t, event, data);
    channel?.postMessage({ type: 'event', topic: t, event, data } satisfies Msg);
  };
  es.onerror = () => source === es && retry();
}

function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    if (leader) void sync();
    else announce();
  });
}

function announce() {
  const r = [...replay];
  replay.clear();
  channel?.postMessage({ type: 'subs', tab: self, topics: [...local.keys()], replay: r } satisfies Msg);
}

async function sync() {
  clearTimeout(idleTimer);
  const want = wanted();
  if (!want.size) {
    idleTimer = setTimeout(() => wanted().size || drop(), IDLE_MS);
    return;
  }
  if (!source) {
    if (!retryTimer) connect();
    return;
  }
  if (!conn || syncing) return;
  const add = [...want].filter((t) => !held.has(t) || replay.has(t));
  const remove = [...held].filter((t) => !want.has(t));
  replay.clear();
  if (!add.length && !remove.length) return;
  add.forEach((t) => held.add(t));
  remove.forEach((t) => held.delete(t));
  const id = conn;
  syncing = true;
  try {
    const r = await fetch(`/api/events/${id}/subs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add, remove }) });
    if (!r.ok && conn === id) retry();
  } catch {
    if (conn === id) retry();
  } finally {
    syncing = false;
    schedule();
  }
}

function lead() {
  leader = true;
  channel?.postMessage({ type: 'leader' } satisfies Msg);
  schedule();
}

if (channel) {
  channel.onmessage = ({ data: m }: MessageEvent<Msg>) => {
    if (m.type === 'event') return dispatch(m.topic, m.event, m.data);
    if (m.type === 'leader') return announce();
    if (m.type === 'conn') return setUp(m.up, false);
    if (!leader) return;
    if (m.type === 'bye') tabs.delete(m.tab);
    else {
      tabs.set(m.tab, { topics: m.topics, seen: Date.now() });
      m.replay.forEach((t) => replay.add(t));
    }
    schedule();
  };
  setInterval(() => {
    if (!leader) return announce();
    const before = tabs.size;
    tabs.forEach((t, id) => Date.now() - t.seen > TAB_GONE_MS && tabs.delete(id));
    if (tabs.size !== before) schedule();
  }, ANNOUNCE_MS);
  addEventListener('pagehide', () => leader || channel.postMessage({ type: 'bye', tab: self } satisfies Msg));
  addEventListener('pageshow', (e) => e.persisted && schedule());
  void navigator.locks.request('cocopilot-live', () => {
    lead();
    return new Promise<never>(() => {});
  });
} else lead();

// ref-counted per topic; the returned function unsubscribes
export function subscribe(t: string, on: Handlers) {
  const set = local.get(t) ?? new Set<Handlers>();
  replay.add(t);
  local.set(t, set);
  set.add(on);
  schedule();
  return () => {
    set.delete(on);
    if (!set.size && local.get(t) === set) local.delete(t);
    schedule();
  };
}
