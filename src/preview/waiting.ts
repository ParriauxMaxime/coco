import { useEffect } from 'react';
import { create } from 'zustand';
import { subscribe } from '../live.ts';
import type { WaitingView } from '../types.ts';

// everything that waits on the owner, pushed by the server on each change; one stream for the whole page
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

// an item the owner just handled leaves the list at once; the next push confirms it
export const forget = (ids: string[]) => useStore.setState((s) => (s.view ? { view: { items: s.view.items.filter((i) => !ids.includes(i.id)), count: s.view.items.filter((i) => !ids.includes(i.id)).length } } : s));
