import React from 'react';

type Tone = 'dp-warn' | 'dp-bad' | '';
const R = 5;
const CIRCUMFERENCE = 2 * Math.PI * R;

export const fillTone = (pct: number): Tone => (pct >= 90 ? 'dp-bad' : pct >= 70 ? 'dp-warn' : '');
const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// a ring filling clockwise from the top
export function Ring({ pct, size = 14, tone = fillTone(pct), title }: { pct: number; size?: number; tone?: Tone; title?: string }) {
  const fill = (Math.min(100, Math.max(0, pct)) / 100) * CIRCUMFERENCE;
  return (
    <svg className={`dp-ring${tone ? ` ${tone}` : ''}`} width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={title}>
      {title && <title>{title}</title>}
      <circle className="dp-ring-track" cx="7" cy="7" r={R} />
      <circle cx="7" cy="7" r={R} strokeDasharray={`${fill} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

// how full an agent's context window was at its last turn, as Paseo reported it
export function ContextRing({ used, max, size, label = false }: { used?: number | null; max?: number | null; size?: number; label?: boolean }) {
  if (!used || !max) return null;
  const pct = Math.round((used / max) * 100);
  const ring = <Ring pct={pct} size={size} title={`Context ${pct}% · ${tokens(used)} of ${tokens(max)} tokens`} />;
  return label ? <span className="dp-ring-label">{ring}{pct}%</span> : ring;
}
