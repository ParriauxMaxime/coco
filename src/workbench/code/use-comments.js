import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { codeApi } from './code-api.js';

const POLL_MS = 30000;
const PLAN_POLL_MS = 3000;
const EMPTY = { comments: [], drafts: [], runs: [], refs: null, plan: null, headSha: null, mergeBase: null, error: '', notice: '', loaded: false };

const json = async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
};
const send = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then(json);
const prUrl = (slug, n) => `/api/works/${slug}/prs/${n}`;

export const reviewApi = {
  comments: (slug, n) => fetch(`${prUrl(slug, n)}/comments`).then(json),
  add: (slug, n, input) => send('POST', `${prUrl(slug, n)}/comments`, input),
  update: (slug, n, id, patch) => send('PUT', `${prUrl(slug, n)}/comments/${id}`, patch),
  remove: (slug, n, id) => send('DELETE', `${prUrl(slug, n)}/comments/${id}`),
  reanchor: (slug, n, shas) => send('POST', `${prUrl(slug, n)}/comments/reanchor`, shas),
  runs: (slug, n) => fetch(`${prUrl(slug, n)}/review-runs`).then(json),
  logs: (slug, n, runId) => fetch(`${prUrl(slug, n)}/review-runs/${runId}/logs`).then(json),
  brief: (slug, n, runId) => fetch(`${prUrl(slug, n)}/review-runs/${runId}/brief`).then((r) => (r.ok ? r.text() : '')),
  pushed: (slug, n, runId) => send('POST', `${prUrl(slug, n)}/review-runs/${runId}/pushed`),
  plan: (slug, n) => fetch(`${prUrl(slug, n)}/review-plan`).then(json),
  startPlan: (slug, n, body) => send('POST', `${prUrl(slug, n)}/review-plan`, body),
  tick: (slug, n, body) => send('PUT', `${prUrl(slug, n)}/review-plan/ticks`, body),
  watch: (slug, n, body) => send('PUT', `${prUrl(slug, n)}/review-plan/watch`, body),
  stackFix: (slug) => fetch(`/api/works/${slug}/stack-fix`).then(json),
  startStackFix: (slug, body) => send('POST', `/api/works/${slug}/stack-fix`, body),
  stackFixLogs: (slug, id) => fetch(`/api/works/${slug}/stack-fix/${id}/logs`).then(json),
  stackFixBrief: (slug, id) => fetch(`/api/works/${slug}/stack-fix/${id}/brief`).then((r) => (r.ok ? r.text() : '')),
  reviewFiles: (slug) => fetch(`/api/works/${slug}/import-review`).then(json),
  importReview: (slug, path) => send('POST', `/api/works/${slug}/import-review`, { path }),
};

export const useReviewStore = create(() => ({ prs: {} }));
const key = (slug, n) => `${slug}:${n}`;
const entry = (slug, n) => useReviewStore.getState().prs[key(slug, n)] || EMPTY;
const put = (slug, n, f) => useReviewStore.setState((s) => {
  const k = key(slug, n);
  const cur = s.prs[k] || EMPTY;
  return { prs: { ...s.prs, [k]: { ...cur, ...f(cur) } } };
});

