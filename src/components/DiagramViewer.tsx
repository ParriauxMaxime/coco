import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../preview/Icon.tsx';
import './parts.css';

const MIN = 0.1;
const MAX = 8;

type Point = { x: number; y: number };
type View = { k: number; x: number; y: number };

export default function DiagramViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<(View & { dist: number; cx: number; cy: number }) | null>(null);
  const lastTap = useRef(0);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [rot, setRot] = useState(false);
  const box = rot ? { w: size.h, h: size.w } : size;

  const fit = useCallback(() => {
    if (!stage.current || !box.w) return;
    const { width, height } = stage.current.getBoundingClientRect();
    const pad = width < 600 ? 16 : 48;
    const k = Math.min((width - pad) / box.w, (height - pad) / box.h, MAX);
    setView({ k, x: (width - box.w * k) / 2, y: (height - box.h * k) / 2 });
  }, [box.w, box.h]);
  // on a phone, a wide diagram fitted whole is unreadable: start at a readable zoom on its left edge
  const start = useCallback(() => {
    if (!stage.current || !box.w) return;
    const { width, height } = stage.current.getBoundingClientRect();
    const fitK = Math.min((width - 16) / box.w, (height - 16) / box.h);
    if (width >= 600 || fitK >= 0.55) return fit();
    const k = Math.min(0.9, (height - 16) / box.h);
    setView({ k, x: 8, y: Math.max(8, (height - box.h * k) / 2) });
  }, [box.w, box.h, fit]);

  useEffect(() => {
    const el = inner.current?.querySelector('svg');
    if (!el) return;
    const vb = el.viewBox?.baseVal;
    const w = vb?.width || el.getBBox().width;
    const h = vb?.height || el.getBBox().height;
    el.removeAttribute('style');
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    setSize({ w, h });
  }, [svg]);
  useEffect(start, [start]);
  useEffect(() => { const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = prev; }; }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '0') fit();
      if (e.key === '+' || e.key === '=') zoomBy(1.25);
      if (e.key === '-') zoomBy(0.8);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const zoomAt = (factor: number, cx: number, cy: number) => setView((v) => {
    const k = Math.min(MAX, Math.max(MIN, v.k * factor));
    const ratio = k / v.k;
    return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
  });
  const zoomBy = (factor: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (r) zoomAt(factor, r.width / 2, r.height / 2);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const r = stage.current?.getBoundingClientRect();
    if (r) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
  };
  useEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  const local = (e: React.PointerEvent): Point => { const r = stage.current?.getBoundingClientRect(); return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }; };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: view.k, x: view.x, y: view.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag.current = null;
      return;
    }
    const now = Date.now();
    if (e.pointerType === 'touch' && now - lastTap.current < 300) { const p = local(e); zoomAt(2, p.x, p.y); lastTap.current = 0; return; }
    lastTap.current = now;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const p = pinch.current;
    if (p && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const k = Math.min(MAX, Math.max(MIN, p.k * Math.hypot(a.x - b.x, a.y - b.y) / p.dist));
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const ratio = k / p.k;
      setView({ k, x: cx - (p.cx - p.x) * ratio, y: cy - (p.cy - p.y) * ratio });
      return;
    }
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; drag.current = null; };

  return createPortal(
    <div className="dp dp-float">
      <div className="dp-dv" role="dialog" aria-modal="true">
        <div className="dp-dv-bar">
          <button type="button" className="dp-btn dp-sm" onClick={() => zoomBy(0.8)} title="Zoom out (-)">−</button>
          <span className="dp-dv-k">{Math.round(view.k * 100)}%</span>
          <button type="button" className="dp-btn dp-sm" onClick={() => zoomBy(1.25)} title="Zoom in (+)">+</button>
          <button type="button" className="dp-btn dp-sm" onClick={fit} title="Fit (0)">Fit</button>
          <button type="button" className="dp-btn dp-sm" onClick={() => setRot((r) => !r)} title="Rotate 90°" aria-label="Rotate"><Icon name="refresh" size={12} /></button>
          <button type="button" className="dp-btn dp-sm dp-dv-desk" onClick={() => setView((v) => ({ ...v, k: 1 }))}>100%</button>
          <span className="dp-dv-hint dp-dv-desk">drag to pan · wheel to zoom · Esc to close</span>
          <span className="dp-dv-hint dp-dv-touch">pinch · drag</span>
          <span className="dp-sp" />
          <button type="button" className="dp-ibtn" onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <div ref={stage} className="dp-dv-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={(e) => !(e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch') && fit()}>
          <div ref={inner} style={{ transform: `translate(${view.x + (rot ? size.h * view.k : 0)}px, ${view.y}px) scale(${view.k})${rot ? ' rotate(90deg)' : ''}`, transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
