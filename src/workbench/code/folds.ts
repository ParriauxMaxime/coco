import type { editor, IRange } from 'monaco-editor/editor/editor.api';
import { foldedLines } from './editor-shared.ts';
import type { MonacoApi, ReviewComment } from '../types.ts';

type Region = { o: number; m: number; len: number };
type IdRegion = Region & { id: number; start: number; end: number };
type FoldComment = Pick<ReviewComment, 'side' | 'startLine' | 'endLine'>;
type Expansion = 'all' | 'down' | 'up';
type Span = [number, number];
type FoldSide = { editor: editor.ICodeEditor; key: 'o' | 'm'; zones: string[] };

const CONTEXT = 3;
const MIN_HIDDEN = 3;
const STEP = 50;
const SHOW_ALL_MAX = 100;
const SOURCE = 'cc-folds';

type HiddenAreaEditor = editor.ICodeEditor & { setHiddenAreas(ranges: IRange[], source?: string): void };
const setHiddenAreas = (target: editor.ICodeEditor, ranges: IRange[]) => (target as HiddenAreaEditor).setHiddenAreas(ranges, SOURCE);

// [start, endExclusive) of a line change on one side; an empty side sits after `start`
const span = (start: number, end: number): Span => (end === 0 ? [start + 1, start + 1] : [start, end + 1]);

// unchanged runs shared by both sides, minus CONTEXT lines next to each change: [{ o, m, len }]
export function unchangedRegions(changes: editor.ILineChange[], originalCount: number) {
  const out: Region[] = [];
  let o = 1;
  let m = 1;
  const gap = (oEnd: number, first: boolean, last: boolean) => {
    const from = first ? 0 : CONTEXT;
    const len = oEnd - o - from - (last ? 0 : CONTEXT);
    if (len >= MIN_HIDDEN) out.push({ o: o + from, m: m + from, len });
  };
  changes.forEach((c, i) => {
    const [oStart, oEnd] = span(c.originalStartLineNumber, c.originalEndLineNumber);
    gap(oStart, i === 0, false);
    o = oEnd;
    m = span(c.modifiedStartLineNumber, c.modifiedEndLineNumber)[1];
  });
  gap(originalCount + 1, !changes.length, true);
  return out;
}

// opens [line - CONTEXT, end + CONTEXT] of every comment, splitting the region holding it
export function forceOpen<R extends Region>(regions: R[], comments: Iterable<FoldComment>) {
  let out = regions;
  for (const c of comments) {
    const next: R[] = [];
    for (const r of out) {
      const base = c.side === 'base' ? r.o : r.m;
      const a = Math.max(0, c.startLine - base - CONTEXT);
      const b = Math.min(r.len - 1, c.endLine - base + CONTEXT);
      if (a > b) {
        next.push(r);
        continue;
      }
      if (a >= MIN_HIDDEN) next.push({ ...r, len: a });
      if (r.len - b - 1 >= MIN_HIDDEN) next.push({ ...r, o: r.o + b + 1, m: r.m + b + 1, len: r.len - b - 1 });
    }
    out = next;
  }
  return out;
}

// regions are { id, o, m, len }: id = original start of the unchanged run they come from
export function withIds(regions: Region[]): IdRegion[] {
  return regions.map((r) => ({ ...r, id: r.o, start: r.o, end: r.o + r.len }));
}

// base runs minus the original line ranges revealed in each, per id: Map<id, [from, to)[]>
export function applyRevealed(base: IdRegion[], revealed: Map<number, Span[]>) {
  const out: (Region & { id: number })[] = [];
  for (const r of base) {
    let at = r.start;
    const cuts = [...(revealed.get(r.id) || [])].sort((a, b) => a[0] - b[0]);
    const ends: Span[] = [...cuts, [r.end, r.end]];
    for (const [from, to] of ends) {
      const end = Math.min(from, r.end);
      if (end > at) out.push({ id: r.id, o: at, m: r.m + at - r.o, len: end - at });
      at = Math.max(at, to);
    }
  }
  return out;
}

// original line range an expansion reveals: 'down' the top STEP lines (next to the code above), 'up' the bottom STEP, 'all' the whole region
export function revealRange(r: Region, how: Expansion): Span {
  if (how === 'down' && r.len > STEP) return [r.o, r.o + STEP];
  if (how === 'up' && r.len > STEP) return [r.o + r.len - STEP, r.o + r.len];
  return [r.o, r.o + r.len];
}

