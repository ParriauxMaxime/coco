import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Ring, fillTone } from './Ring.tsx';
import type { ProviderUsage, UsageWindow } from '../types.ts';

const POLL_MS = 60000;

const resets = (ts?: string | null) => {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return '';
  const soon = t - Date.now() < 24 * 3600 * 1000;
  return ` · resets ${new Date(t).toLocaleString([], soon ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
};

function Window({ w }: { w: UsageWindow }) {
  const pct = Math.round(w.usedPct ?? 0);
  const tone = w.tone === 'danger' ? 'dp-bad' : w.tone === 'warning' ? 'dp-warn' : fillTone(pct);
  return <span className="dp-quota-w"><Ring pct={pct} size={12} tone={tone} title={`${w.label} ${pct}% used${resets(w.resetsAt)}`} />{w.shortLabel ?? w.label} {pct}%</span>;
}

// the main provider's account quota, its summary windows (session, week) as rings
export default function Quota() {
  const [usage, setUsage] = useState<ProviderUsage | null>(null);
  useEffect(() => {
    const load = () => api.usage().then(setUsage, () => setUsage(null));
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);
  const windows = usage?.status === 'available' ? usage.windows.filter((w) => w.summary && w.usedPct != null) : [];
  if (!usage || !windows.length) return null;
  return (
    <span className="dp-sbi dp-quota" title={[usage.displayName, usage.planLabel].filter(Boolean).join(' · ')}>
      {usage.displayName.replace(/\s*\(.*\)$/, '')}
      {windows.map((w) => <Window key={w.id} w={w} />)}
    </span>
  );
}
