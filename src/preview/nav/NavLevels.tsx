import React, { useContext, useLayoutEffect, useState } from 'react';
import Icon from '../Icon.tsx';
import { usePrefs } from '../prefs.ts';
import { fitMode } from './nav.ts';
import type { NavMode } from './nav.ts';
import { NavDepth, useNav } from './use-nav.ts';
import type { Nav } from './use-nav.ts';
import Drill from './Drill.tsx';
import './nav.css';

// one level of a surface: its crumb and its content. child(key) is the level opened under that item, which Expand nests
// under the item's row; the other modes pass a child that renders nothing
export type Level = { key: string; label: string; render: (child: (key: string) => React.ReactNode) => React.ReactNode };
// base: where in the path the first level's items open, past the levels of the surface this one sits in
export type LayoutProps = { levels: Level[]; nav: Nav; width: number; base: number };
type Layout = (p: LayoutProps) => React.ReactNode;

const LAYOUTS: Partial<Record<NavMode, Layout>> = { drill: Drill };

export const hasLayout = (mode: NavMode) => mode === 'classic' || Boolean(LAYOUTS[mode]);

// the mode picked on Settings > Beta, Classic while that mode has no layout yet
export function useNavMode(): NavMode {
  const mode = usePrefs((s) => s.nav);
  return hasLayout(mode) ? mode : 'classic';
}

const useWidth = (): [number, (el: HTMLDivElement | null) => void] => {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return undefined;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, setEl];
};

// a surface in the picked mode: Classic shows the surface as it always was, the others lay its levels out, as Drill when
// the mode does not fit the surface's width. nav: where the levels open, the work tab's hash path unless the surface routes its own
export default function NavLevels({ classic, levels, nav: own, className = '' }: { classic: React.ReactNode; levels: Level[]; nav?: Nav; className?: string }) {
  const mode = useNavMode();
  const tab = useNav();
  const base = useContext(NavDepth);
  const [width, ref] = useWidth();
  if (mode === 'classic') return <>{classic}</>;
  const fit = fitMode(mode, width);
  const layout = LAYOUTS[fit] ?? LAYOUTS.drill;
  return <div ref={ref} className={`dp-nav dp-nav-${fit} ${className}`}>{width > 0 && layout?.({ levels, nav: own ?? tab, width, base })}</div>;
}

// an item's summary row: opens its level, or closes it when open; meta sits right, before the chevron
export function NavRow({ on, onOpen, icon, title, sub, meta, className = '' }: { on: boolean; onOpen: () => void; icon?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; meta?: React.ReactNode; className?: string }) {
  return (
    <div role="button" tabIndex={0} aria-expanded={on} className={`dp-nrow${on ? ' dp-on' : ''} ${className}`} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      {icon}
      <span className="dp-nrow-b">
        <span className="dp-nrow-t dp-ell">{title}</span>
        {sub && <span className="dp-nrow-s dp-ell">{sub}</span>}
      </span>
      {meta && <span className="dp-nrow-m">{meta}</span>}
      <Icon name="chevron-right" size={14} className="dp-nrow-c" />
    </div>
  );
}

// a level's own heading in Drill and Columns: what the rows below are
export function NavHead({ children }: { children: React.ReactNode }) {
  return <div className="dp-nhead">{children}</div>;
}
