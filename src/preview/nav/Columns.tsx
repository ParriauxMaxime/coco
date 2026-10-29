import React from 'react';
import Icon from '../Icon.tsx';
import { columnsShown } from './nav.ts';
import { NavDepth } from './use-nav.ts';
import type { LayoutProps } from './NavLevels.tsx';

// Columns: each opened level in a column right of the one it opened from, like Finder; the deepest ones that fit show,
// the levels slid out to the left stay one click away in the crumbs
export default function Columns({ levels, nav, width, base }: LayoutProps) {
  const shown = columnsShown(levels.length, width);
  const from = levels.length - shown;
  return (
    <>
      {from > 0 && (
        <nav className="dp-ncrumbs" aria-label="Levels">
          <button type="button" className="dp-ibtn dp-ncrumbs-up" title={`Back to ${levels[from - 1].label}`} aria-label="Up one level" onClick={() => nav.up(base + levels.length - 2)}><Icon name="chevron-left" size={14} /></button>
          {levels.slice(0, from).map((l, i) => (
            <React.Fragment key={l.key}>
              <button type="button" className="dp-ncrumb dp-ell" title={l.label} onClick={() => nav.up(base + i)}>{l.label}</button>
              <span className="dp-ncrumb-sep">/</span>
            </React.Fragment>
          ))}
          <span className="dp-ncrumb-at dp-t3 dp-ell">{levels.length - from} more</span>
        </nav>
      )}
      <div className={`dp-ncols${shown > 1 ? ' dp-ncols-many' : ''}`}>
        {levels.slice(from).map((l, j) => {
          const i = from + j;
          return (
            <NavDepth.Provider key={l.key} value={base + i}>
              <section className={`dp-ncol${i === levels.length - 1 ? ' dp-ncol-last' : ''}`} aria-label={l.label}>
                {i > 0 && <div className="dp-ncol-h"><span className="dp-ell" title={l.label}>{l.label}</span><button type="button" className="dp-ibtn" title="Close this column" aria-label="Close" onClick={() => nav.up(base + i - 1)}><Icon name="x" size={14} /></button></div>}
                <div className="dp-nlevel">{l.render(() => null)}</div>
              </section>
            </NavDepth.Provider>
          );
        })}
      </div>
    </>
  );
}
