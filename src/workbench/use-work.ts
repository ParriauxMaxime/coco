import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { ImportArtifactBody, StackRow, WorkDetail, WorkPlan } from '../types.ts';
import type { WorkData, WorkPr } from './types.ts';

export const WorkContext = createContext<WorkData | null>(null);
export const useWork = (): WorkData => {
  const ctx = useContext(WorkContext);
  if (!ctx) throw new Error('useWork outside a WorkContext');
  return ctx;
};

export type LoadedWork = Omit<WorkData, 'w'> & { w: WorkDetail | null };

export function useWorkData(slug: string): LoadedWork {
  const [w, setW] = useState<WorkDetail | null>(null);
  const [plan, setPlan] = useState<WorkPlan | null>(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = (fresh = false) => {
    setRefreshing(true);
    return Promise.all([api.work(slug, fresh), api.plan(slug)]).then(([d, p]) => { setW(d); setPlan(p); }).catch((e: Error) => setErr(e.message)).finally(() => setRefreshing(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 30000);
    const onVisible = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onVisible);
    const saved = new EventSource('/api/works/events');
    saved.onmessage = (e: MessageEvent<string>) => (JSON.parse(e.data) as { slug: string }).slug === slug && load();
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); saved.close(); };
  }, [slug]);
  const syncing = Boolean(w?.notionStatus?.running);
  useEffect(() => { if (!syncing) return; const t = setInterval(() => load(), 5000); return () => clearInterval(t); }, [syncing]);
  const prs: WorkPr[] = plan?.prs || w?.prs || [];
  const saveStack = async (stack: StackRow[]) => { await api.updateWork(slug, { stack }); await load(); };
  const saveMeta = async ({ title, description }: { title: string; description?: string }) => { await api.updateWork(slug, { title: title.slice(0, 100), description }); await load(); };
  const saveNotes = async (notes: string) => { await api.updateWork(slug, { notes }); await load(); };
  const addNote = async (text: string) => { if (!text) return; await api.addTimeline(slug, { kind: 'note', text }); load(); };
  const importArtifact = async (body: ImportArtifactBody) => { const r = await api.importArtifact(slug, body); load(); return r; };
  const addLink = async () => { const label = prompt('Label'); const url = label && prompt('URL'); if (!label || !url) return; await api.updateWork(slug, { links: [...(w?.links || []), { label, url }] }); load(); };
  const decide = async (body: Record<string, unknown>) => { await api.decide(slug, body); load(); };
  return { slug, w, plan, prs, refreshing, err, load, saveStack, saveMeta, saveNotes, addNote, importArtifact, addLink, decide };
}
