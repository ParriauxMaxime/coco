import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useShownInterval, useVisible } from '../../resource.ts';
import { codeApi } from './code-api.ts';
import type { CommentInput, CommentPatch, PrKey, Proposal, Refs, ReviewComment, ReviewPlanState, ReviewRun } from '../types.ts';

const POLL_MS = 30000;
const PLAN_POLL_MS = 3000;

export type ReviewEntry = {
  comments: ReviewComment[];
  drafts: ReviewComment[];
  runs: ReviewRun[];
  refs: Refs | null;
  plan: ReviewPlanState | null;
  headSha: string | null;
  mergeBase: string | null;
  error: string;
  notice: string;
  loaded: boolean;
};

const EMPTY: ReviewEntry = { comments: [], drafts: [], runs: [], refs: null, plan: null, headSha: null, mergeBase: null, error: '', notice: '', loaded: false };

const json = async (res: Response) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};
const send = (method: string, url: string, body?: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(json);
const prUrl = (slug: string, n: PrKey) => `/api/works/${slug}/prs/${n}`;

export const reviewApi = {
  comments: (slug: string, n: PrKey) => fetch(`${prUrl(slug, n)}/comments`).then(json),
  add: (slug: string, n: PrKey, input: CommentInput) => send('POST', `${prUrl(slug, n)}/comments`, input),
  update: (slug: string, n: PrKey, id: string, patch: CommentPatch) => send('PUT', `${prUrl(slug, n)}/comments/${id}`, patch),
  remove: (slug: string, n: PrKey, id: string) => send('DELETE', `${prUrl(slug, n)}/comments/${id}`),
  reanchor: (slug: string, n: PrKey, shas: { headSha: string; mergeBase: string }) => send('POST', `${prUrl(slug, n)}/comments/reanchor`, shas),
  runs: (slug: string, n: PrKey) => fetch(`${prUrl(slug, n)}/review-runs`).then(json),
  logs: (slug: string, n: PrKey, runId: string) => fetch(`${prUrl(slug, n)}/review-runs/${runId}/logs`).then(json),
  brief: (slug: string, n: PrKey, runId: string) => fetch(`${prUrl(slug, n)}/review-runs/${runId}/brief`).then((r) => (r.ok ? r.text() : '')),
  pushed: (slug: string, n: PrKey, runId: string) => send('POST', `${prUrl(slug, n)}/review-runs/${runId}/pushed`),
  plan: (slug: string, n: PrKey) => fetch(`${prUrl(slug, n)}/review-plan`).then(json),
  startPlan: (slug: string, n: PrKey, body?: { guidance?: string; auto?: boolean }) => send('POST', `${prUrl(slug, n)}/review-plan`, body),
  tick: (slug: string, n: PrKey, body: { headSha: string; path: string; on: boolean }) => send('PUT', `${prUrl(slug, n)}/review-plan/ticks`, body),
  watch: (slug: string, n: PrKey, body: { index: number; state: string; note?: string }) => send('PUT', `${prUrl(slug, n)}/review-plan/watch`, body),
  stackFix: (slug: string) => fetch(`/api/works/${slug}/stack-fix`).then(json),
  startStackFix: (slug: string, body: Record<string, unknown>) => send('POST', `/api/works/${slug}/stack-fix`, body),
  stackFixLogs: (slug: string, id: string) => fetch(`/api/works/${slug}/stack-fix/${id}/logs`).then(json),
  stackFixBrief: (slug: string, id: string) => fetch(`/api/works/${slug}/stack-fix/${id}/brief`).then((r) => (r.ok ? r.text() : '')),
  reviewFiles: (slug: string) => fetch(`/api/works/${slug}/import-review`).then(json),
  importReview: (slug: string, path: string) => send('POST', `/api/works/${slug}/import-review`, { path }),
};

export const useReviewStore = create<{ prs: Record<string, ReviewEntry> }>()(() => ({ prs: {} }));
const key = (slug: string, n: PrKey) => `${slug}:${n}`;
const entry = (slug: string, n: PrKey) => useReviewStore.getState().prs[key(slug, n)] || EMPTY;
const put = (slug: string, n: PrKey, f: (cur: ReviewEntry) => Partial<ReviewEntry>) => useReviewStore.setState((s) => {
  const k = key(slug, n);
  const cur = s.prs[k] || EMPTY;
  return { prs: { ...s.prs, [k]: { ...cur, ...f(cur) } } };
});

const inflight = new Map<string, Promise<void>>();
export function loadReview(slug: string, n: PrKey, { fresh = false }: { fresh?: boolean } = {}) {
  const k = key(slug, n);
  const running = inflight.get(k);
  if (running) return running;
  const p = (async () => {
    try {
      const [refs, stored, runs, plan] = await Promise.all([codeApi.refs(n, fresh),reviewApi.comments(slug, n), reviewApi.runs(slug, n).catch(() => ({ runs: entry(slug, n).runs })), reviewApi.plan(slug, n).catch(() => entry(slug, n).plan)]);
      let data = stored;
      if (data.comments.length && (refs.headSha !== data.headSha || refs.mergeBase !== data.mergeBase)) {
        await reviewApi.reanchor(slug, n, { headSha: refs.headSha, mergeBase: refs.mergeBase });
        data = await reviewApi.comments(slug, n);
      }
      put(slug, n, () => ({ refs, plan, comments: data.comments.filter((c: ReviewComment) => !c.kind), headSha: data.headSha, mergeBase: data.mergeBase, runs: runs.runs || [], error: '', loaded: true }));
    } catch (e) {
      put(slug, n, () => ({ error: e instanceof Error ? e.message : String(e), loaded: true }));
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

const loadPlan = (slug: string, n: PrKey) => reviewApi.plan(slug, n).then((plan) => put(slug, n, () => ({ plan })), () => {});

// shown: the watchers whose tab shows; a PR whose tabs all hide polls nothing and catches up once one shows again
type Watcher = { count: number; shown: number; at: number; stop: () => void };
const watchers = new Map<string, Watcher>();
function watch(slug: string, n: PrKey, shown: boolean) {
  const k = key(slug, n);
  const w = watchers.get(k);
  if (w) { w.count++; showing(slug, n, shown ? 1 : 0); return; }
  // the head moves outside cocopilot (a push from a terminal): ask GitHub again on open, focus and return
  const visible = () => document.visibilityState === 'visible';
  const me: Watcher = { count: 1, shown: shown ? 1 : 0, at: Date.now(), stop: () => {} };
  const recheck = () => { if (visible() && me.shown) { me.at = Date.now(); loadReview(slug, n, { fresh: true }); } };
  const timer = setInterval(() => { if (visible() && me.shown) { me.at = Date.now(); loadReview(slug, n); } }, POLL_MS);
  document.addEventListener('visibilitychange', recheck);
  window.addEventListener('focus', recheck);
  me.stop = () => { clearInterval(timer); document.removeEventListener('visibilitychange', recheck); window.removeEventListener('focus', recheck); };
  watchers.set(k, me);
  loadReview(slug, n, { fresh: true });
}
function showing(slug: string, n: PrKey, delta: number) {
  const w = watchers.get(key(slug, n));
  if (!w) return;
  const was = w.shown;
  w.shown += delta;
  if (!was && w.shown && Date.now() - w.at > POLL_MS) { w.at = Date.now(); loadReview(slug, n); }
}
function unwatch(slug: string, n: PrKey, shown: boolean) {
  const k = key(slug, n);
  const w = watchers.get(k);
  if (!w) return;
  if (shown) w.shown--;
  if (--w.count > 0) return;
  w.stop();
  watchers.delete(k);
}

const actions = (slug: string, n: PrKey) => ({
  load: () => loadReview(slug, n),
  add: async (input: CommentInput): Promise<ReviewComment> => {
    const c = await reviewApi.add(slug, n, input);
    put(slug, n, (cur) => ({ comments: [...cur.comments, c] }));
    return c;
  },
  update: async (id: string, patch: CommentPatch): Promise<ReviewComment> => {
    const c = await reviewApi.update(slug, n, id, patch);
    put(slug, n, (cur) => ({ comments: cur.comments.map((x) => (x.id === id ? c : x)) }));
    return c;
  },
  remove: async (id: string) => {
    await reviewApi.remove(slug, n, id);
    put(slug, n, (cur) => ({ comments: cur.comments.filter((x) => x.id !== id) }));
  },
  addDraft: (draft: Omit<CommentInput, 'body'>) => {
    const d: ReviewComment = { ...draft, id: `draft-${Date.now()}`, draft: true, status: 'draft', body: '' };
    put(slug, n, (cur) => ({ drafts: [...cur.drafts.filter((x) => x.path !== d.path), d] }));
    return d;
  },
  dropDraft: (id: string) => put(slug, n, (cur) => ({ drafts: cur.drafts.filter((x) => x.id !== id) })),
  setNotice: (notice: string) => put(slug, n, () => ({ notice })),
  startPlan: async (guidance?: string) => {
    await reviewApi.startPlan(slug, n, guidance ? { guidance } : undefined);
    await loadPlan(slug, n);
  },
  autoPlan: async () => {
    const { started } = await reviewApi.startPlan(slug, n, { auto: true });
    if (started) await loadPlan(slug, n);
  },
  tick: (path: string, on: boolean) => {
    const { plan } = entry(slug, n);
    if (!plan) return Promise.resolve();
    const ticks = on ? [...new Set([...plan.ticks, path])] : plan.ticks.filter((p) => p !== path);
    put(slug, n, (cur) => ({ plan: cur.plan && { ...cur.plan, ticks } }));
    return reviewApi.tick(slug, n, { headSha: plan.headSha, path, on });
  },
  setWatch: async (index: number, state: string, note?: string) => {
    const { watch } = await reviewApi.watch(slug, n, { index, state, note });
    put(slug, n, (cur) => ({ plan: cur.plan && { ...cur.plan, watch } }));
  },
});

export function useComments(slug: string, n: PrKey, { watch: live = true } = {}) {
  const e = useReviewStore((s) => s.prs[key(slug, n)]) || EMPTY;
  const shown = useVisible();
  const shownAt = useRef(shown);
  useEffect(() => {
    if (!slug || !n || !live) return undefined;
    const on = shownAt.current;
    watch(slug, n, on);
    return () => unwatch(slug, n, shownAt.current);
  }, [slug, n, live]);
  useEffect(() => {
    if (shownAt.current === shown) return;
    shownAt.current = shown;
    if (slug && n && live) showing(slug, n, shown ? 1 : -1);
  }, [shown]);
  const act = useMemo(() => actions(slug, n), [slug, n]);
  const planning = e.plan?.run?.status === 'running';
  useShownInterval(() => n && loadPlan(slug, n), PLAN_POLL_MS, Boolean(planning && live && n));
  const derived = useMemo(() => {
    const byPath: Record<string, number> = {};
    const counts: Record<string, number> = { open: 0, sent: 0, fixed: 0, declined: 0, outdated: 0 };
    for (const c of e.comments) {
      byPath[c.path] = (byPath[c.path] || 0) + 1;
      counts[c.status] = (counts[c.status] || 0) + 1;
    }
    const state = e.plan;
    const plan = state?.plan;
    const proposals: Proposal[] = plan && state && !state.stale ? plan.watchPoints.map((w, index): Proposal => ({ ...w, index, id: `wp-${index}`, side: 'head', sha: plan.headSha, status: 'proposed', proposal: true })).filter((w) => !state.watch[w.index]) : [];
    return { byPath, counts, proposals };
  }, [e.comments, e.plan]);
  return { ...e, ...derived, ...act, slug, n };
}

export type ReviewHandle = ReturnType<typeof useComments>;

export const putRuns = (slug: string, n: PrKey, runs: ReviewRun[]) => put(slug, n, () => ({ runs }));

export function findRun(slug: string, runId: string, prs: Record<string, ReviewEntry> = useReviewStore.getState().prs): ReviewRun | null {
  for (const [k, v] of Object.entries(prs)) {
    if (!k.startsWith(`${slug}:`)) continue;
    const run = v.runs.find((r) => r.runId === runId);
    if (run) return run;
  }
  return null;
}
