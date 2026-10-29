// Stack row keys: a PR number, or `b:<branch with / as :>` for a local branch not pushed as a PR yet.
import type { RowKey, StackRow, Work, Works } from './core-types.ts';

const LOCAL = /^b:[\w][\w.:-]*$/;
const BRANCH = /^[\w][\w./-]*$/;

export const rowKey = (row: StackRow | null | undefined): RowKey | null => (row?.number ? row.number : BRANCH.test(row?.planned?.branch || '') ? `b:${row?.planned?.branch?.replaceAll('/', ':')}` : null);
// takes a key as agents write it too: "#12", "b:feat/x"
export const parseKey = (k: unknown): RowKey | null => {
  const s = String(k).replace(/^#/, '').replaceAll('/', ':');
  return /^\d+$/.test(s) ? Number(s) : LOCAL.test(s) ? s : null;
};
export const isLocal = (k: unknown): k is `b:${string}` => typeof k === 'string' && LOCAL.test(k);
export const branchOf = (k: RowKey): string => String(k).slice(2).replaceAll(':', '/');
export const fileKey = (k: unknown): string => String(k).replaceAll(':', '~');
export const keyLabel = (k: RowKey | null): string => (isLocal(k) ? branchOf(k) : `#${k}`);

// a branch key of a row that since got its PR (an agent's labels, an old tab): the row's number
export const currentKey = (work: Pick<Work, 'stack'> | null | undefined, key: RowKey): RowKey => {
  const stack = work?.stack || [];
  if (!isLocal(key) || stack.some((s) => rowKey(s) === key)) return key;
  return stack.find((s) => s.number && s.planned?.branch === branchOf(key))?.number ?? key;
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
