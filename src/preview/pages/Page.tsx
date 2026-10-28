import React from 'react';
import Icon from '../Icon.tsx';
import type { IconName } from '../Icon.tsx';
import './pages.css';

// the scrolling main area of a page outside a work; wide pages drop the reading width
export function Page({ wide = false, children }: { wide?: boolean; children: React.ReactNode }) {
  return <div className="dp-page" role="main"><div className={`dp-page-in${wide ? ' dp-wide' : ''}`}>{children}</div></div>;
}

export function PageHead({ icon, title, sub, actions, meta }: { icon?: IconName; title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; meta?: React.ReactNode }) {
  return (
    <header className="dp-phead">
      <div className="dp-grow">
        {meta && <div className="dp-pmeta">{meta}</div>}
        <h1 className="dp-h1 dp-row dp-g8">{icon && <span className="dp-phead-ic"><Icon name={icon} size={16} /></span>}{title}</h1>
        {sub && <p className="dp-psub">{sub}</p>}
      </div>
      {actions && <div className="dp-row dp-g6 dp-phead-act">{actions}</div>}
    </header>
  );
}

export function Section({ id, title, count, meta, action, children }: { id?: string; title: React.ReactNode; count?: number; meta?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="dp-psec" id={id}>
      <h2 className="dp-h2">{title}{count !== undefined && <span className="dp-count">{count}</span>}{meta && <span className="dp-meta">{meta}</span>}{action && <span className={meta ? '' : 'dp-psec-act'}>{action}</span>}</h2>
      {children}
    </section>
  );
}

export type Tile = { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'acc'; href?: string };
export function Tiles({ items }: { items: Tile[] }) {
  return (
    <div className="dp-tiles">
      {items.map((t) => {
        const body = <><span className="dp-tile-l">{t.label}</span><span className={`dp-tile-v${t.tone ? ` dp-${t.tone}` : ''}`}>{t.value}</span>{t.hint && <span className="dp-tile-h">{t.hint}</span>}</>;
        return t.href ? <a key={t.label} className="dp-tile dp-tile-a" href={t.href}>{body}</a> : <div key={t.label} className="dp-tile">{body}</div>;
      })}
    </div>
  );
}

export const Empty = ({ icon = 'sparkles', children }: { icon?: IconName; children: React.ReactNode }) => <div className="dp-pempty"><Icon name={icon} size={16} /><span>{children}</span></div>;
export const Loading = ({ what = 'Loading…' }: { what?: string }) => <div className="dp-pempty dp-ploading"><span className="dp-ag-dot dp-ag-running" /><span>{what}</span></div>;
export const ErrorNote = ({ children }: { children: React.ReactNode }) => <div className="dp-perr"><Icon name="alert-triangle" size={14} /><span>{children}</span></div>;
