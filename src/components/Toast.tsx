import React from 'react';
import { create } from 'zustand';
import Icon from '../preview/Icon.tsx';
import { connected } from '../live.ts';
import './parts.css';

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
// while the server is away (a restart) errors stay quiet: the status bar says it reconnects; always: said anyway (words that did not leave)
export const toast = {
  error: (text?: unknown, { always = false }: { always?: boolean } = {}) => (always || connected() ? push('error', String(text || 'Something went wrong')) : 0),
  success: (text: string, { undo }: { undo?: () => unknown } = {}) => push('success', text, { undo }),
};

export default function Toasts() {
  const list = useToasts((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="dp dp-float">
      <div className="dp-tsts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`dp-tst dp-tst-${t.kind}`} onClick={() => drop(t.id)}>
            <Icon name={t.kind === 'error' ? 'alert-triangle' : 'check'} size={14} />
            <span className="dp-tst-t">{t.text}</span>
            {t.undo && <button type="button" className="dp-btn dp-sm dp-ghost dp-tst-undo" onClick={(e) => { e.stopPropagation(); drop(t.id); t.undo?.(); }}>Undo</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
