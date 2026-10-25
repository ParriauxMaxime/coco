import { useEffect, useRef, useState } from 'react';
import type { editor as Ed, Selection } from 'monaco-editor/editor/editor.api';
import { loadMonaco } from './code-api.ts';
import type { LineRange, ModelHost, MonacoApi, MonacoModule, ReviewComment, Side } from '../types.ts';

export type CommentHandlers = {
  onCreateComment?: (range: LineRange & { side: Side }) => void;
  onJump?: (target: { side: Side; line: number; column: number; word?: string }) => void;
};
export type ZoneTarget = { id: string; node: HTMLElement; side: Side };

const FLASH_MS = 1500;
const DEFAULT_ZONE_HEIGHT = 80;

export const EDITOR_OPTIONS = {
  automaticLayout: true,
  readOnly: true,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  glyphMargin: true,
  lineNumbersMinChars: 4,
  renderOverviewRuler: true,
};

const models = new Map<string, number>();

export function acquireModel({ monaco, languageFor }: ModelHost, side: Side | 'ext', path: string, text: string) {
  const uri = monaco.Uri.from({ scheme: 'cc', path: `/${side}/${path}` });
  const key = uri.toString();
  let model = monaco.editor.getModel(uri);
  if (model) {
    if (model.getValue() !== text) model.setValue(text);
  } else {
    model = monaco.editor.createModel(text, languageFor(path), uri);
  }
  models.set(key, (models.get(key) || 0) + 1);
  return model;
}

export function releaseModel(model: Ed.ITextModel | null | undefined) {
  if (!model) return;
  const key = model.uri.toString();
  const left = (models.get(key) || 1) - 1;
  if (left > 0) return models.set(key, left);
  models.delete(key);
  if (!model.isDisposed()) model.dispose();
}

export function flashLines(monaco: MonacoApi, editor: Ed.ICodeEditor, startLine: number, endLine = startLine) {
  const collection = editor.createDecorationsCollection([{ range: new monaco.Range(startLine, 1, endLine, 1), options: { isWholeLine: true, className: 'cc-flash' } }]);
  const timer = setTimeout(() => collection.clear(), FLASH_MS);
  return () => {
    clearTimeout(timer);
    collection.clear();
  };
}

export function revealLine(monaco: MonacoApi, editor: Ed.ICodeEditor, line: number) {
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  return flashLines(monaco, editor, line);
}

const selectionLines = (sel: Selection) => ({ startLine: sel.startLineNumber, endLine: sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber });

const DRAG_EDGE_PX = 32;
const DRAG_STEP_MAX_PX = 24;

// editor -> [[startLine, endLine]] of lines folded away by folds.js; a gutter drag stops at their edge
export const foldedLines = new WeakMap<Ed.ICodeEditor, [number, number][]>();

type Drag = { from: number; to: number; y: number; scroller: Element; raf: number };

function scrollParent(el: HTMLElement): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

function clampToFolds(editor: Ed.ICodeEditor, from: number, to: number) {
  for (const [start, end] of foldedLines.get(editor) || []) {
    if (to > from && start > from && start <= to) to = start - 1;
    if (to < from && end < from && end >= to) to = end + 1;
  }
  return to;
}

