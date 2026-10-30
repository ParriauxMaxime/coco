import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { loadPersonas } from '../preview/parts.tsx';
import type { PrKey } from '../workbench/types.ts';

type Option = { login: string; name: string; hits: number };
const MEDALS = ['🥇', '🥈', '🥉'];

// reviewers owning the most files of the PR first (the whole stack without a PR), then the others by login
function useRanked(slug: string, pr: PrKey | null) {
  const [options, setOptions] = useState<Option[]>([]);
  useEffect(() => {
    let live = true;
    const numeric = pr != null && /^\d+$/.test(String(pr)) ? pr : null;
    Promise.all([loadPersonas(), api.suggestPersonas(slug, numeric).then((s) => s.personas, () => [])]).then(([all, suggested]) => {
      const hits = new Map(suggested.map((s) => [s.login, s.hits]));
      const ranked = all
        .filter((p) => p.kind === 'reviewer' || hits.has(p.login))
        .map((p) => ({ login: p.login, name: p.title.split(/ [—-] /)[0] || p.login, hits: hits.get(p.login) ?? 0 }))
        .sort((a, b) => b.hits - a.hits || a.login.localeCompare(b.login));
      if (live) setOptions(ranked);
    });
    return () => { live = false; };
  }, [slug, pr]);
  return options;
}

export default function PersonaPicker({ slug, pr, value, onChange, autoFocus }: { slug: string; pr: PrKey | null; value: string; onChange: (login: string) => void; autoFocus?: boolean }) {
  const options = useRanked(slug, pr);
  const [open, setOpen] = useState(Boolean(autoFocus));
  const [hi, setHi] = useState(0);
  const q = value.trim().toLowerCase();
  const exact = options.some((o) => o.login.toLowerCase() === q);
  const shown = q && !exact ? options.filter((o) => `${o.login} ${o.name}`.toLowerCase().includes(q)) : options;
  const pick = (login: string) => { onChange(login); setOpen(false); };
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setHi((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % Math.max(shown.length, 1));
    } else if (e.key === 'Enter' && open && shown[hi] && !exact) {
      e.preventDefault();
      pick(shown[hi].login);
    }
  };
  return (
    <div className="dp-pp" role="combobox" aria-expanded={open} aria-haspopup="listbox">
      <input className="dp-inp" autoFocus={autoFocus} value={value} placeholder="Persona login" aria-label="Persona login" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={key} onChange={(e) => { onChange(e.target.value); setOpen(true); setHi(0); }} />
      {open && shown.length > 0 && (
        <div className="dp-pp-list" role="listbox">
          {shown.map((o, i) => {
            const rank = o.hits ? options.indexOf(o) : -1;
            return (
              <div key={o.login} ref={i === hi ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined} role="option" aria-selected={i === hi} className={`dp-mi${i === hi ? ' dp-hl' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.login); }}>
                <span className="dp-pp-medal">{MEDALS[rank] ?? ''}</span>
                <span className="dp-ell">{o.name}</span>
                <span className="dp-t3 dp-ell">@{o.login}</span>
                {o.hits > 0 && <span className="dp-r dp-xs dp-t3">{o.hits} {o.hits === 1 ? 'file' : 'files'}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
