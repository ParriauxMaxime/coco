import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { subscribe, topic } from '../../live.ts';
import type { DriftAction, DriftHead, DriftItem, DriftResponse } from '../../types.ts';
import Icon from '../../preview/Icon.tsx';
import type { IconName } from '../../preview/Icon.tsx';
import { useAction, pendingClass } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { useWorkbench } from '../workbench-store.ts';
import '../../components/parts.css';

const POLL_MS = 60000;
const label = (key: DriftItem['key']) => (key == null ? '' : /^b:/.test(String(key)) ? String(key).slice(2) : `#${key}`);
const tail = (s: string) => s.trim().split('\n').slice(-20).join('\n');

function useDrift(slug: string) {
  const [data, setData] = useState<DriftResponse | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  const { pending, busy, run } = useAction();
  useEffect(() => {
    const load = () => api.drift(slug).then(setData, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    let soon: ReturnType<typeof setTimeout>;
    const off = subscribe(topic('work', slug), { message: () => { clearTimeout(soon); soon = setTimeout(load, 50); } });
    return () => { clearInterval(t); clearTimeout(soon); off(); };
  }, [slug]);

  const go = (it: DriftItem, a: DriftAction) => {
    if (a.type === 'copy') return void navigator.clipboard?.writeText(a.command).then(() => toast.success(`Copied: ${a.command}`));
    if (a.type === 'tab') return useWorkbench.getState().open(a.tab);
    if (a.type === 'run') {
      return void run(it.id, async () => {
        const r = await api.driftRun(slug, it.id, a.command);
        setFailed((f) => ({ ...f, [it.id]: r.ok ? '' : tail(r.stderr || r.stdout) }));
        if (r.ok) toast.success(`${a.label} done`);
        api.drift(slug, true).then(setData, () => {});
      });
    }
    return void run(it.id, async () => {
      const r = await api.dispatch(slug, { entry: a.entry, key: it.key, ...(a.persona ? { persona: a.persona } : {}) });
      toast.success(`Started ${r.title}`);
      api.drift(slug, true).then(setData, () => {});
    });
  };
  return { data, failed, pending, busy, go };
}

const plural = (n = 0) => `${n} commit${n === 1 ? '' : 's'}`;
const HEAD_BADGE: Record<DriftHead['state'], { tone: string; icon: IconName; text: (h: DriftHead) => string }> = {
  pushed: { tone: 'dp-ok', icon: 'check', text: () => 'Pushed: GitHub has the local head' },
  ahead: { tone: 'dp-warn', icon: 'upload', text: (h) => `${plural(h.count)} not pushed` },
  behind: { tone: 'dp-info', icon: 'download', text: (h) => `GitHub is ${plural(h.count)} ahead of the local branch` },
  diverged: { tone: 'dp-bad', icon: 'alert-triangle', text: () => 'Local branch and GitHub diverged: rebase or reset it before pushing' },
  remote: { tone: '', icon: 'git-branch', text: () => 'On GitHub only: no local branch' },
};

// the PR's local head against GitHub, with the push one click away when local commits are ahead
export function PushBadge({ slug, prKey }: { slug: string; prKey: string }) {
  const { data, failed, pending, busy, go } = useDrift(slug);
  const head = data?.heads?.find((h) => String(h.key) === prKey);
  if (!head) return null;
  const badge = HEAD_BADGE[head.state];
  const item = data?.drift.find((i) => i.id === `${prKey}:unpushed`);
  return (
    <div className={`dp-push ${badge.tone}`}>
      <div className="dp-push-row">
        <Icon name={badge.icon} size={16} />
        <span className="dp-grow">{badge.text(head)}</span>
        {item?.also && <button type="button" className="dp-btn dp-sm" disabled={busy} title={item.also.type === 'copy' ? item.also.command : undefined} onClick={() => go(item, item.also as DriftAction)}>{item.also.label}</button>}
        {item?.action?.type === 'run' && <button type="button" className={`dp-btn dp-sm dp-primary${pendingClass(pending === item.id)}`} disabled={busy} title={item.action.command} onClick={() => go(item, item.action as DriftAction)}>{item.action.label}</button>}
      </div>
      {item && failed[item.id] && <pre className="dp-cmdline">{failed[item.id]}</pre>}
    </div>
  );
}

// what drifted on the work's PRs and the next steps that follow; every button is a click of yours, nothing runs by itself
export default function DriftPanel({ slug }: { slug: string }) {
  const { data, failed, pending, busy, go } = useDrift(slug);
  const rows = [...(data?.drift || []), ...(data?.next || [])];
  if (!rows.length) return null;
  const line = (it: DriftItem) => (
    <div key={it.id}>
      <div className="dp-kl">
        {it.key != null && <span className="dp-chip">{label(it.key)}</span>}
        <span className="dp-grow">{it.text}</span>
        {it.also && <button type="button" className="dp-btn dp-sm" disabled={busy} title={it.also.type === 'copy' ? it.also.command : undefined} onClick={() => go(it, it.also as DriftAction)}>{it.also.label}</button>}
        {it.action && <button type="button" className={`dp-btn dp-sm${it.action.type === 'run' ? ' dp-primary' : ''}${pendingClass(pending === it.id)}`} disabled={busy} title={it.action.type === 'run' ? it.action.command : undefined} onClick={() => go(it, it.action as DriftAction)}>{it.action.label}</button>}
      </div>
      {failed[it.id] && <pre className="dp-cmdline">{failed[it.id]}</pre>}
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
