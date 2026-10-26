import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWorkbench, layoutRects } from './workbench-store.ts';
import { WorkContext, useWorkData } from './use-work.ts';
import type { LoadedWork } from './use-work.ts';
import { startHashSync } from './hash.ts';
import { tabDef as baseTabDef } from './tabs/index.ts';
import type { TabDef } from './tabs/index.ts';
import QuickOpen, { useQuickOpenShortcut } from './code/QuickOpen.tsx';
import { codeApi } from './code/code-api.ts';
import { prOfTab, codeTabId } from './code/ids.ts';
import { openCodeAt } from './tabs/Code.tsx';
import { CodeRefRoot } from '../components/CodeRefs.tsx';
import { findRun, loadReview, useReviewStore } from './code/use-comments.ts';
import type { Edge, Group as GroupData, Handle as HandleData, PrKey, Rect, RefFile, WorkData } from './types.ts';

type Zone = Edge | 'center';

const GLYPHS = {
  close: ['M18 6 6 18', 'M6 6l12 12'],
  split: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M12 3v18'],
  maximize: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  restore: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'],
};
const Glyph = ({ d }: { d: string[] }) => (
  <svg className="wb-glyph" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => <path key={p} d={p} />)}
  </svg>
);

const TabDefs = createContext<(id: string) => TabDef>(baseTabDef);
const useTabDef = () => useContext(TabDefs);
type Size = { width: number; height: number };

const useMobile = () => {
  const [m, setM] = useState(() => matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = matchMedia('(max-width: 900px)');
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
};

const useSize = (): [Size, (el: HTMLDivElement | null) => void] => {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [size, setEl];
};

const EDGE = 0.25;
const zoneAt = (e: React.DragEvent, el: HTMLElement): Zone => {
  const b = el.getBoundingClientRect();
  const x = (e.clientX - b.left) / b.width;
  const y = (e.clientY - b.top) / b.height;
  if (x < EDGE) return 'left';
  if (x > 1 - EDGE) return 'right';
  if (y < EDGE) return 'top';
  if (y > 1 - EDGE) return 'bottom';
  return 'center';
};

function Strip({ g, groups, ctx, merged, max, drag }: { g: GroupData; groups: GroupData[]; ctx: WorkData; merged: boolean; max: boolean; drag: string | null }) {
  const { activate, close, pin, toggleMax, splitWith, moveTab, setDrag } = useWorkbench.getState();
  const tabDef = useTabDef();
  const previews = groups.map((x) => x.preview);
  const total = groups.reduce((n, x) => n + x.tabs.length, 0);
  const [over, setOver] = useState<number | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const indexAt = (e: React.DragEvent) => {
    const heads = [...(tabsRef.current?.querySelectorAll('[role=tab]') ?? [])];
    const i = heads.findIndex((h) => { const b = h.getBoundingClientRect(); return e.clientX < b.left + b.width / 2; });
    return i < 0 ? heads.length : i;
  };
  return (
    <div className="wb-strip" role="tablist">
      <div
        ref={tabsRef}
        className={`wb-tabs ${over === g.tabs.length ? 'drop-end' : ''}`}
        onDragOver={(e) => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(indexAt(e)); }}
        onDragLeave={(e) => { if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(null); }}
        onDrop={(e) => { e.preventDefault(); setOver(null); if (drag) moveTab(drag, g.id, indexAt(e)); setDrag(null); }}
      >
        {g.tabs.map((id, i) => (
          <div
            key={id}
            role="tab"
            aria-selected={id === g.active}
            draggable
            className={`wb-tab-h ${id === g.active ? 'active' : ''} ${previews.includes(id) ? 'preview' : ''} ${over === i ? 'drop-before' : ''} ${drag === id ? 'dragging' : ''}`}
            onClick={() => activate(id)}
            onDoubleClick={() => pin(id)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && close(id)}
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag(id); }}
            onDragEnd={() => setDrag(null)}
          >
            {tabDef(id).icon}
            <span className="wb-label" title={tabDef(id).tip?.(ctx)}>{tabDef(id).title(ctx)}</span>
            {!(id === 'plan' && total === 1) && <button className="wb-x" aria-label="Close tab" onClick={(e) => { e.stopPropagation(); close(id); }}><Glyph d={GLYPHS.close} /></button>}
          </div>
        ))}
      </div>
      <div className="wb-acts">
        {!merged && g.tabs.length > 1 && <button className="wb-act" title="Split right (Cmd+\), Alt-click splits down" aria-label="Split" onClick={(e) => splitWith(g.active ?? '', g.id, e.altKey ? 'bottom' : 'right')}><Glyph d={GLYPHS.split} /></button>}
        {!merged && <button className={`wb-act ${max ? 'on' : ''}`} title={max ? 'Restore (Escape)' : 'Maximize (Escape leaves)'} aria-label="Maximize" onClick={toggleMax}><Glyph d={max ? GLYPHS.restore : GLYPHS.maximize} /></button>}
      </div>
    </div>
  );
}

