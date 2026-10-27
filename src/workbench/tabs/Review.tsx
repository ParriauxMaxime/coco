import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { useComments } from '../code/use-comments.ts';
import { isDesktop } from '../code/code-api.ts';
import { treeOrder } from '../code/FileList.tsx';
import { isLocalKey, keyLabel, reviewKeyOfTab } from '../code/ids.ts';
import ReviewSidebar, { CHIP } from '../code/ReviewSidebar.tsx';
import ReviewFileCard from '../code/ReviewFileCard.tsx';
import ReviewActivity from '../code/ReviewActivity.tsx';
import Collapsible from '../../components/Collapsible.tsx';
import { CodeRefScope } from '../../components/CodeRefs.tsx';
import { orderGroups, planNotes } from '../code/review-order.ts';
import { useLangProviders, useLangStatus, useLocal } from './Code.tsx';
import PrBadge, { stateChip, stateLabel } from '../../components/PrBadge.tsx';
import { errorMessage } from '../../api.ts';
import type { Reveal } from '../code/DiffView.tsx';
import type { RefFile, ReviewComment } from '../types.ts';
import '../code/code.css';

const OPEN_FIRST = 15;
const MOUNT_MARGIN = '600px';
// Cards unmount past this distance; the gap with MOUNT_MARGIN keeps a scroll back and forth from rebuilding editors.
const UNMOUNT_MARGIN = '3000px';
const SCROLL_GAP = 12;
const SIDE_MIN = 200;
const SIDE_MAX = 480;
const ACT_MIN = 280;
const ACT_MAX = 720;
const MAIN_MIN = 420;
const SBS_MIN = 900;
const COUNTS = ['open', 'sent', 'fixed', 'declined', 'outdated'];
const SCRIPT = /\.[cm]?[jt]sx?$/;
const SAVE_MS = 150;
// Cards above the restored one mount and take their real height for a while; the anchor is re-pinned until then or the first user input.
const RESTORE_MS = 5000;
const USER_INPUTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;

type ScrollAnchor = { path: string; offset: number };
const readAnchor = (key: string): ScrollAnchor | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v && typeof v === 'object' && 'path' in v && typeof v.path === 'string' && 'offset' in v && typeof v.offset === 'number' ? { path: v.path, offset: v.offset } : null;
  } catch { return null; }
};

const typing = (t: EventTarget | null) => t instanceof HTMLElement && Boolean(t.closest('.cc-zone-host, .find-widget') || /^(INPUT|SELECT)$/.test(t.tagName) || ((t.tagName === 'TEXTAREA' || t.isContentEditable) && !t.closest('.monaco-editor')));

