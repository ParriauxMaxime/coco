// stale-while-revalidate: an expired entry is served at once and refreshed in the background
export function swrCache<T>(ttlMs: number) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  const refreshing = new Set<string>();
  const refresh = (key: string, fn: () => Promise<T>) => {
    refreshing.add(key);
    const next = fn();
    next.then(() => cache.set(key, { at: Date.now(), value: next }), () => {}).finally(() => refreshing.delete(key));
    return next;
  };
  return (key: string, fn: () => Promise<T>, fresh = false): Promise<T> => {
    const hit = cache.get(key);
    // other callers keep the old value until the new one lands
    if (hit && fresh) return refresh(key, fn);
    if (hit) {
      if (Date.now() - hit.at >= ttlMs && !refreshing.has(key)) refresh(key, fn);
      return hit.value;
    }
    const value = fn();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.get(key)?.value === value && cache.delete(key));
    return value;
  };
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
