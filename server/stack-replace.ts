// Update work's stack replace: which proposed row is which current row (same PR number, else same branch), what the replace adds, drops and moves, and the merged rows that keep the current rows' fields.
import { keyLabel, rowKey } from './stack.ts';
import type { StackRow } from './core-types.ts';

const branchOf = (r: StackRow) => r.planned?.branch || null;

// for each proposed row the index of the current row it replaces, or -1; a PR number wins over a branch, a current row matches once
export function matchRows(current: StackRow[], next: StackRow[]): number[] {
  const taken = new Set<number>();
  const pick = (by: (o: StackRow) => boolean) => {
    const i = current.findIndex((o, j) => !taken.has(j) && by(o));
    if (i >= 0) taken.add(i);
    return i;
  };
  const byNumber = next.map((n) => (n.number ? pick((o) => o.number === n.number) : -1));
  return next.map((n, k) => (byNumber[k] >= 0 ? byNumber[k] : branchOf(n) ? pick((o) => branchOf(o) === branchOf(n)) : -1));
}

// the proposed rows over the current ones: a matched row keeps notionPage, gates, kit, workspace, its PR number and its reviewers (unless the proposal names some)
export function replaceRows(current: StackRow[], next: StackRow[]): StackRow[] {
  const match = matchRows(current, next);
  return next.map((n, k) => {
    const old = current[match[k]];
    if (!old) return n;
    return { ...old, ...n, number: n.number ?? old.number, planned: { ...old.planned, ...n.planned }, personas: n.personas?.length ? n.personas : old.personas || [], notionPage: n.notionPage ?? old.notionPage };
  });
}

// matched rows whose order against the other matched rows changed: all but a longest increasing run of their current positions
function moved(pos: number[]): Set<number> {
  const best: number[][] = [];
  pos.forEach((p, k) => {
    const prev = best.filter((b) => pos[b[b.length - 1]] < p).sort((a, b) => b.length - a.length)[0] || [];
    best[k] = [...prev, k];
  });
  const keep = new Set([...best].sort((a, b) => b.length - a.length)[0] || []);
  return new Set(pos.map((_, k) => k).filter((k) => !keep.has(k)));
}

export type StackDiff = { added: string[]; removed: string[]; moved: string[]; linksKept: number; linksLost: number; differs: boolean };

export function stackDiff(current: StackRow[], next: StackRow[]): StackDiff {
  const match = matchRows(current, next);
  const label = (r: StackRow) => `${rowKey(r) == null ? '?' : keyLabel(rowKey(r))}${r.planned?.title ? ` ${r.planned.title}` : ''}`;
  const dropped = current.filter((_, i) => !match.includes(i));
  const matchedAt = next.map((_, k) => k).filter((k) => match[k] >= 0);
  const shifted = moved(matchedAt.map((k) => match[k]));
  const movedRows = matchedAt.filter((_, m) => shifted.has(m)).map((k) => label(next[k]));
  const added = next.filter((_, k) => match[k] < 0).map(label);
  return {
    added,
    removed: dropped.map(label),
    moved: movedRows,
    linksKept: replaceRows(current, next).filter((r) => r.notionPage).length,
    linksLost: dropped.filter((r) => r.notionPage).length,
    differs: Boolean(added.length || dropped.length || movedRows.length),
  };
}
