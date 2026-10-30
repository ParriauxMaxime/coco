import type { ModelEntry } from '../../types.ts';

export type MarkName = 'whale' | 'claude' | 'openai' | 'gemini' | 'apple';

type Named = Pick<ModelEntry, 'id' | 'label'>;

const LONG = /\[1m\]|\b1m\b/i;
export const isLongContext = (m: Named) => LONG.test(m.id) || LONG.test(m.label);
const bare = (id: string) => id.replace(/\[1m\]/gi, '');
export const familyOf = (id: string) => bare(id).replace(/[-.]?\d+(?:[-.]\d+)*/g, '').replace(/-+$/, '');
export const versionOf = (id: string) => (bare(id).match(/\d+/g) ?? []).map(Number);
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d > 0;
  }
  return false;
};

// the newest release of each family in the provider's order, without the 1M-context variants; keep: ids listed anyway
export function latestModels<T extends Named>(models: T[], keep: string[] = []): T[] {
  const best = new Map<string, T>();
  for (const m of models) {
    if (isLongContext(m)) continue;
    const family = familyOf(m.id);
    const seen = best.get(family);
    if (!seen || newer(versionOf(m.id), versionOf(seen.id))) best.set(family, m);
  }
  const latest = new Set(best.values());
  return models.filter((m) => latest.has(m) || keep.includes(m.id));
}

const MARKS: [RegExp, MarkName][] = [
  [/deepseek/i, 'whale'],
  [/claude|opus|sonnet|haiku|fable|anthropic/i, 'claude'],
  [/gpt|codex|openai|(^|\W)o\d/i, 'openai'],
  [/gemini|gemma|google/i, 'gemini'],
  [/apple|afm/i, 'apple'],
];
// the mark of the maker a model id or provider label names, if it names one
export const makerMark = (id: string, label: string | null = '') => MARKS.find(([re]) => re.test(`${id} ${label}`))?.[1] ?? null;
// the mark a model row shows: the maker's, a plain chip when nothing says
export const modelMark = (id: string, label: string | null = ''): MarkName | 'cpu' => makerMark(id, label) ?? 'cpu';
