// Stack row keys: a PR number, or `b:<branch with / as :>` for a local branch not pushed as a PR yet.
const LOCAL = /^b:[\w][\w.:-]*$/;
const BRANCH = /^[\w][\w./-]*$/;

export const rowKey = (row) => (row?.number ? row.number : BRANCH.test(row?.planned?.branch || '') ? `b:${row.planned.branch.replaceAll('/', ':')}` : null);
export const parseKey = (k) => (/^\d+$/.test(String(k)) ? Number(k) : LOCAL.test(String(k)) ? String(k) : null);
export const isLocal = (k) => typeof k === 'string' && LOCAL.test(k);
export const branchOf = (k) => String(k).slice(2).replaceAll(':', '/');
export const fileKey = (k) => String(k).replaceAll(':', '~');
export const keyLabel = (k) => (isLocal(k) ? branchOf(k) : `#${k}`);

// work, row index and parent row of a key; a local key is looked up across works, live ones first
export function findRow(works, key, slug) {
  const pool = slug ? [works.get(slug)].filter(Boolean) : works.list().sort((a, b) => Boolean(a.archived) - Boolean(b.archived));
  for (const work of pool) {
    const stack = work.stack || [];
    const index = stack.findIndex((s) => rowKey(s) === key);
    if (index >= 0) return { work, index, row: stack[index], parent: stack[index - 1] || null };
  }
  return null;
}
