import React from 'react';
import Icon from './Icon.tsx';
import { useOverviewFolds } from './prefs.ts';

// a part of Overview folded to one line saying what is in it; a click unfolds it, on every work alike
export default function OverviewFold({ id, title, line, meta, children, className = 'dp-block' }: { id: string; title: string; line: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const open = useOverviewFolds((s) => s.open.includes(id));
  const toggle = useOverviewFolds((s) => s.toggle);
  return (
    <div className={`${className} dp-ovf${open ? ' dp-open' : ''}`}>
      <button type="button" className="dp-ovf-h" aria-expanded={open} title={open ? `Fold ${title}` : `Show ${title}`} onClick={() => toggle(id)}>
        <Icon name="chevron-right" size={14} className="dp-ovf-c" />
        <span className="dp-ovf-t">{title}</span>
        {!open && <span className="dp-ovf-line dp-ell">{line}</span>}
        {meta && <span className="dp-ovf-meta">{meta}</span>}
      </button>
      {open && <div className="dp-ovf-b">{children}</div>}
    </div>
  );
}
