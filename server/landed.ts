// Landed rows: a planned row shipped straight to the default branch, with no PR. Its agent or the owner says so, or git shows it.
import { HttpError } from './core-types.ts';
import { parseKey, rowKey } from './stack.ts';
import type { Landed, RunResult, StackRow, Work } from './core-types.ts';

export type Git = (args: string[]) => Promise<RunResult>;
export const SHA = /^[0-9a-f]{7,40}$/i;
// the mark agents put on a shipped row's title before rows could land
const SHIPPED = /^✓\s*/;

// a row by its planned order, its key (b:<branch>) or its branch; a branch two rows share needs the order
export function landedRow(stack: StackRow[], ref: unknown): StackRow {
  const s = String(ref ?? '').trim();
  const rows = /^\d+$/.test(s) ? stack.filter((r) => r.planned?.order === Number(s)) : s.startsWith('b:') ? stack.filter((r) => rowKey(r) === parseKey(s)) : stack.filter((r) => r.planned?.branch === s);
  if (!rows.length) throw new HttpError(404, `no row ${s || '(none)'} in this work: pass its order or branch`);
  if (rows.length > 1) throw new HttpError(409, `${rows.length} rows on ${s}: pass the order`);
  return rows[0];
}

// a commit's full sha and date, when the repo has it
export async function commitOf(git: Git, rev: string): Promise<Omit<Landed, 'by'> | null> {
  const r = await git(['log', '-1', '--format=%H %cI', `${rev}^{commit}`, '--']);
  const [sha, at] = r.ok ? r.stdout.trim().split(' ') : [];
  return sha && at ? { sha, at } : null;
}

export const onBase = async (git: Git, sha: string, base: string) => (await git(['merge-base', '--is-ancestor', sha, `refs/heads/${base}`])).ok;

// a branch landed when it moved since it was created (its oldest reflog entry) and its tip sits on the base branch
export async function landedTip(git: Git, branch: string, base: string): Promise<Omit<Landed, 'by'> | null> {
  if (branch === base) return null;
  const tip = await commitOf(git, `refs/heads/${branch}`);
  if (!tip || !(await onBase(git, tip.sha, base))) return null;
  const created = (await git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`])).stdout.trim().split('\n').at(-1);
  return created && created !== tip.sha ? tip : null;
}

// one-time, idempotent: a row whose title an agent marked "✓ " by hand loses the mark and lands, at its branch tip when that landed, else the base tip
export async function backfillLanded(store: { list(): Work[]; save(work: Work, opts?: { touch?: boolean }): unknown }, gitOf: (work: Work) => { git: Git; base: string }) {
  const done: { slug: string; rows: number }[] = [];
  for (const work of store.list()) {
    const rows = (work.stack || []).filter((s) => !s.number && SHIPPED.test(s.planned?.title || ''));
    if (!rows.length) continue;
    const { git, base } = gitOf(work);
    const tip = await commitOf(git, `refs/heads/${base}`);
    if (!tip) continue;
    for (const s of rows) {
      const branch = s.planned?.branch;
      s.planned = { ...s.planned, title: s.planned?.title?.replace(SHIPPED, '') };
      s.landed ??= { ...((branch && (await landedTip(git, branch, base))) || tip), by: 'owner' };
    }
    store.save(work, { touch: false });
    done.push({ slug: work.slug, rows: rows.length });
  }
  return done;
}
