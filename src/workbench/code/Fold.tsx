import React, { useState } from 'react';
import type { ReactNode } from 'react';
import Icon from '../../preview/Icon.tsx';
import './code.css';

export default function Fold({ title, badge, open: initial = false, children }: { title: ReactNode; badge?: ReactNode; open?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`rv-fold${open ? ' dp-open' : ''}`}>
      <button type="button" className="dp-rv-fold-h" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`dp-caret${open ? ' dp-open' : ''}`}><Icon name="chevron-right" size={12} /></span>
        <span className="dp-ell">{title}</span>
        {badge && <span className="dp-chip">{badge}</span>}
      </button>
      {open && <div className="rv-fold-b">{children}</div>}
    </div>
  );
}
