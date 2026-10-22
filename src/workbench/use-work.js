import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api.js';

export const WorkContext = createContext(null);
export const useWork = () => useContext(WorkContext);

export function useWorkData(slug) {
  const [w, setW] = useState(null);
  const [plan, setPlan] = useState(null);
  const [err, setErr] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = (fresh = false) => {
    setRefreshing(true);
    return Promise.all([api.work(slug, fresh), api.plan(slug)]).then(([d, p]) => { setW(d); setPlan(p); }).catch((e) => setErr(e.message)).finally(() => setRefreshing(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 30000);
    const onVisible = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [slug]);
  const syncing = Boolean(w?.notionStatus?.running);
  useEffect(() => { if (!syncing) return; const t = setInterval(() => load(), 5000); return () => clearInterval(t); }, [syncing]);
  const prs = plan?.prs || w?.prs || [];
  const saveStack = async (stack) => { await api.updateWork(slug, { stack }); load(); };
  const saveMeta = async ({ title, description }) => { await api.updateWork(slug, { title: title.slice(0, 100), description }); load(); };
  const saveNotes = async (notes) => { await api.updateWork(slug, { notes }); load(); };
  const addNote = async (text) => { if (!text) return; await api.addTimeline(slug, { kind: 'note', text }); load(); };
  const importArtifact = async (body) => { const r = await api.importArtifact(slug, body); load(); return r; };
  const addLink = async () => { const label = prompt('Label'); const url = label && prompt('URL'); if (!url) return; await api.updateWork(slug, { links: [...(w.links || []), { label, url }] }); load(); };
  const decide = async (body) => { await api.decide(slug, body); load(); };
  return { slug, w, plan, prs, refreshing, err, load, saveStack, saveMeta, saveNotes, addNote, importArtifact, addLink, decide };
}
