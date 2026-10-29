import React, { useEffect, useRef } from 'react';
import { NavDepth } from './use-nav.ts';
import type { LayoutProps } from './NavLevels.tsx';

// Expand: one list, each opened item's level nested under its row, like comment replies
export default function Expand({ levels, nav, base }: LayoutProps) {
  const root = useRef<HTMLDivElement>(null);
  const at = nav.path.slice(base).join('/');
  // the deepest opened row stays in view, from a link too
  useEffect(() => {
    const rows = root.current?.querySelectorAll('.dp-nrow.dp-on');
    rows?.[rows.length - 1]?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const child = (i: number) => (key: string): React.ReactNode => {
    const next = levels[i + 1];
    if (!next || nav.path[base + i] !== key) return null;
    return (
      <div className="dp-nkid">
        <NavDepth.Provider value={base + i + 1}>{next.render(child(i + 1))}</NavDepth.Provider>
      </div>
    );
  };
  return (
    <NavDepth.Provider value={base}>
      <div className="dp-nlevel" ref={root}>{levels[0].render(child(0))}</div>
    </NavDepth.Provider>
  );
}