export const canShowAll = (r: Region, originalCount: number) => r.len <= SHOW_ALL_MAX || r.o === 1 || r.o + r.len - 1 >= originalCount;

function button(label: string, title: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cc-fold-btn';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return b;
}

function bar(r: Region, originalCount: number, onExpand: (how: Expansion) => void) {
  const node = document.createElement('div');
  node.className = 'cc-fold';
  if (r.len <= STEP) node.append(button('↕', `Show ${r.len} lines`, () => onExpand('all')));
  else node.append(button(`⤓ ${STEP}`, `Show ${STEP} more lines below the code above`, () => onExpand('down')), button(`⤒ ${STEP}`, `Show ${STEP} more lines above the code below`, () => onExpand('up')));
  const all = canShowAll(r, originalCount);
  const label = document.createElement(all ? 'button' : 'span');
  label.className = `cc-fold-label ${all ? 'on' : ''}`;
  label.textContent = `${r.len} hidden line${r.len === 1 ? '' : 's'}`;
  if (label instanceof HTMLButtonElement) {
    label.type = 'button';
    label.title = 'Show all';
    label.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onExpand('all');
    });
  }
  node.append(label);
  return node;
}

// GitHub-like hidden lines on both sides of a diff editor; expansions survive diff recomputes; returns { setComments, dispose }
export function attachFolds(monaco: MonacoApi, diff: editor.IStandaloneDiffEditor, { onExpand }: { onExpand?: () => void } = {}) {
  const sides: FoldSide[] = [
    { editor: diff.getOriginalEditor(), key: 'o', zones: [] },
    { editor: diff.getModifiedEditor(), key: 'm', zones: [] },
  ];
  let base: IdRegion[] = [];
  let regions: (Region & { id?: number })[] = [];
  let originalCount = 0;
  const revealed = new Map<number, Span[]>();
  const opened = new Map<string, FoldComment>();

  const render = () => {
    for (const s of sides) {
      const { editor, key } = s;
      if (!editor.getModel()) continue;
      const ranges = regions.map((r) => ({ startLineNumber: r[key], startColumn: 1, endLineNumber: r[key] + r.len - 1, endColumn: 1 }));
      foldedLines.set(editor, regions.map((r) => [r[key], r[key] + r.len - 1]));
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
      editor.changeViewZones((acc) => {
        s.zones.forEach((id) => acc.removeZone(id));
        s.zones = regions.map((r) => {
          const marginDomNode = document.createElement('div');
          marginDomNode.className = 'cc-fold-margin';
          const domNode = bar(r, originalCount, (how) => {
            const id = r.id ?? r.o;
            revealed.set(id, [...(revealed.get(id) || []), revealRange(r, how)]);
            update(true);
            onExpand?.();
          });
          return acc.addZone({ afterLineNumber: r[key] - 1, heightInPx: lineHeight + 4, domNode, marginDomNode, suppressMouseDown: false, showInHiddenAreas: true });
        });
      });
      setHiddenAreas(editor, ranges);
    }
  };

  const same = (a: Region[], b: Region[]) => a.length === b.length && a.every((r, i) => r.o === b[i].o && r.m === b[i].m && r.len === b[i].len);
  const update = (force: boolean) => {
    const next = forceOpen(applyRevealed(base, revealed), [...opened.values()]);
    if (!force && same(next, regions)) return;
    regions = next;
    render();
  };

  const recompute = () => {
    const changes = diff.getLineChanges();
    const model = diff.getModel();
    if (!changes || !model) return;
    originalCount = model.original.getLineCount();
    base = withIds(unchangedRegions(changes, originalCount));
    update(true);
  };

  const sub = diff.onDidUpdateDiff(recompute);
  recompute();

  return {
    setComments(next: FoldComment[]) {
      for (const c of next) opened.set(`${c.side}:${c.startLine}:${c.endLine}`, c);
      update(false);
    },
    dispose() {
      sub.dispose();
      for (const { editor, zones } of sides) {
        foldedLines.delete(editor);
        try {
          editor.changeViewZones((acc) => zones.forEach((id) => acc.removeZone(id)));
          setHiddenAreas(editor, []);
        } catch {}
      }
    },
  };
}
