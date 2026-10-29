// A stale-while-revalidate cache of GET reads, keyed by URL: every reader of a key shares one entry, one request in flight and one
// poll; a key read again paints from what it last held while it reloads. A reader in a hidden tab (Visible false) or a hidden
// window neither polls nor reloads on a pushed event: the entry turns stale and reloads once a reader shows again.
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { subscribe } from './live.ts';

export type Snapshot<T> = { data: T | undefined; err: string; at: number; loading: boolean };
type Reader = { shown: boolean; poll: number };
type Entry = {
  snap: Snapshot<unknown>;
  fetcher: () => Promise<unknown>;
  flight: Promise<unknown> | null;
  seq: number;
  stale: boolean;
  readers: Set<Reader>;
  listeners: Set<() => void>;
  topics: string;
  off: (() => void) | null;
  timer: ReturnType<typeof setInterval> | null;
  every: number;
};

// a reader mounting within this of the last load reuses it
const FRESH_MS = 2000;
const EVENT_SETTLE_MS = 50;
const entries = new Map<string, Entry>();
const EMPTY: Snapshot<never> = { data: undefined, err: '', at: 0, loading: false };

const docShown = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const shownReaders = (e: Entry) => [...e.readers].filter((r) => r.shown);

function entryOf(key: string, fetcher: () => Promise<unknown>) {
  let e = entries.get(key);
  if (!e) {
    e = { snap: EMPTY, fetcher, flight: null, seq: 0, stale: false, readers: new Set(), listeners: new Set(), topics: '', off: null, timer: null, every: 0 };
    entries.set(key, e);
  }
  return e;
}

function set(e: Entry, patch: Partial<Snapshot<unknown>>) {
  e.snap = { ...e.snap, ...patch };
  e.listeners.forEach((l) => l());
}

// one request per key at a time; a forced fetcher (a fresh read) supersedes the one in flight, and only the newest lands
function load(e: Entry, fetcher?: () => Promise<unknown>) {
  if (e.flight && !fetcher) return e.flight;
  const n = ++e.seq;
  e.stale = false;
  if (!e.snap.loading) set(e, { loading: true });
  const p = (fetcher || e.fetcher)().then(
    (data) => { if (n === e.seq) set(e, { data, err: '', at: Date.now(), loading: false }); return data; },
    (err: unknown) => { if (n === e.seq) set(e, { err: err instanceof Error ? err.message : String(err), at: Date.now(), loading: false }); throw err; },
  ).finally(() => { if (n === e.seq) e.flight = null; });
  e.flight = p;
  p.catch(() => {});
  return p;
}

// the poll runs at the shortest period a shown reader asks for, and only while the window shows
function retime(e: Entry) {
  const periods = shownReaders(e).map((r) => r.poll).filter((p) => p > 0);
  const every = periods.length ? Math.min(...periods) : 0;
  if (every === e.every) return;
  if (e.timer) clearInterval(e.timer);
  e.every = every;
  e.timer = every ? setInterval(() => { if (docShown()) void load(e); else e.stale = true; }, every) : null;
}

// a reader shows: catch up on what it missed while hidden
function revive(e: Entry) {
  const shown = shownReaders(e);
  if (!shown.length || e.flight) return;
  const age = Date.now() - e.snap.at;
  if (e.stale || !e.snap.at || shown.some((r) => r.poll > 0 && age > r.poll)) void load(e);
}

function follow(e: Entry, topics: string[]) {
  const t = topics.join('|');
  if (t === e.topics && (e.off || !t)) return;
  e.off?.();
  e.topics = t;
  if (!topics.length) { e.off = null; return; }
  let soon: ReturnType<typeof setTimeout> | undefined;
  const on = () => {
    clearTimeout(soon);
    soon = setTimeout(() => { if (shownReaders(e).length && docShown()) void load(e); else e.stale = true; }, EVENT_SETTLE_MS);
  };
  const offs = topics.map((topic) => subscribe(topic, { message: on }));
  e.off = () => { clearTimeout(soon); offs.forEach((o) => o()); };
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (docShown()) entries.forEach(revive); });

// whether the tab around a reader shows: the workbench sets it per pane, anything outside one shows
export const Visible = createContext(true);
export const useVisible = () => useContext(Visible);

type Options = { poll?: number; topics?: string[] };

// key null reads nothing; fetcher is how the key loads (the latest one given wins)
export function useResource<T>(key: string | null, fetcher: () => Promise<T>, { poll = 0, topics = [] }: Options = {}) {
  const shown = useVisible();
  const reader = useRef<Reader>({ shown, poll });
  const e = key ? entryOf(key, fetcher) : null;
  if (e) e.fetcher = fetcher;
  const topicKey = topics.join('|');
  useEffect(() => {
    if (!e) return undefined;
    const r = reader.current;
    e.readers.add(r);
    follow(e, topics);
    retime(e);
    if (r.shown && !e.flight && (e.stale || Date.now() - e.snap.at > FRESH_MS)) void load(e);
    return () => {
      e.readers.delete(r);
      retime(e);
      if (!e.readers.size) { e.off?.(); e.off = null; e.topics = ''; }
    };
  }, [key]);
  useEffect(() => { if (e && e.readers.size) follow(e, topics); }, [key, topicKey]);
  useEffect(() => {
    const r = reader.current;
    const was = r.shown;
    r.shown = shown;
    r.poll = poll;
    if (!e) return;
    retime(e);
    if (shown && !was) revive(e);
  }, [key, shown, poll]);
  const snap = useSyncExternalStore(
    (l) => { if (!e) return () => {}; e.listeners.add(l); return () => void e.listeners.delete(l); },
    () => (e ? e.snap : EMPTY),
  ) as Snapshot<T>;
  return {
    ...snap,
    // reload now, through another fetcher for a fresh read
    reload: (via?: () => Promise<T>) => (e ? (load(e, via) as Promise<T>) : Promise.reject(new Error('nothing to read'))),
    // put a value an action answered with
    put: (data: T) => { if (e) { e.seq++; e.flight = null; set(e, { data, err: '', at: Date.now(), loading: false }); } },
  };
}

// a read outside React: the cached value, loading it first when nothing holds it yet
export const readCached = <T>(key: string, fetcher: () => Promise<T>) => {
  const e = entryOf(key, fetcher);
  return (e.snap.data !== undefined ? Promise.resolve(e.snap.data) : load(e)) as Promise<T>;
};
// an early value while the read goes on (a saved snapshot before the fresh one): the read in flight still lands
export const show = (key: string, data: unknown) => { const e = entries.get(key); if (e) set(e, { data }); };
export const peek =<T>(key: string) => entries.get(key)?.snap.data as T | undefined;
// after a change: a new read, superseding one started before it
export const reloadKey = <T>(key: string, fetcher: () => Promise<T>) => load(entryOf(key, fetcher), fetcher) as Promise<T>;

// an interval that runs only while its tab and the window show, and once on showing again when a tick was missed
export function useShownInterval(fn: () => unknown, ms: number, on = true) {
  const shown = useVisible();
  const doc = useSyncExternalStore((l) => { document.addEventListener('visibilitychange', l); return () => document.removeEventListener('visibilitychange', l); }, docShown);
  const last = useRef(0);
  const cb = useRef(fn);
  cb.current = fn;
  const live = on && shown && doc && ms > 0;
  useEffect(() => {
    if (!live) return undefined;
    const tick = () => { last.current = Date.now(); cb.current(); };
    if (last.current && Date.now() - last.current >= ms) tick();
    else if (!last.current) last.current = Date.now();
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [live, ms]);
}