function DropZone({ g, drag }: { g: GroupData; drag: string }) {
  const [zone, setZone] = useState<Zone | null>(null);
  const { moveTab, splitWith, setDrag } = useWorkbench.getState();
  return (
    <div
      className="wb-dropzone"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setZone(zoneAt(e, e.currentTarget)); }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        e.preventDefault();
        const z = zoneAt(e, e.currentTarget);
        setZone(null);
        if (z === 'center') moveTab(drag, g.id);
        else splitWith(drag, g.id, z);
        setDrag(null);
      }}
    >
      {zone && <div className={`wb-drop ${zone}`} />}
    </div>
  );
}

type GroupProps = { g: GroupData; groups: GroupData[]; ctx: WorkData; focused: boolean; merged: boolean; max: boolean; rect?: Rect; drag: string | null };

function Group({ g, groups, ctx, focused, merged, max, rect, drag }: GroupProps) {
  const { focus } = useWorkbench.getState();
  const tabDef = useTabDef();
  return (
    <section className={`wb-group ${focused ? 'focus' : ''}`} style={rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height }} hidden={!rect} onMouseDownCapture={() => !merged && focus(g.id)}>
      <Strip g={g} groups={groups} ctx={ctx} merged={merged} max={max} drag={drag} />
      <div className="wb-body">
        {g.tabs.map((id) => {
          const d = tabDef(id);
          return <div key={id} className={`wb-pane ${d.flush ? 'flush' : ''}`} hidden={id !== g.active}><d.Component tabId={id} group={g.id} /></div>;
        })}
        {drag && <DropZone g={g} drag={drag} />}
      </div>
    </section>
  );
}

function Handle({ h }: { h: HandleData }) {
  const [on, setOn] = useState(false);
  const row = h.dir === 'row';
  const move = (e: React.PointerEvent) => {
    if (!on) return;
    const total = h.sizes[h.i] + h.sizes[h.i + 1];
    const min = Math.min(0.1, total / 2);
    const f = Math.min(total - min, Math.max(min, ((row ? e.clientX : e.clientY) - h.origin) / h.avail));
    const sizes = [...h.sizes];
    sizes[h.i] = f;
    sizes[h.i + 1] = total - f;
    useWorkbench.getState().resize(h.path, sizes);
  };
  return (
    <div
      className={`wb-handle ${h.dir} ${on ? 'on' : ''}`}
      style={{ left: h.left, top: h.top, width: h.width, height: h.height }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setOn(true); }}
      onPointerMove={move}
      onPointerUp={() => setOn(false)}
      onPointerCancel={() => setOn(false)}
    />
  );
}

export default function Workbench({ slug }: { slug: string }) {
  return <WorkbenchView slug={slug} data={useWorkData(slug)} />;
}

