import React from 'react';
import { create } from 'zustand';

type ToastKind = 'error' | 'success';
type ToastItem = { id: number; kind: ToastKind; text: string; undo?: () => unknown };

const TTL: Record<ToastKind, number> = { error: 8000, success: 5000 };
let seq = 0;
export const useToasts = create<{ list: ToastItem[] }>(() => ({ list: [] }));
const drop = (id: number) => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
const push = (kind: ToastKind, text: string, extra: { undo?: () => unknown } = {}) => {
  const id = ++seq;
  useToasts.setState((s) => ({ list: [...s.list.slice(-4), { id, kind, text, ...extra }] }));
  setTimeout(() => drop(id), TTL[kind]);
  return id;
};

// toast.error(text) · toast.success(text, { undo }): undo runs once, then the toast goes
export const toast = {
  error: (text?: unknown) => push('error', String(text || 'Something went wrong')),
  success: (text: string, { undo }: { undo?: () => unknown } = {}) => push('success', text, { undo }),
};

export default function Toasts() {
  const list = useToasts((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => drop(t.id)}>
          <span className="toast-text">{t.text}</span>
          {t.undo && <button type="button" className="toast-undo" onClick={(e) => { e.stopPropagation(); drop(t.id); t.undo?.(); }}>Undo</button>}
        </div>
      ))}
    </div>
  );
}
