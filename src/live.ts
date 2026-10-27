// Every live update of the page over one SSE stream (browsers allow 6 HTTP/1.1 connections per host): GET /api/events carries the
// subscribed topics, POST /api/events/<id>/subs changes them; a topic followed twice is replayed to both, `open` starting each replay.
// by event: open, message (the topic's plain events), error ({ error, status }: the topic cannot be followed), or the topic's own (cards)
export type Handlers = Record<string, ((data: never) => void) | undefined>;

const MAX_BACKOFF_MS = 30000;
const IDLE_MS = 5000;
// the server pings every 25s: a stream silent this long is dead behind a proxy that kept it open
const STALE_MS = 60000;

const subs = new Map<string, Set<Handlers>>();
const replay = new Set<string>();
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

export const topic = (name: string, ...args: (string | number)[]) => [name, ...args.map((a) => encodeURIComponent(String(a)))].join(':');

function drop() {
  source?.close();
  source = null;
  conn = null;
  clearInterval(watchdog);
}

function retry() {
  drop();
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (subs.size) connect();
  }, Math.min(500 * 2 ** retries++, MAX_BACKOFF_MS));
}

function connect() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  drop();
  held = new Set(subs.keys());
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
    schedule();
  });
  es.addEventListener('ping', () => (heard = Date.now()));
  es.onmessage = (m: MessageEvent<string>) => {
    heard = Date.now();
    const { topic: t, event, data } = JSON.parse(m.data) as { topic: string; event: string; data: unknown };
    subs.get(t)?.forEach((on) => (on[event] as ((d: unknown) => void) | undefined)?.(data));
  };
  es.onerror = () => source === es && retry();
}

function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    void sync();
  });
}

async function sync() {
  clearTimeout(idleTimer);
  if (!subs.size) {
    idleTimer = setTimeout(() => subs.size || drop(), IDLE_MS);
    return;
  }
  if (!source) {
    if (!retryTimer) connect();
    return;
  }
  if (!conn || syncing) return;
  const add = [...subs.keys()].filter((t) => !held.has(t) || replay.has(t));
  const remove = [...held].filter((t) => !subs.has(t));
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

// ref-counted per topic; the returned function unsubscribes
export function subscribe(t: string, on: Handlers) {
  const set = subs.get(t) ?? new Set<Handlers>();
  if (set.size || held.has(t)) replay.add(t);
  subs.set(t, set);
  set.add(on);
  schedule();
  return () => {
    set.delete(on);
    if (!set.size && subs.get(t) === set) subs.delete(t);
    schedule();
  };
}