// handlers = { current: { onCreateComment, onJump } }; returns a disposer
export function attachCommentUx(monaco: MonacoApi, editor: Ed.ICodeEditor, side: Side, handlers: { current: CommentHandlers | undefined }) {
  const { GUTTER_LINE_NUMBERS, GUTTER_GLYPH_MARGIN, GUTTER_LINE_DECORATIONS, CONTENT_TEXT, CONTENT_EMPTY } = monaco.editor.MouseTargetType;
  const GUTTER = new Set([GUTTER_LINE_NUMBERS, GUTTER_GLYPH_MARGIN, GUTTER_LINE_DECORATIONS]);
  const ON_LINE = new Set([...GUTTER, CONTENT_TEXT, CONTENT_EMPTY]);
  const hover = editor.createDecorationsCollection();
  const dragRange = editor.createDecorationsCollection();
  let hoverLine: number | null = null;
  let drag: Drag | null = null;

  const setHover = (line: number | null) => {
    if (line === hoverLine) return;
    hoverLine = line;
    hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'cc-add-glyph' } }] : []);
  };
  const paint = () => dragRange.set(drag ? [{ range: new monaco.Range(Math.min(drag.from, drag.to), 1, Math.max(drag.from, drag.to), 1), options: { isWholeLine: true, className: 'cc-drag-line', marginClassName: 'cc-drag-margin' } }] : []);

  const visibleBox = (d: Drag) => {
    const box = editor.getContainerDomNode().getBoundingClientRect();
    const port = d.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : d.scroller.getBoundingClientRect();
    return { box, port, top: Math.max(box.top, port.top), bottom: Math.min(box.bottom, port.bottom) };
  };
  const track = () => {
    if (!drag) return;
    const { box, top, bottom } = visibleBox(drag);
    if (bottom <= top) return;
    const x = box.left + editor.getLayoutInfo().contentLeft + 2;
    const y = Math.min(Math.max(drag.y, top + 1), bottom - 2);
    const line = editor.getTargetAtClientPoint(x, y)?.position?.lineNumber;
    if (!line) return;
    const to = clampToFolds(editor, drag.from, line);
    if (to === drag.to) return;
    drag.to = to;
    paint();
    setHover(to);
  };
  const autoScroll = () => {
    if (!drag) return;
    const { box, port, top, bottom } = visibleBox(drag);
    let dy = 0;
    if (drag.y > bottom - DRAG_EDGE_PX) dy = Math.min(DRAG_STEP_MAX_PX, (drag.y - bottom + DRAG_EDGE_PX) / 2);
    else if (drag.y < top + DRAG_EDGE_PX) dy = -Math.min(DRAG_STEP_MAX_PX, (top + DRAG_EDGE_PX - drag.y) / 2);
    if (dy) {
      const st = editor.getScrollTop();
      const max = editor.getScrollHeight() - editor.getLayoutInfo().height;
      if ((dy > 0 && st < max - 1) || (dy < 0 && st > 0)) editor.setScrollTop(st + dy);
      else if ((dy > 0 && box.bottom > port.bottom + 1) || (dy < 0 && box.top < port.top - 1)) drag.scroller.scrollTop += dy;
      track();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  };

  const onMove = (e: MouseEvent) => {
    if (!drag) return;
    drag.y = e.clientY;
    track();
  };
  function stop() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', stop);
    if (!drag) return null;
    cancelAnimationFrame(drag.raf);
    const done = drag;
    drag = null;
    paint();
    return done;
  }
  function onUp(e: MouseEvent) {
    if (e.button !== 0) return;
    const done = stop();
    if (done) handlers.current?.onCreateComment?.({ side, startLine: Math.min(done.from, done.to), endLine: Math.max(done.from, done.to) });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  }

  // capture phase on the editor root, so Monaco never starts its own gutter line selection
  const dom = editor.getContainerDomNode();
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0 || drag || (e.target instanceof Element && e.target.closest('.cc-fold, .cc-zone-host'))) return;
    const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
    const line = target?.position?.lineNumber;
    if (!target || !line || !GUTTER.has(target.type)) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { from: line, to: line, y: e.clientY, scroller: scrollParent(dom), raf: 0 };
    paint();
    setHover(line);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', stop);
    drag.raf = requestAnimationFrame(autoScroll);
  };
  dom.addEventListener('mousedown', onDown, true);

  const subs = [
    editor.onMouseDown((e) => {
      const pos = e.target.position;
      if (pos && (e.event.metaKey || e.event.ctrlKey) && e.target.type === CONTENT_TEXT) {
        const word = editor.getModel()?.getWordAtPosition(pos)?.word;
        handlers.current?.onJump?.({ side, line: pos.lineNumber, column: pos.column, word });
      }
    }),
    editor.onMouseMove((e) => {
      if (!drag) setHover(ON_LINE.has(e.target.type) ? (e.target.position?.lineNumber ?? null) : null);
    }),
    editor.onMouseLeave(() => !drag && setHover(null)),
    editor.onKeyDown((e) => {
      if (e.keyCode !== monaco.KeyCode.KeyC || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.current?.onCreateComment?.({ side, ...selectionLines(sel) });
    }),
  ];

  return {
    dispose: () => {
      stop();
      dom.removeEventListener('mousedown', onDown, true);
      subs.forEach((s) => s.dispose());
      hover.clear();
      dragRange.clear();
    },
  };
}

