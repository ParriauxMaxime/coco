import { useEffect } from 'react';
import { create } from 'zustand';
import { subscribe } from '../live.ts';
import type { WaitingItem, WaitingView } from '../types.ts';

// everything that waits on the owner, pushed by the server on each change; one stream for the whole page.
// Every "waiting on you" count reads it: the sidebar, the status bar, the dock, the Agents page, a work's tree and its agents' state
const useStore = create<{ view: WaitingView | null }>(() => ({ view: null }));
let following = false;
const connect = () => {
  if (following) return;
  following = true;
  subscribe('waiting', { message: (view: WaitingView) => useStore.setState({ view }) });
};

export function useWaiting() {
  useEffect(connect, []);
  return useStore((s) => s.view);
}

const NONE: Record<string, number> = {};
// how many items each agent holds: an agent with any is waiting on you
export function useWaitingByAgent() {
  useEffect(connect, []);
  return useStore((s) => s.view?.byAgent ?? NONE);
}

// a work's items, or the ones of one of its PRs (null: the work itself)
export const itemsOf = (view: WaitingView | null, slug: string, pr?: string | null) => (view?.items ?? []).filter((i) => i.work === slug && (pr === undefined || i.pr === pr));

const viewOf = (items: WaitingItem[]): WaitingView => {
  const tally = (key: (i: WaitingItem) => string | null) => {
    const out: Record<string, number> = {};
    for (const i of items) {
      const k = key(i);
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return out;
  };
  return { items, count: items.length, byAgent: tally((i) => i.agentId), byWork: tally((i) => i.work) };
};
// an item the owner just handled leaves the list at once; the next push confirms it
export const forget = (ids: string[]) => useStore.setState((s) => (s.view ? { view: viewOf(s.view.items.filter((i) => !ids.includes(i.id))) } : s));
