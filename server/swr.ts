import fs from 'node:fs';
import path from 'node:path';

const PERSIST_MAX_AGE_MS = 24 * 3600 * 1000;
export const cacheFile = (DATA: string | undefined, name: string) => (DATA ? path.join(DATA, 'cache', `${name}.json`) : undefined);

function persisted<T>(file: string | undefined) {
  const values = new Map<string, { at: number; value: T }>();
  if (!file) return { values, save: () => {} };
  try {
    const raw: Record<string, { at: number; value: T }> = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, e] of Object.entries(raw)) if (Date.now() - e.at < PERSIST_MAX_AGE_MS) values.set(k, e);
  } catch {}
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    timer ??= setTimeout(() => {
      timer = null;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(values)));
      fs.renameSync(`${file}.tmp`, file);
    }, 1000);
    timer.unref();
  };
  return { values, save };
}

// a GitHub refresh asked within this long of the last one is served from it
export const GITHUB_MIN_FRESH_MS = 15000;

// stale-while-revalidate: an expired entry is served at once and refreshed in the background; with a file, entries outlive a restart
// minFreshMs: a fresh read of an entry younger than that, or already refreshing, gets that entry instead of a new call
// changed: called when a refresh lands a value that differs from the one it replaces, so open pages can be told
export function swrCache<T>(ttlMs: number, file?: string, { minFreshMs = 0, changed }: { minFreshMs?: number; changed?: (key: string, value: T) => void } = {}) {
  const store = persisted<T>(file);
  const cache = new Map<string, { at: number; value: Promise<T> }>([...store.values].map(([k, e]) => [k, { at: e.at, value: Promise.resolve(e.value) }]));
  const remember = (key: string, at: number, value: T) => {
    if (!file) return;
    store.values.set(key, { at, value });
    store.save();
  };
  const refreshing = new Map<string, Promise<T>>();
  const refresh = (key: string, fn: () => Promise<T>) => {
    const next = fn();
    const before = cache.get(key)?.value;
    refreshing.set(key, next);
    next.then(async (v) => {
      cache.set(key, { at: Date.now(), value: next });
      remember(key, Date.now(), v);
      if (changed && before && JSON.stringify(await before.catch(() => null)) !== JSON.stringify(v)) changed(key, v);
    }, () => {}).finally(() => refreshing.get(key) === next && refreshing.delete(key));
    return next;
  };
  const read = (key: string, fn: () => Promise<T>, fresh = false): Promise<T> => {
    const hit = cache.get(key);
    if (hit && fresh && minFreshMs) {
      const running = refreshing.get(key);
      if (running) return running;
      if (Date.now() - hit.at < minFreshMs) return hit.value;
    }
    // other callers keep the old value until the new one lands
    if (hit && fresh) return refresh(key, fn);
    if (hit) {
      if (Date.now() - hit.at >= ttlMs && !refreshing.has(key)) refresh(key, fn);
      return hit.value;
    }
    const value = fn();
    const at = Date.now();
    cache.set(key, { at, value });
    value.then((v) => remember(key, at, v), () => cache.get(key)?.value === value && cache.delete(key));
    return value;
  };
  // forget a key (every key without one): the next read recomputes instead of serving the old value once
  const drop = (key?: string) => {
    for (const k of key === undefined ? [...cache.keys()] : [key]) {
      cache.delete(k);
      store.values.delete(k);
    }
    store.save();
  };
  // mark a key (every key without one) expired: the next read still gets the old value at once and refreshes it
  const expire = (key?: string) => {
    for (const k of key === undefined ? [...cache.keys()] : [key]) {
      const hit = cache.get(k);
      if (hit) hit.at = 0;
    }
  };
  return Object.assign(read, { drop, expire, has: (key: string) => cache.has(key) });
}

// fn over items, at most `limit` at once, results in the items' order
export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// calls made within `windowMs` of each other share one `fetchMany`; a key missing from its result rejects
export function batcher<K, V>(fetchMany: (keys: K[]) => Promise<Map<K, V>>, windowMs = 10) {
  let queue: Map<K, { resolve: (v: V) => void; reject: (e: Error) => void }[]> | null = null;
  const flush = async (batch: NonNullable<typeof queue>) => {
    try {
      const found = await fetchMany([...batch.keys()]);
      for (const [k, waiters] of batch) {
        const v = found.get(k);
        for (const w of waiters) (v === undefined ? w.reject(new Error(`not found: ${String(k)}`)) : w.resolve(v));
      }
    } catch (e) {
      for (const waiters of batch.values()) for (const w of waiters) w.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  return (key: K) =>
    new Promise<V>((resolve, reject) => {
      if (!queue) {
        const batch = new Map<K, { resolve: (v: V) => void; reject: (e: Error) => void }[]>();
        queue = batch;
        setTimeout(() => { queue = null; flush(batch); }, windowMs);
      }
      queue.set(key, [...(queue.get(key) || []), { resolve, reject }]);
    });
}