const inflight = new Map();
export function loadReview(slug, n, { fresh = false } = {}) {
  const k = key(slug, n);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const [refs, stored, runs, plan] = await Promise.all([codeApi.refs(n, fresh),reviewApi.comments(slug, n), reviewApi.runs(slug, n).catch(() => ({ runs: entry(slug, n).runs })), reviewApi.plan(slug, n).catch(() => entry(slug, n).plan)]);
      let data = stored;
      if (data.comments.length && (refs.headSha !== data.headSha || refs.mergeBase !== data.mergeBase)) {
        await reviewApi.reanchor(slug, n, { headSha: refs.headSha, mergeBase: refs.mergeBase });
        data = await reviewApi.comments(slug, n);
      }
      put(slug, n, () => ({ refs, plan, comments: data.comments, headSha: data.headSha, mergeBase: data.mergeBase, runs: runs.runs || [], error: '', loaded: true }));
    } catch (e) {
      put(slug, n, () => ({ error: e.message, loaded: true }));
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

const loadPlan = (slug, n) => reviewApi.plan(slug, n).then((plan) => put(slug, n, () => ({ plan })), () => {});

const watchers = new Map();
function watch(slug, n) {
  const k = key(slug, n);
  const w = watchers.get(k);
  if (w) { w.count++; return; }
  // the head moves outside cocopilot (a push from a terminal): ask GitHub again on open, focus and return
  const visible = () => document.visibilityState === 'visible';
  const recheck = () => visible() && loadReview(slug, n, { fresh: true });
  const timer = setInterval(() => visible() && loadReview(slug, n), POLL_MS);
  document.addEventListener('visibilitychange', recheck);
  window.addEventListener('focus', recheck);
  watchers.set(k, { count: 1, stop: () => { clearInterval(timer); document.removeEventListener('visibilitychange', recheck); window.removeEventListener('focus', recheck); } });
  loadReview(slug, n, { fresh: true });
}
function unwatch(slug, n) {
  const k = key(slug, n);
  const w = watchers.get(k);
  if (!w || --w.count > 0) return;
  w.stop();
  watchers.delete(k);
}

const actions = (slug, n) => ({
  load: () => loadReview(slug, n),
  add: async (input) => {
    const c = await reviewApi.add(slug, n, input);
    put(slug, n, (cur) => ({ comments: [...cur.comments, c] }));
    return c;
  },
  update: async (id, patch) => {
    const c = await reviewApi.update(slug, n, id, patch);
    put(slug, n, (cur) => ({ comments: cur.comments.map((x) => (x.id === id ? c : x)) }));
    return c;
  },
  remove: async (id) => {
    await reviewApi.remove(slug, n, id);
    put(slug, n, (cur) => ({ comments: cur.comments.filter((x) => x.id !== id) }));
  },
  addDraft: (draft) => {
    const d = { ...draft, id: `draft-${Date.now()}`, draft: true, status: 'draft', body: '' };
    put(slug, n, (cur) => ({ drafts: [...cur.drafts.filter((x) => x.path !== d.path), d] }));
    return d;
  },
  dropDraft: (id) => put(slug, n, (cur) => ({ drafts: cur.drafts.filter((x) => x.id !== id) })),
  setNotice: (notice) => put(slug, n, () => ({ notice })),
  startPlan: async (guidance) => {
    await reviewApi.startPlan(slug, n, guidance ? { guidance } : undefined);
    await loadPlan(slug, n);
  },
  tick: (path, on) => {
    const { plan } = entry(slug, n);
    if (!plan) return Promise.resolve();
    const ticks = on ? [...new Set([...plan.ticks, path])] : plan.ticks.filter((p) => p !== path);
    put(slug, n, (cur) => ({ plan: { ...cur.plan, ticks } }));
    return reviewApi.tick(slug, n, { headSha: plan.headSha, path, on });
  },
  setWatch: async (index, state, note) => {
    const { watch } = await reviewApi.watch(slug, n, { index, state, note });
    put(slug, n, (cur) => ({ plan: { ...cur.plan, watch } }));
  },
});

export function useComments(slug, n, { watch: live = true } = {}) {
  const e = useReviewStore((s) => s.prs[key(slug, n)]) || EMPTY;
  useEffect(() => {
    if (!slug || !n || !live) return undefined;
    watch(slug, n);
    return () => unwatch(slug, n);
  }, [slug, n, live]);
  const act = useMemo(() => actions(slug, n), [slug, n]);
  const planning = e.plan?.run?.status === 'running';
  useEffect(() => {
    if (!planning || !live) return undefined;
    const timer = setInterval(() => loadPlan(slug, n), PLAN_POLL_MS);
    return () => clearInterval(timer);
  }, [planning, live, slug, n]);
  const derived = useMemo(() => {
    const byPath = {};
    const counts = { open: 0, sent: 0, fixed: 0, declined: 0, outdated: 0 };
    for (const c of e.comments) {
      byPath[c.path] = (byPath[c.path] || 0) + 1;
      counts[c.status] = (counts[c.status] || 0) + 1;
    }
    const plan = e.plan?.plan;
    const proposals = plan && !e.plan.stale ? plan.watchPoints.map((w, index) => ({ ...w, index, id: `wp-${index}`, side: 'head', sha: plan.headSha, status: 'proposed', proposal: true })).filter((w) => !e.plan.watch[w.index]) : [];
    return { byPath, counts, proposals };
  }, [e.comments, e.plan]);
  return { ...e, ...derived, ...act, slug, n };
}

export const putRuns = (slug, n, runs) => put(slug, n, () => ({ runs }));

export function findRun(slug, runId, prs = useReviewStore.getState().prs) {
  for (const [k, v] of Object.entries(prs)) {
    if (!k.startsWith(`${slug}:`)) continue;
    const run = v.runs.find((r) => r.runId === runId);
    if (run) return run;
  }
  return null;
}