export default function Review({ tabId }: { tabId: string }) {
  const { slug, w, prs } = useWork();
  const n = reviewKeyOfTab(tabId) ?? '';
  const rv = useComments(slug, n);
  const desktop = useMemo(isDesktop, []);
  const active = useWorkbench((s) => s.groups.some((g) => g.active === tabId));
  const [sbs, setSbs] = useLocal('cc.sbs', innerWidth >= 1300);
  const [width, setWidth] = useLocal('cc.rv.w', 280);
  const [actWidth, setActWidth] = useLocal('cc.rv.aw', 380);
  const [dragging, setDragging] = useState<false | 'left' | 'right'>(false);
  const [opened, setOpened] = useState<Set<string> | null>(null);
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const pr = prs.find((p) => p.key === n);
  const files = rv.refs?.files || [];
  const [mode, setMode] = useLocal(`cc.rv.order.${n}`, 'suggested');
  const [hidden, setHidden] = useLocal<string[]>(`cc.rv.hide.${n}`, []);
  const cats = rv.plan?.categories;
  const shown = useMemo(() => files.filter((f) => !hidden.includes(cats?.[f.filename]?.category ?? '')), [files, hidden, cats]);
  const groups = useMemo(() => (mode === 'suggested' && rv.plan ? orderGroups(shown, rv.plan) : null), [mode, shown, rv.plan]);
  const order = useMemo(() => (groups ? groups.flatMap((g) => g.files) : treeOrder(shown)), [groups, shown]);
  const ticks = useMemo(() => new Set<string>(rv.plan?.ticks || []), [rv.plan?.ticks]);
  const notes = useMemo(() => planNotes(rv.plan?.plan), [rv.plan?.plan]);
  const catCounts = useMemo(() => files.reduce<Record<string, number>>((acc, f) => {
    const c = cats?.[f.filename]?.category;
    if (c) acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {}), [files, cats]);
  const { counts } = rv;

  const mainRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setBoxW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [Boolean(pr)]);
  const els = useRef(new Map<string, HTMLElement>());
  const heights = useRef(new Map<string, number>());
  const io = useRef<IntersectionObserver[] | null>(null);
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  const orderRef = useRef<RefFile[]>(order);
  orderRef.current = order;
  const activeRef = useRef(activePath);
  activeRef.current = activePath;
  const unhide = useRef<((path: string) => void) | null>(null);
  unhide.current = (path: string) => {
    const c = cats?.[path]?.category ?? '';
    if (hidden.includes(c)) setHidden(hidden.filter((x) => x !== c));
  };
  const lock = useRef(0);
  const pendingScroll = useRef<string | null>(null);
  const raf = useRef(0);
  const [scrollTick, setScrollTick] = useState(0);
  const scrollKey = `cc.rv.scroll.${slug}.${n}`;
  const restore = useRef<ScrollAnchor | null | undefined>(undefined);
  if (restore.current === undefined) restore.current = readAnchor(scrollKey);
  const stopRestore = useRef(() => { restore.current = null; });
  const saveTimer = useRef(0);

  useEffect(() => {
    if (!opened && order.length) setOpened(new Set(order.filter((f) => !ticks.has(f.filename)).slice(0, OPEN_FIRST).map((f) => f.filename)));
    if (!activeRef.current && order.length) setActivePath(order[0].filename);
  }, [order]);

  const warmPath = useMemo(() => order.find((f) => f.status !== 'removed' && SCRIPT.test(f.filename))?.filename, [order]);
  const sha = rv.refs?.headSha;
  const lang = useLangStatus(n, sha, warmPath, desktop && Boolean(warmPath), desktop && active);
  useLangProviders(slug, n, sha, desktop && active, () => useWorkbench.getState().otherGroup());

  // Windowed cards: mount near the viewport, unmount far from it unless a comment is being typed in it.
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return undefined;
    const update = (paths: string[], add: boolean) => paths.length && setMounted((prev) => {
      const next = new Set(prev);
      paths.forEach((p) => (add ? next.add(p) : next.delete(p)));
      return next.size === prev.size ? prev : next;
    });
    const typingIn = (el: Element) => el.contains(document.activeElement) || el.querySelector('.cc-zone-host textarea');
    const pathOf = (e: IntersectionObserverEntry) => (e.target instanceof HTMLElement && e.target.dataset.path ? [e.target.dataset.path] : []);
    const near = new IntersectionObserver((entries) => {
      update(entries.filter((e) => e.isIntersecting && !e.target.classList.contains('shut')).flatMap(pathOf), true);
    }, { root, rootMargin: MOUNT_MARGIN });
    const far = new IntersectionObserver((entries) => {
      update(entries.filter((e) => !e.isIntersecting && !typingIn(e.target)).flatMap(pathOf), false);
    }, { root, rootMargin: UNMOUNT_MARGIN });
    io.current = [near, far];
    els.current.forEach((el) => io.current?.forEach((o) => o.observe(el)));
    return () => { near.disconnect(); far.disconnect(); io.current = null; };
  }, [Boolean(pr)]);

  useEffect(() => {
    const near = io.current?.[0];
    if (!near) return;
    els.current.forEach((el, p) => {
      if (mountedRef.current.has(p)) return;
      near.unobserve(el);
      near.observe(el);
    });
  }, [opened]);

  const cardRef = useCallback((path: string, el: HTMLElement | null) => {
    const prev = els.current.get(path);
    if (prev && prev !== el) io.current?.forEach((o) => o.unobserve(prev));
    if (!el) return void els.current.delete(path);
    els.current.set(path, el);
    io.current?.forEach((o) => o.observe(el));
  }, []);
  const onHeight = useCallback((path: string, h: number) => heights.current.set(path, h), []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const main = mainRef.current;
      if (!main) return;
      const top = main.scrollTop + SCROLL_GAP + 4;
      let cur = orderRef.current[0]?.filename;
      for (const f of orderRef.current) {
        const el = els.current.get(f.filename);
        if (!el) continue;
        if (el.offsetTop > top) break;
        cur = f.filename;
      }
      const curEl = cur ? els.current.get(cur) : undefined;
      if (cur && curEl && !restore.current) {
        const anchor: ScrollAnchor = { path: cur, offset: Math.round(main.scrollTop - curEl.offsetTop) };
        clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => { try { localStorage.setItem(scrollKey, JSON.stringify(anchor)); } catch {} }, SAVE_MS);
      }
      if (Date.now() < lock.current) return;
      const atEnd = main.scrollTop + main.clientHeight >= main.scrollHeight - 2;
      const activeEl = activeRef.current ? els.current.get(activeRef.current) : undefined;
      const keep = atEnd && activeEl !== undefined && activeEl.offsetTop > main.scrollTop;
      if (!keep) setActivePath(cur ?? null);
    });
  }, [scrollKey]);

  useEffect(() => {
    const main = mainRef.current;
    const target = restore.current;
    if (!target || !active || !opened || !main) return undefined;
    if (main.scrollTop > 0 || !els.current.has(target.path)) {
      restore.current = null;
      return undefined;
    }
    setActivePath(target.path);
    const until = Date.now() + RESTORE_MS;
    let frame = 0;
    const detach = () => {
      cancelAnimationFrame(frame);
      USER_INPUTS.forEach((t) => main.removeEventListener(t, stop));
    };
    const stop = () => {
      detach();
      restore.current = null;
    };
    const pin = () => {
      const el = els.current.get(target.path);
      if (!el || Date.now() > until) return stop();
      const top = el.offsetTop + target.offset;
      if (Math.abs(main.scrollTop - top) > 1) main.scrollTop = top;
      frame = requestAnimationFrame(pin);
    };
    USER_INPUTS.forEach((t) => main.addEventListener(t, stop, { passive: true }));
    stopRestore.current = stop;
    pin();
    return detach;
  }, [active, Boolean(opened)]);

  const scrollMain = (top: number) => {
    lock.current = Date.now() + 400;
    if (mainRef.current) mainRef.current.scrollTop = top;
  };
  useLayoutEffect(() => {
    const p = pendingScroll.current;
    const el = p && els.current.get(p);
    if (!el || !mainRef.current) return;
    pendingScroll.current = null;
    scrollMain(el.offsetTop - SCROLL_GAP);
  }, [scrollTick]);

  const goTo = useCallback((path: string) => {
    stopRestore.current();
    unhide.current?.(path);
    setOpened((prev) => (!prev || prev.has(path) ? prev : new Set(prev).add(path)));
    setActivePath(path);
    pendingScroll.current = path;
    setScrollTick((t) => t + 1);
  }, []);
  const onToggle = useCallback((path: string) => setOpened((prev) => {
    const next = new Set(prev);
    if (!next.delete(path)) next.add(path);
    return next;
  }), []);
  const onTick = useCallback((path: string, on: boolean) => {
    rv.tick(path, on).catch((e: unknown) => rv.setNotice(errorMessage(e)));
    setOpened((prev) => {
      const next = new Set(prev);
      if (on) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [rv.tick]);
  const onOpenTab = useCallback((path: string) => {
    const s = useWorkbench.getState();
    s.open(`diff-${n}~${path}`, { group: s.otherGroup() });
  }, [n]);
  const onReveal = useCallback((path: string, y: number, center: boolean) => {
    const el = els.current.get(path);
    const main = mainRef.current;
    if (el && main) scrollMain(el.offsetTop + y - (center ? main.clientHeight / 2 : SCROLL_GAP));
  }, []);
  const jump = useCallback((c: ReviewComment) => {
    const path = (c.side === 'base' && orderRef.current.find((f) => f.previous === c.path)?.filename) || c.path;
    goTo(path);
    setReveal({ path, line: c.startLine, side: c.side, at: Date.now() });
  }, [goTo]);

  useEffect(() => {
    if (!active) return undefined;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'j' && e.key !== 'k') || typing(e.target)) return;
      const s = useWorkbench.getState();
      if (s.groups.find((g) => g.id === s.focused)?.active !== tabId) return;
      e.preventDefault();
      e.stopPropagation();
      const list = orderRef.current;
      const i = list.findIndex((f) => f.filename === activeRef.current);
      const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
      if (next) goTo(next.filename);
    };
    addEventListener('keydown', on, true);
    return () => removeEventListener('keydown', on, true);
  }, [active, tabId, goTo]);

  const rvCards = useMemo(() => rv, [rv.comments, rv.drafts, rv.refs, rv.proposals]);
  const setAll = (on: boolean) => setOpened(new Set(on ? order.map((f) => f.filename) : []));
  const resize = (e: React.PointerEvent) => {
    if (!dragging || !bodyRef.current) return;
    const box = bodyRef.current.getBoundingClientRect();
    if (dragging === 'left') setWidth(Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, e.clientX - box.left))));
    else setActWidth(Math.round(Math.min(ACT_MAX, Math.max(ACT_MIN, box.right - e.clientX))));
  };
  const handle = (side: 'left' | 'right') => <div className="rv-handle" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(side); }} onPointerMove={resize} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} />;

  if (!pr) return <div className="sub" style={{ padding: 16 }}>{keyLabel(n)} is not in this work.</div>;
  const title = pr.title || pr.planned?.title;
  const toggleCat = (c: string) => setHidden(hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c]);
  // panes that fit the group's width (a split halves it): the activity pane shrinks, then folds into the main column, then the file list does
  const room = boxW || innerWidth;
  const fitAct = Math.min(actWidth, room - width - 12 - MAIN_MIN);
  const showAct = desktop && fitAct >= ACT_MIN;
  const showSide = desktop && room - width - 6 - (showAct ? fitAct + 6 : 0) >= MAIN_MIN;
  const mainW = room - (showSide ? width + 6 : 0) - (showAct ? fitAct + 6 : 0);
  const columns = [showSide && `${width}px 6px`, 'minmax(0, 1fr)', showAct && `6px ${fitAct}px`].filter(Boolean).join(' ');
  const sidebar = <ReviewSidebar files={files} shown={shown} order={{ mode, setMode, groups, hidden, onToggleCat: toggleCat, catCounts, ticks }} rv={rv} activePath={activePath} onPick={goTo} phone={!showSide} />;
  const activity = <ReviewActivity slug={slug} n={n} rv={rv} onJump={jump} />;
  return (
    <CodeRefScope n={n}>
    <div className="rv">
      <div className="rv-bar">
        {isLocalKey(n) ? <code className="pr-num" title="local branch, no PR yet">{keyLabel(n)}</code> : <PrBadge pr={pr} />}
        <span className="rv-title" title={title}>{title}</span>
        <span className={`chip ${stateChip(pr)}`}>{stateLabel(pr)}</span>
        {COUNTS.filter((k) => counts[k]).map((k) => <span key={k} className={`chip ${CHIP[k]}`}>{counts[k]} {k}</span>)}
        <span className="cc-spacer" />
        <button type="button" className="cc-link" title="Every remark on this PR in one list" onClick={() => { const s = useWorkbench.getState(); s.open(`findings-${n}`, { group: s.otherGroup() }); }}>findings</button>
        <button type="button" className="cc-link" disabled={!order.length} onClick={() => setAll(true)}>expand all</button>
        <button type="button" className="cc-link" disabled={!order.length} onClick={() => setAll(false)}>collapse all</button>
        {desktop && <button className="wb-act" disabled={mainW < SBS_MIN} title={mainW < SBS_MIN ? 'Too narrow for side by side' : undefined} onClick={() => setSbs(!sbs)}>{sbs && mainW >= SBS_MIN ? 'inline' : 'side by side'}</button>}
        {lang && <span className={`chip ${lang.cls}`} title={lang.tip}>{lang.label}</span>}
      </div>
      {rv.notice && <div className="next rv-notice">{rv.notice}</div>}
      {rv.error && <div className="rv-notice danger">{rv.error}</div>}
      <div ref={bodyRef} className={`rv-body ${dragging ? 'dragging' : ''}`} style={{ gridTemplateColumns: columns }}>
        {showSide && sidebar}
        {showSide && handle('left')}
        <div className="rv-main" ref={mainRef} onScroll={onScroll}>
          {!(showSide && showAct) && <div className="rv-side-m">{!showSide && sidebar}{!showAct && <Collapsible level="pm" title="Plan and activity">{activity}</Collapsible>}</div>}
          {!rv.refs && <div className="sub">{rv.error ? '' : 'Loading files…'}</div>}
          {opened && order.map((f) => (
            <ReviewFileCard
              key={f.filename}
              n={n}
              rv={rvCards}
              file={f}
              open={Boolean(opened?.has(f.filename))}
              mounted={mounted.has(f.filename)}
              knownHeight={heights.current.get(f.filename)}
              reveal={reveal?.path === f.filename ? reveal : null}
              category={cats?.[f.filename]}
              note={notes[f.filename]}
              reviewed={ticks.has(f.filename)}
              onTick={rv.plan ? onTick : null}
              sbs={sbs && mainW >= SBS_MIN}
              desktop={desktop}
              cardRef={cardRef}
              onToggle={onToggle}
              onOpenTab={onOpenTab}
              onReveal={onReveal}
              onHeight={onHeight}
            />
          ))}
        </div>
        {showAct && handle('right')}
        {showAct && activity}
      </div>
    </div>
    </CodeRefScope>
  );
}
