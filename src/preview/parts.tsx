import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api.ts';
import type { Persona } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';
import { prState } from './data.ts';
import { usePrefs } from './prefs.ts';

let personas: Promise<Persona[]> | null = null;
export const loadPersonas = () => (personas ??= api.personas().catch(() => []));

// "Camille Ingouf — `CamilleINGOUF`" → "Camille Ingouf"; the login until the list loads or without a persona file
export function usePersonaName(login: string) {
  const [name, setName] = useState(login);
  useEffect(() => {
    let live = true;
    loadPersonas().then((list) => {
      const title = list.find((p) => p.login === login)?.title;
      if (live) setName(title?.split(/ [—-] /)[0] || login);
    });
    return () => { live = false; };
  }, [login]);
  return name;
}

export function PersonaName({ login }: { login: string }) {
  const name = usePersonaName(login);
  return <span title={name === login ? `@${login}` : `${name} (@${login})`}>{login}</span>;
}

type Hue = CSSProperties & { [k: `--${string}`]: number };

const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

export function Avatar({ login, size }: { login: string; size?: 'sm' | 'lg' }) {
  const style: Hue = { '--dp-h': hueOf(login) };
  return (
    <span className={`dp-av${size ? ` dp-${size}` : ''}`} style={style} title={login}>
      {login.charAt(0).toUpperCase()}
      <img src={`/api/avatar/${login}`} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />
    </span>
  );
}

// coco-mark.svg drawn inline: its card and eye follow the theme, its corners the Avatar pref
export function CocoAvatar() {
  const shape = usePrefs((s) => s.avatar);
  return (
    <svg className="dp-cocoav" viewBox="100 100 824 824" role="img" aria-label="coco">
      <rect x="100" y="100" width="824" height="824" rx={shape === 'circle' ? 412 : 185} className="dp-cocoav-card" />
      <g transform="translate(512 512) scale(0.84) translate(-496 -512)">
        <path d="M630.7 320.5 A250 250 0 1 0 686.5 637" fill="none" stroke="#7b7bf5" strokeWidth="140" strokeLinecap="round" />
        <path fill="#f2b84b" d="M640 372 C770 360 852 455 842 600 C838 652 816 684 790 692 C794 622 762 574 684 566 C672 500 660 430 640 372 Z" />
        <circle cx="560" cy="440" r="54" className="dp-cocoav-eye" />
      </g>
    </svg>
  );
}

const STATE_LABELS:Record<ReturnType<typeof prState>, string> = { planned: 'Planned', draft: 'Draft', review: 'In review', approved: 'Approved', changes: 'Changes requested', merged: 'Merged', landed: 'Landed', closed: 'Closed' };
export const stateLabel = (pr: WorkPr) => STATE_LABELS[prState(pr)];

export const diffText = (pr: WorkPr) => (pr.additions === undefined || !pr.number ? '' : `${pr.changedFiles ?? '?'} files`);
export const num = (n: number) => n.toLocaleString('en-US');
