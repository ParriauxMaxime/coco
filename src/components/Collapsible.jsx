import React, { useState } from 'react';

export default function Collapsible({ title, badge, open: initial = false, children, level = 'dev' }) {
  const [open, setOpen] = useState(initial);
  return (
    <div className={`fold ${open ? 'open' : ''} fold-${level}`}>
      <div className="fold-head" onClick={() => setOpen(!open)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="fold-title">{title}</span>
        {badge && <span className="chip c-grey">{badge}</span>}
        {level === 'dev' && !open && <span className="status" style={{ marginLeft: 'auto' }}>developer details</span>}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}
