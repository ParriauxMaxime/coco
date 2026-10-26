import { create } from 'zustand';
import { useWorkbench } from '../workbench/workbench-store.ts';
import type { LayoutNode } from '../workbench/types.ts';

export type SavedLayout = { id: string; name: string; layout: LayoutNode; focused: number; builtin?: boolean };

const pair = (first: string[], second: string[], active: [string, string]): LayoutNode => ({
  type: 'split',
  dir: 'row',
  sizes: [0.55, 0.45],
  children: [
    { type: 'group', id: 1, tabs: first, active: active[0], preview: null },
    { type: 'group', id: 2, tabs: second, active: active[1], preview: null },
  ],
});

export const BUILTIN: SavedLayout[] = [
  { id: 'plan', name: 'Plan', layout: pair(['plan', 'stack'], ['ask', 'decisions'], ['plan', 'ask']), focused: 1, builtin: true },
  { id: 'review', name: 'Review', layout: pair(['stack', 'plan'], ['findings', 'ask'], ['stack', 'findings']), focused: 1, builtin: true },
];

const key = (slug: string) => `cc.dp.layouts.${slug}`;
const read = (slug: string): SavedLayout[] => {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key(slug)) || '[]');
    return Array.isArray(list) ? list.filter((l): l is SavedLayout => typeof l?.name === 'string' && typeof l?.layout === 'object') : [];
  } catch { return []; }
};
const write = (slug: string, list: SavedLayout[]) => { try { localStorage.setItem(key(slug), JSON.stringify(list)); } catch {} };

// what a layout shows, sizes and the focused pane aside: two layouts with the same panes and tabs are the same layout
const shape = (node: LayoutNode): string => (node.type === 'group' ? `[${node.tabs.join(',')}|${node.active}]` : `${node.dir}(${node.children.map(shape).join(' ')})`);

type State = {
  bySlug: Record<string, SavedLayout[]>;
  load: (slug: string) => void;
  save: (slug: string, name: string) => void;
  update: (slug: string, id: string) => void;
  rename: (slug: string, id: string, name: string) => void;
  remove: (slug: string, id: string) => void;
};

export const useLayouts = create<State>()((set, get) => {
  const saved = (slug: string) => get().bySlug[slug] ?? read(slug);
  const put = (slug: string, list: SavedLayout[]) => { write(slug, list); set((s) => ({ bySlug: { ...s.bySlug, [slug]: list } })); };
  const current = () => { const s = useWorkbench.getState(); return { layout: s.layout, focused: s.focused }; };
  return {
    bySlug: {},
    load: (slug) => { if (!get().bySlug[slug]) set((s) => ({ bySlug: { ...s.bySlug, [slug]: read(slug) } })); },
    save: (slug, name) => put(slug, [...saved(slug), { id: Math.random().toString(36).slice(2, 10), name, ...current() }]),
    update: (slug, id) => put(slug, saved(slug).map((l) => (l.id === id ? { ...l, ...current() } : l))),
    rename: (slug, id, name) => put(slug, saved(slug).map((l) => (l.id === id ? { ...l, name } : l))),
    remove: (slug, id) => put(slug, saved(slug).filter((l) => l.id !== id)),
  };
});

export const applyLayout = (l: SavedLayout) => useWorkbench.getState().setLayout(l.layout, l.focused);
export const matching = (list: SavedLayout[], layout: LayoutNode) => list.find((l) => shape(l.layout) === shape(layout)) || null;
