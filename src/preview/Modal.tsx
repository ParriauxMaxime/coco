import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';

export default function Modal({ title, wide, busy, onClose, foot, children }: { title: ReactNode; wide?: boolean; busy?: boolean; onClose: () => void; foot: ReactNode; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [busy, onClose]);
  return (
    <div className="dp-overlay dp-on" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`dp-dialog dp-modal${wide ? ' dp-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="dp-dh" id={id}>{title}</div>
        <div className="dp-db">{children}</div>
        <div className="dp-df">{foot}</div>
      </div>
    </div>
  );
}
