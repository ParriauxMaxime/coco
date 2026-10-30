// Stack row keys: a PR number, `b:<branch with / as :>` for a row with a branch and no PR, or `r:<planned order>` for a row that
// ships straight to the default branch: it has no branch of its own, its order is the only identity it has. No two rows of a work
// share a key (keyClash guards the writes): the React keys, tabs, agent labels and findings all hang off it.
import type { RowKey, StackRow, Work, Works } from './core-types.ts';

const ORDER = /^r:(\d+)$/;
const BRANCH_KEY = /^b:[\w][\w.:-]*$/;
const LOCAL = /^(?:b:[\w][\w.:-]*|r:\d+)$/;
const BRANCH = /^[\w][\w./-]*$/;

// the planned order an order key names
export const orderOf = (k: unknown): number | null => {
  const m = ORDER.exec(String(k ?? ''));
  return m ? Number(m[1]) : null;
};

export const rowKey = (row: StackRow | null | undefined): RowKey | null =>
  row?.number ? row.number : BRANCH.test(row?.planned?.branch || '') ? `b:${row?.planned?.branch?.replaceAll('/', ':')}` : row?.planned?.order != null ? `r:${row.planned.order}` : null;
// takes a key as agents write it too: "#12", "b:feat/x", "r:3"
export const parseKey = (k: unknown): RowKey | null => {
  const s = String(k).trim().replace(/^#/, '').replaceAll('/', ':');
  return /^\d+$/.test(s) ? Number(s) : LOCAL.test(s) ? s : null;
};
export const isLocal = (k: unknown): k is `b:${string}` | `r:${string}` => typeof k === 'string' && LOCAL.test(k);
// the branch a local key names; an order key names none (the row ships on the default branch, nothing to check out)
export const branchOf = (k: RowKey): string => (BRANCH_KEY.test(String(k)) ? String(k).slice(2).replaceAll(':', '/') : '');
export const fileKey = (k: unknown): string => String(k).replaceAll(':', '~');
export const keyLabel = (k: RowKey | null): string => (orderOf(k) == null ? (isLocal(k) ? branchOf(k) : `#${k}`) : `row ${orderOf(k)}`);

// the first key two rows of a stack share; a write refuses it, since a row is what a tab, an agent label and a finding point at
export function keyClash(stack: StackRow[]): RowKey | null {
  const seen = new Set<string>();
  for (const row of stack) {
    const key = rowKey(row);
    if (key == null) continue;
    if (seen.has(String(key))) return key;
    seen.add(String(key));
  }
  return null;
}

// a key from before a row got its PR or lost its branch (an agent's labels, an old tab): the key that row reads as today
export const currentKey = (work: Pick<Work, 'stack'> | null | undefined, key: RowKey): RowKey => {
  const stack = work?.stack || [];
  if (stack.some((s) => rowKey(s) === key)) return key;
  const branch = branchOf(key);
  const row = branch ? stack.find((s) => s.planned?.branch === branch) : undefined;
  return row ? rowKey(row) ?? key : key;
};

// work, row index and parent row of a key; a local key is looked up across works, live ones first
export function findRow(works: Pick<Works, 'get' | 'list'>, key: RowKey | null, slug?: string): { work: Work; index: number; row: StackRow; parent: StackRow | null } | null {
  const one = slug ? works.get(slug) : undefined;
  const pool = slug ? (one ? [one] : []) : works.list().sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)));
  for (const work of pool) {
    const stack = work.stack || [];
    const index = stack.findIndex((s) => rowKey(s) === key);
    if (index >= 0) return { work, index, row: stack[index], parent: stack[index - 1] || null };
  }
  return null;
}
