// Shared by the server (notes bullet, timeline) and the Decisions tab (copy as markdown).
// A card with `rows` is a table of sub-decisions: its `options` are the columns, `choice` maps each row key to an option key.

import type { Block, Source } from './blocks.ts';

export interface DecisionRow {
  key: string;
  label: string;
}

export interface DecisionOption {
  key: string;
  label: string;
}

export interface Decision {
  id: string;
  title: string;
  status?: string;
  question?: string;
  options: DecisionOption[];
  rows?: DecisionRow[];
  choice?: string | Record<string, string> | null;
  rationale?: string;
  decidedAt?: string | null;
  archivedAt?: string | null;
  pr?: string | number | null;
  sha?: string;
  summary?: string | null;
  blocks?: Block[] | null;
  sources?: Source[];
  details?: string;
}

type Card = Pick<Decision, 'options' | 'rows' | 'choice'>;

const choiceOf = (d: Card, key: string): string | undefined => (d.choice && typeof d.choice === 'object' ? d.choice[key] : undefined);

// an archived card (overtaken by later work) leaves counts, briefs and the review feed; the Decisions tab still lists it under "archived"
export const isLive = (d: Pick<Decision, 'archivedAt'>) => !d.archivedAt;

const optionLabel = (d: Card, key: unknown) => d.options.find((o) => o.key === key)?.label || key;

const isChoiceMap = (v: unknown): v is Record<string, string> => Boolean(v) && typeof v === 'object';

export const validChoice = (d: Card, choice: unknown): boolean =>
  d.rows ? isChoiceMap(choice) && d.rows.every((r) => d.options.some((o) => o.key === choice[r.key])) : d.options.some((o) => o.key === choice);

export const decisionSummary = (d: Card) => {
  if (!d.rows) return optionLabel(d, d.choice);
  const rows = d.rows;
  return d.options.map((o): [string, number] => [o.label, rows.filter((r) => choiceOf(d, r.key) === o.key).length]).filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join(' · ');
};

// a rationale over several lines goes indented under the bullet so its markdown stays inside the list item
export const decisionBullet = (d: Card & Pick<Decision, 'title' | 'rationale'>) => {
  const head = d.rows ? `- ${d.title}` : `- ${d.title}: ${optionLabel(d, d.choice)}`;
  if (!d.rows && d.rationale && !d.rationale.includes('\n')) return `${head} (${d.rationale})`;
  const rows = (d.rows || []).map((r) => `  - ${r.label}: ${optionLabel(d, choiceOf(d, r.key))}`);
  return [head, ...(d.rationale ? [d.rationale.replace(/^/gm, '  ')] : []), ...rows].join('\n');
};
