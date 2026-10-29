import { api } from '../api.ts';
import { readCached, reloadKey, useResource } from '../resource.ts';
import type { Overview } from '../types.ts';

const POLL_MS = 30000;
const KEY = '/api/overview';
const fetcher = () => api.overview();

export const reloadOverview = () => reloadKey(KEY, fetcher).catch(() => {});
export const cachedOverview = () => readCached(KEY, fetcher);

// one read and one poll for every page of the shell, however many views show it
export function useOverview() {
  const { data, err } = useResource<Overview>(KEY, fetcher, { poll: POLL_MS });
  return { ov: data ?? null, err: data ? '' : err };
}
