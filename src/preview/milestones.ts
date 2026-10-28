import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { reloadOverview } from './overview.ts';

type Steps = Record<string, string | null>;
const EMPTY: Steps = {};
const useStore = create<{ by: Record<string, Steps> }>(() => ({ by: {} }));
const watchers = new Map<string, { users: number; stop: () => void }>();

// one load per work however many views read it; computing them also refreshes the sidebar bar
function watch(slug: string) {
  const w = watchers.get(slug);
  if (w) w.users++;
  else {
    let live = true;
    const load = () => api.milestones(slug).then((r) => {
      if (!live) return;
      useStore.setState((s) => ({ by: { ...s.by, [slug]: Object.fromEntries(r.rows.map((x) => [String(x.key), x.current])) } }));
      void reloadOverview();
    }, () => {});
    load();
    let soon: ReturnType<typeof setTimeout>;
    const off = subscribe(topic('work', slug), { message: () => { clearTimeout(soon); soon = setTimeout(load, 500); } });
    watchers.set(slug, { users: 1, stop: () => { live = false; clearTimeout(soon); off(); } });
  }
  return () => {
    const cur = watchers.get(slug);
    if (cur && !--cur.users) { cur.stop(); watchers.delete(slug); }
  };
}

// each stack row's current milestone by PR key
export function useMilestones(slug: string | null) {
  useEffect(() => (slug ? watch(slug) : undefined), [slug]);
  return useStore((s) => (slug && s.by[slug]) || EMPTY);
}
