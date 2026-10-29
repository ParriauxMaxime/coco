// What the sidebar shows of a work without opening it: its stack rows from the last GitHub snapshot, and how many decisions are open.
import { rowKey } from './stack.ts';
import type { Work } from './core-types.ts';

export type PrSnap = { title?: string; state?: string; isDraft?: boolean; reviewDecision?: string | null; ci?: string };
export type SummaryState = 'planned' | 'landed' | 'merged' | 'closed' | 'draft' | 'review' | 'approved' | 'changes';
export type SummaryRow = { key: string; number: number | null; title: string; state: SummaryState; ci: string | null };

const stateOf = (st: PrSnap | undefined): SummaryState => {
  if (st?.state === 'MERGED') return 'merged';
  if (st?.state === 'CLOSED') return 'closed';
  if (st?.isDraft) return 'draft';
  if (st?.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  return st?.reviewDecision === 'APPROVED' ? 'approved' : 'review';
};

// a PR's title once a refresh saw it, else the planned title, else its number or branch
export function summaryRows(w: Work, snap: Record<string, PrSnap>): SummaryRow[] {
  return (w.stack || []).flatMap((s) => {
    const key = rowKey(s);
    if (key === null) return [];
    const st = s.number ? snap[s.number] : undefined;
    const state = s.number ? stateOf(st) : s.landed ? 'landed' : 'planned';
    return [{ key: String(key), number: s.number ?? null, title: st?.title || s.planned?.title || (s.number ? `#${s.number}` : s.planned?.branch || ''), state, ci: st?.ci && st.ci !== 'none' ? st.ci : null }];
  });
}

export const openDecisions = (w: Work) => (w.decisions || []).filter((x) => !x.decidedAt && !x.choice && !x.archivedAt).length;