// Line tint + glyph decorations and one view zone per comment of `side`; returns [{ id, node, side }] portal targets
export function useCommentLayer(mod: MonacoModule | null, editor: Ed.ICodeEditor | null, side: Side, comments: ReviewComment[]) {
  const [zones, setZones] = useState<ZoneTarget[]>([]);
  const latest = useRef(comments);
  latest.current = comments;
  const signature = comments
    .filter((c) => c.side === side)
    .map((c) => `${c.id}:${c.startLine}:${c.endLine}:${c.status}`)
    .join('|');

  useEffect(() => {
    if (!mod || !editor) return undefined;
    const { monaco } = mod;
    const mine = latest.current.filter((c) => c.side === side);
    const decorations = mine.flatMap((c) => [
      { range: new monaco.Range(c.startLine, 1, c.endLine, 1), options: { isWholeLine: true, className: `cc-comment-line cc-${c.status}` } },
      { range: new monaco.Range(c.startLine, 1, c.startLine, 1), options: { glyphMarginClassName: 'cc-comment-glyph', overviewRuler: { color: '#4f46e5', position: monaco.editor.OverviewRulerLane.Right } } },
    ]);
    const collection = editor.createDecorationsCollection(decorations);
    const made: { id: string; side: Side; zoneId: string; zone: Ed.IViewZone; node: HTMLElement }[] = [];
    editor.changeViewZones((accessor) => {
      for (const c of mine) {
        const domNode = document.createElement('div');
        domNode.className = 'cc-zone-node';
        const host = document.createElement('div');
        host.className = 'cc-zone-host';
        for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());
        domNode.appendChild(host);
        const zone = { afterLineNumber: c.endLine, heightInPx: DEFAULT_ZONE_HEIGHT, domNode, suppressMouseDown: false };
        made.push({ id: c.id, side, zoneId: accessor.addZone(zone), zone, node: host });
      }
    });
    const observers = made.map((z) => {
      const ro = new ResizeObserver(() => {
        const height = Math.ceil(z.node.getBoundingClientRect().height);
        if (height < 1 || height === z.zone.heightInPx) return;
        z.zone.heightInPx = height;
        editor.changeViewZones((accessor) => accessor.layoutZone(z.zoneId));
      });
      ro.observe(z.node);
      return ro;
    });
    setZones((prev) => (!prev.length && !made.length ? prev : made.map(({ id, node }) => ({ id, node, side }))));
    return () => {
      observers.forEach((ro) => ro.disconnect());
      collection.clear();
      try {
        editor.changeViewZones((accessor) => made.forEach((z) => accessor.removeZone(z.zoneId)));
      } catch {}
      setZones((prev) => (prev.length ? [] : prev));
    };
  }, [mod, editor, side, signature]);

  return zones;
}

export function useMonaco() {
  const [state, setState] = useState<{ mod: MonacoModule | null; error: Error | null }>({ mod: null, error: null });
  useEffect(() => {
    let live = true;
    loadMonaco()
      .then((mod) => live && setState({ mod, error: null }))
      .catch((error: Error) => live && setState({ mod: null, error }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}
