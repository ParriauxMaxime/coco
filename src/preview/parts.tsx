import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api.ts';
import type { Persona } from '../types.ts';
import type { WorkPr } from '../workbench/types.ts';
import { prState } from './data.ts';

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

const STATE_LABELS: Record<ReturnType<typeof prState>, string> = { planned: 'Planned', draft: 'Draft', review: 'In review', approved: 'Approved', changes: 'Changes requested', merged: 'Merged', landed: 'Landed', closed: 'Closed' };
export const stateLabel = (pr: WorkPr) => STATE_LABELS[prState(pr)];

export const diffText = (pr: WorkPr) => (pr.additions === undefined || !pr.number ? '' : `${pr.changedFiles ?? '?'} files`);
export const num = (n: number) => n.toLocaleString('en-US');