export function WorkbenchView({ slug, data, defs = baseTabDef }: { slug: string; data: LoadedWork; defs?: (id: string) => TabDef }) {
  const tabDef = defs;
  const loaded: WorkData | null = data.w ? { ...data, w: data.w } : null;
  const prsKey = data.prs.map((p) => p.number).filter(Boolean).join(',');
  const stackedPrs = useMemo(() => (prsKey ? prsKey.split(',').map(Number) : []), [prsKey]);
  const ready = useWorkbench((s) => s.slug === slug);
  const { layout, groups, focused, max, drag } = useWorkbench();
  const mobile = useMobile();
  const [size, root] = useSize();
  useLayoutEffect(() => {
    useWorkbench.getState().load(slug);
    return startHashSync(slug);
  }, [slug]);
  useEffect(() => {
    document.body.classList.toggle('wb-max', ready && max);
    return () => document.body.classList.remove('wb-max');
  }, [ready, max]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const s = useWorkbench.getState();
      if (s.slug !== slug) return;
      if (e.key === 'Escape' && s.max) return s.toggleMax();
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const active = s.groups.find((g) => g.id === s.focused)?.active ?? '';
      if (e.key === 'w') { e.preventDefault(); s.close(active); }
      else if (e.key === '\\') { e.preventDefault(); s.moveToOtherGroup(active); }
      else if (/^[1-9]$/.test(e.key) && s.groups[Number(e.key) - 1]) { e.preventDefault(); s.focus(s.groups[Number(e.key) - 1].id); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [slug]);
  const focusedActive = groups.find((g) => g.id === focused)?.active;
  const [qo, setQo] = useState<PrKey | null>(null);
  const qoFiles: RefFile[] = useReviewStore((s) => (qo ? s.prs[`${slug}:${qo}`]?.refs?.files : null)) || [];
  const quickOpen = useCallback(() => {
    if (!ready || !data.w) return;
    const id = focusedActive || '';
    const n = prOfTab(id) || (id.startsWith('agent-') && findRun(slug, id.slice(6))?.number) || (data.prs.find((p) => p.number && p.state === 'OPEN') || data.prs.find((p) => p.number))?.number;
    if (!n) return;
    if (!useReviewStore.getState().prs[`${slug}:${n}`]?.refs) loadReview(slug, n);
    setQo(n);
  }, [ready, data.w, data.prs, focusedActive, slug]);
  useQuickOpenShortcut(quickOpen);
  const title = ready && loaded && focusedActive ? tabDef(focusedActive).title(loaded) : '';
  useEffect(() => { useWorkbench.getState().setTitle(title); }, [title]);
  const openAt = useCallback((n: PrKey, path: string, line: number | null) => openCodeAt(data.slug, n, path, line, { group: useWorkbench.getState().otherGroup() }), [data.slug]);
  if (data.err) return <div className="card danger">{data.err}</div>;
  if (!loaded || !ready) return <div className="sub" style={{ padding: 20 }}>Loading…</div>;

  const merged = mobile && groups.length > 1;
  const full: Rect = { left: 0, top: 0, ...size };
  let shown = groups;
  const rects: Record<number, Rect> = {};
  let handles: HandleData[] = [];
  if (merged) {
    shown = [{ type: 'group', id: focused, tabs: groups.flatMap((g) => g.tabs), active: focusedActive ?? null, preview: null }];
    rects[focused] = full;
  } else if (max) rects[focused] = full;
  else {
    const laid = layoutRects(layout, full);
    laid.groups.forEach((r) => { rects[r.id] = r; });
    handles = laid.handles;
  }
  return (
    <WorkContext.Provider value={loaded}>
      <TabDefs.Provider value={defs}>
      <CodeRefRoot n={(data.prs.findLast((p) => p.number) || data.prs.findLast((p) => p.key))?.key} openAt={openAt} slug={slug} prs={stackedPrs}>
      <div ref={root} className={`wb-root ${max ? 'max' : ''} ${drag ? 'drag' : ''}`}>
        {shown.map((g) => <Group key={g.id} g={g} groups={groups} ctx={loaded} focused={merged || g.id === focused} merged={merged} max={max} rect={rects[g.id]} drag={drag} />)}
        {handles.map((h) => <Handle key={`${h.path.join('.')}:${h.i}`} h={h} />)}
        {qo && <QuickOpen key={qo} open onClose={() => setQo(null)} prFiles={qoFiles} fetchTree={() => codeApi.tree(qo)} onOpen={(p) => useWorkbench.getState().open(codeTabId(qo, p, qoFiles), { preview: true })} />}
        {max && <button className="wb-exit" onClick={() => useWorkbench.getState().toggleMax()}>↙ exit</button>}
      </div>
      </CodeRefRoot>
      </TabDefs.Provider>
    </WorkContext.Provider>
  );
}
