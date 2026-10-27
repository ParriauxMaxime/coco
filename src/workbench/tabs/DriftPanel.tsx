import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import type { DriftAction, DriftItem, DriftResponse } from '../../types.ts';
import { useAction, pendingClass } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { useWorkbench } from '../workbench-store.ts';
import '../../components/parts.css';

const POLL_MS = 60000;
const label = (key: DriftItem['key']) => (key == null ? '' : /^b:/.test(String(key)) ? String(key).slice(2) : `#${key}`);

// what drifted on the work's PRs and the next steps that follow; every button is a click of yours, nothing runs by itself
export default function DriftPanel({ slug }: { slug: string }) {
  const [data, setData] = useState<DriftResponse | null>(null);
  const { pending, busy, run } = useAction();
  useEffect(() => {
    const load = () => api.drift(slug).then(setData, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [slug]);

  const go = (it: DriftItem, a: DriftAction) => {
    if (a.type === 'copy') return void navigator.clipboard?.writeText(a.command).then(() => toast.success(`Copied: ${a.command}`));
    if (a.type === 'tab') return useWorkbench.getState().open(a.tab);
    return void run(it.id, async () => {
      const r = await api.dispatch(slug, { entry: a.entry, key: it.key, ...(a.persona ? { persona: a.persona } : {}) });
      toast.success(`Started ${r.title}`);
      api.drift(slug, true).then(setData, () => {});
    });
  };
  const rows = [...(data?.drift || []), ...(data?.next || [])];
  if (!rows.length) return null;
  const line = (it: DriftItem) => (
    <div key={it.id} className="dp-kl">
      {it.key != null && <span className="dp-chip">{label(it.key)}</span>}
      <span className="dp-grow">{it.text}</span>
      {it.action && <button type="button" className={`dp-btn dp-sm${pendingClass(pending === it.id)}`} disabled={busy} onClick={() => go(it, it.action as DriftAction)}>{it.action.label}</button>}
    </div>
  );
  return (
    <div className="dp-block">
      <div className="dp-h2">Drift<span className="dp-meta">{data?.drift.length ? `${data.drift.length} to fix` : 'next steps'}</span></div>
      {data?.drift.map(line)}
      {data && data.next.length > 0 && <div className="dp-xs dp-t3" style={{ margin: '6px 0 2px' }}>Suggested next steps</div>}
      {data?.next.map(line)}
    </div>
  );
}
