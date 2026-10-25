import React from 'react';
import { create } from 'zustand';

const TTL = { error: 8000, success: 5000 };
let seq = 0;
export const useToasts = create(() => ({ list: [] }));
const drop = (id) => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
const push = (kind, text, extra = {}) => {
  const id = ++seq;
  useToasts.setState((s) => ({ list: [...s.list.slice(-4), { id, kind, text, ...extra }] }));
  setTimeout(() => drop(id), TTL[kind]);
  return id;
};

// toast.error(text) · toast.success(text, { undo }): undo runs once, then the toast goes
export const toast = {
  error: (text) => push('error', String(text || 'Something went wrong')),
  success: (text, { undo } = {}) => push('success', text, { undo }),
};

export default function Toasts() {
  const list = useToasts((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => drop(t.id)}>
          <span className="toast-text">{t.text}</span>
          {t.undo && <button type="button" className="toast-undo" onClick={(e) => { e.stopPropagation(); drop(t.id); t.undo(); }}>Undo</button>}
        </div>
      ))}
    </div>
  );
}
