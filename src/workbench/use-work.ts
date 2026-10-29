import { createContext, useContext, useEffect } from 'react';
import { api } from '../api.ts';
import { topic } from '../live.ts';
import { useResource } from '../resource.ts';
import { ask } from '../components/Dialogs.tsx';
import type { ImportArtifactBody, StackRow, WorkDetail, WorkPlan } from '../types.ts';
import type { WorkData, WorkPr } from './types.ts';

export const WorkContext = createContext<WorkData | null>(null);
export const useWork = (): WorkData => {
  const ctx = useContext(WorkContext);
  if (!ctx) throw new Error('useWork outside a WorkContext');
  return ctx;
};

export type LoadedWork = Omit<WorkData, 'w'> & { w: WorkDetail | null };

const FRESH_ON_FOCUS_MS = 30000;
const freshAt = new Map<string, number>();

const POLL_MS = 30000;
const SYNC_POLL_MS = 5000;

// the work and its plan from the shared cache: a work opened again paints from what it last held while both reload; the server's
// work events (saved, stack, plan, drift, artifacts) reload them, a burst making one load
export function useWorkData(slug: string): LoadedWork {
  const topics = [topic('work', slug)];
  const work = useResource<WorkDetail>(`/api/works/${slug}`, () => api.work(slug), { poll: POLL_MS, topics });
  const syncing = Boolean(work.data?.notionStatus?.running);
  const planned = useResource<WorkPlan>(`/api/works/${slug}/plan`, () => api.plan(slug), { poll: syncing ? SYNC_POLL_MS : POLL_MS, topics });
  const w = work.data ?? null;
  const plan = planned.data ?? null;
  const err = w ? '' : work.err;
  const refreshing = work.loading || planned.loading;
  const load = (fresh = false) => Promise.all([work.reload(fresh ? () => api.work(slug, true) : undefined), planned.reload()]).then(() => {}, () => {});
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // every mounted view of the work hears the same focus: one GitHub refresh per slug and window
      if (Date.now() - (freshAt.get(slug) || 0) < FRESH_ON_FOCUS_MS) return;
      freshAt.set(slug, Date.now());
      void work.reload(() => api.work(slug, true)).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [slug]);
  const prs: WorkPr[] = plan?.prs || w?.prs || [];
  const saveStack = async (stack: StackRow[]) => { await api.updateWork(slug, { stack }); await load(); };
  const saveMeta = async ({ title, description }: { title: string; description?: string }) => { await api.updateWork(slug, { title: title.slice(0, 100), description }); await load(); };
  const saveNotes = async (notes: string) => { await api.updateWork(slug, { notes }); await load(); };
  const addNote = async (text: string) => { if (!text) return; await api.addTimeline(slug, { kind: 'note', text }); load(); };
  const importArtifact = async (body: ImportArtifactBody) => { const r = await api.importArtifact(slug, body); load(); return r; };
  const addLink = async () => {
    const [label, url] = ((await ask({ title: 'Add a link', fields: ['Label', 'URL'], ok: 'Add' })) ?? []).map((v) => v.trim());
    if (!label || !url) return;
    await api.updateWork(slug, { links: [...(w?.links || []), { label, url }] });
    load();
  };
  const decide = async (body: Record<string, unknown>) => { await api.decide(slug, body); load(); };
  return { slug, w, plan, prs, refreshing, err, load, saveStack, saveMeta, saveNotes, addNote, importArtifact, addLink, decide };
}
