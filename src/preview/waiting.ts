import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { api } from '../api.ts';
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

// whether the element is on screen: not in a hidden tab or pane (the workbench keeps inactive tabs mounted), nor in a hidden browser tab
function useShown() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!el) return undefined;
    let inView = false;
    const update = () => setShown(inView && !document.hidden);
    const io = new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      update();
    });
    io.observe(el);
    document.addEventListener('visibilitychange', update);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', update);
      setShown(false);
    };
  }, [el]);
  return [setEl, shown] as const;
}

// a reply open in front of the owner is read: it stops waiting on them until the agent speaks again.
// Returns the ref of the element that shows it: only while it is on screen does it count as read
export function useSeen(id: string | null) {
  useEffect(connect, []);
  const there = useStore((s) => Boolean(id && s.view?.items.some((i) => i.id === id)));
  const [ref, shown] = useShown();
  useEffect(() => {
    if (!id || !there || !shown) return;
    forget([id]);
    api.ackWaiting([id]).catch(() => {});
  }, [id, there, shown]);
  return ref;
}
