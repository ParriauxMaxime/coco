import React from 'react';
import Icon from '../Icon.tsx';
import { NavDepth } from './use-nav.ts';
import type { LayoutProps } from './NavLevels.tsx';

// Drill: the deepest opened level takes the whole surface; a crumb per level above it leads back up
export default function Drill({ levels, nav, base }: LayoutProps) {
  const last = levels.length - 1;
  const level = levels[last];
  return (
    <>
      {last > 0 && (
        <nav className="dp-ncrumbs" aria-label="Levels">
          <button type="button" className="dp-ibtn dp-ncrumbs-up" title={`Back to ${levels[last - 1].label}`} aria-label="Up one level" onClick={() => nav.up(base + last - 1)}><Icon name="chevron-left" size={14} /></button>
          {levels.slice(0, last).map((l, i) => (
            <React.Fragment key={l.key}>
              <button type="button" className="dp-ncrumb dp-ell" title={l.label} onClick={() => nav.up(base + i)}>{l.label}</button>
              <span className="dp-ncrumb-sep">/</span>
            </React.Fragment>
          ))}
          <b className="dp-ncrumb-at dp-ell" title={level.label}>{level.label}</b>
        </nav>
      )}
      <NavDepth.Provider value={base + last}>
        <div className="dp-nlevel" key={level.key}>{level.render(() => null)}</div>
      </NavDepth.Provider>
    </>
  );
}
