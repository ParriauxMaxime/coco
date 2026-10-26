import { useEffect } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api.ts';
import type { Overview } from '../types.ts';

const POLL_MS = 30000;

const useStore = create<{ ov: Overview | null; err: string }>(() => ({ ov: null, err: '' }));
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export const reloadOverview = () => api.overview().then((ov) => useStore.setState({ ov, err: '' }), (e) => useStore.setState({ err: errorMessage(e) }));

// one poll for every page of the new shell, running while one of them is mounted
export function useOverview() {
  useEffect(() => {
    if (!users++) {
      void reloadOverview();
      timer = setInterval(() => void reloadOverview(), POLL_MS);
    }
    return () => {
      if (!--users && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return useStore();
}
