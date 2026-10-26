import type { CSSProperties } from 'react';
import type { WorkPr } from '../workbench/types.ts';
import { prState } from './data.ts';

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

const STATE_LABELS: Record<ReturnType<typeof prState>, string> = { planned: 'Planned', draft: 'Draft', review: 'In review', approved: 'Approved', changes: 'Changes requested', merged: 'Merged', closed: 'Closed' };
export const stateLabel = (pr: WorkPr) => STATE_LABELS[prState(pr)];

export const diffText = (pr: WorkPr) => (pr.additions === undefined ? '' : `${pr.changedFiles ?? '?'} files`);
export const num = (n: number) => n.toLocaleString('en-US');
