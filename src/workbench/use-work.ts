import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { subscribe, topic } from '../live.ts';
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
  const latest = useRef(0);
  // only the newest load lands: a slow older one must not put the old work back
  const load = (fresh = false) => {
    const n = ++latest.current;
    setRefreshing(true);
    return Promise.all([api.work(slug, fresh), api.plan(slug)]).then(([d, p]) => { if (n === latest.current) { setW(d); setPlan(p); } }).catch((e: Error) => { if (n === latest.current) setErr(e.message); }).finally(() => { if (n === latest.current) setRefreshing(false); });
  };
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 30000);
    const onVisible = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onVisible);
    // the server says this work changed (saved, stack, plan, drift, artifacts): events in a burst make one load
    let soon: ReturnType<typeof setTimeout>;
    const off = subscribe(topic('work', slug), { message: () => { clearTimeout(soon); soon = setTimeout(() => load(), 50); } });
    return () => { clearInterval(t); clearTimeout(soon); document.removeEventListener('visibilitychange', onVisible); off(); };
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
