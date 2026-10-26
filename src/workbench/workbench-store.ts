import { create } from 'zustand';
import type { Edge, Group, LayoutNode, LayoutRects, PendingLine, Rect, Split } from './types.ts';

type Data = {
  slug: string;
  layout: LayoutNode;
  groups: Group[];
  focused: number;
  max: boolean;
  nextId: number;
  title: string;
  drag: string | null;
};
type OpenOptions = { group?: number; preview?: boolean; focus?: boolean };
type RawNode = { type?: string; id?: unknown; dir?: string; children?: RawNode[]; sizes?: number[]; tabs?: unknown[]; active?: string | null; preview?: string | null };
type Actions = {
  load: (slug: string) => void;
  open: (tabId: string, options?: OpenOptions) => void;
  close: (tabId: string) => void;
  activate: (tabId: string) => void;
  pin: (tabId: string) => void;
  moveTab: (tabId: string, to: number, index?: number | null) => void;
  splitWith: (tabId: string, target: number, edge: Edge) => void;
  moveToOtherGroup: (tabId: string) => void;
  focus: (id: number) => void;
  toggleMax: () => void;
  setMax: (max: boolean) => void;
  resize: (path: number[], sizes: number[]) => void;
  replaceLayout: (first: string[], second: string[], focused: number) => void;
  setLayout: (layout: LayoutNode, focused: number) => void;
  setDrag: (drag: string | null) => void;
  setTitle: (title: string) => void;
  pendingLine: Record<string, PendingLine>;
  setPendingLine: (tabId: string, line: number, side?: string) => void;
  takePendingLine: (tabId: string) => PendingLine | undefined;
  otherGroup: () => number;
};
export type WorkbenchState = Data & Actions;

const key = (slug: string) => `cc.wb.${slug}`;
const group = (id: number, tabs: string[] = [], active: string | null = tabs.at(-1) ?? null): Group => ({ type: 'group', id, tabs, active, preview: null });
const split = (dir: 'row' | 'col', children: LayoutNode[], sizes?: number[]): Split => ({ type: 'split', dir, children, sizes: sizes || children.map(() => 1 / children.length) });
const base = (slug: string): Data => ({ slug, layout: group(1, ['plan']), groups: [], focused: 1, max: false, nextId: 2, title: '', drag: null });

const leaves = (node: LayoutNode, out: Group[] = []): Group[] => { if (node.type === 'group') out.push(node); else node.children.forEach((c) => leaves(c, out)); return out; };
const mapGroups = (node: LayoutNode, f: (g: Group) => Group): LayoutNode => (node.type === 'group' ? f(node) : { ...node, children: node.children.map((c) => mapGroups(c, f)) });
const patch = (layout: LayoutNode, id: number, f: (g: Group) => Partial<Group>) => mapGroups(layout, (g) => (g.id === id ? { ...g, ...f(g) } : g));
const setAt = (node: LayoutNode, path: number[], f: (n: LayoutNode) => LayoutNode): LayoutNode => {
  if (!path.length) return f(node);
  if (node.type === 'group') return node;
  return { ...node, children: node.children.map((c, i) => (i === path[0] ? setAt(c, path.slice(1), f) : c)) };
};
const owner = (s: Data, tabId: string) => s.groups.find((g) => g.tabs.includes(tabId));
const without = (g: Group, tabId: string): Partial<Group> => {
  const tabs = g.tabs.filter((t) => t !== tabId);
  const active = g.active === tabId ? tabs[Math.max(0, g.tabs.indexOf(tabId) - 1)] ?? null : g.active;
  return { tabs, active, preview: g.preview === tabId ? null : g.preview };
};
const dirOf = (edge: Edge) => (edge === 'left' || edge === 'right' ? 'row' : 'col');
const splitAt = (node: LayoutNode, id: number, edge: Edge, g: Group): LayoutNode => {
  if (node.type === 'group') return node.id === id ? split(dirOf(edge), edge === 'left' || edge === 'top' ? [g, node] : [node, g]) : node;
  return { ...node, children: node.children.map((c) => splitAt(c, id, edge, g)) };
};

// drop empty groups, collapse single-child splits, flatten same-direction nesting, renormalize sizes
const prune = (node: LayoutNode): LayoutNode | null => {
  if (node.type === 'group') {
    if (!node.tabs.length) return null;
    return { ...node, active: node.active && node.tabs.includes(node.active) ? node.active : node.tabs.at(-1) ?? null, preview: node.preview && node.tabs.includes(node.preview) ? node.preview : null };
  }
  const kept: [LayoutNode, number][] = [];
  node.children.forEach((c, i) => { const p = prune(c); if (p) kept.push([p, node.sizes[i] > 0 ? node.sizes[i] : 1]); });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0][0];
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  kept.forEach(([c, size]) => {
    if (c.type === 'split' && c.dir === node.dir) c.children.forEach((cc, j) => { children.push(cc); sizes.push(size * c.sizes[j]); });
    else { children.push(c); sizes.push(size); }
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  return split(node.dir, children, sizes.map((n) => n / total));
};

const fix = (s: Data): Data => {
  const layout = prune(s.layout) || group(1, ['plan']);
  const groups = leaves(layout);
  const nextId = Math.max(s.nextId || 1, ...groups.map((g) => g.id + 1));
  return { ...s, layout, groups, nextId, focused: groups.some((g) => g.id === s.focused) ? s.focused : groups[0].id };
};

const save = (s: Data) => {
  try { localStorage.setItem(key(s.slug), JSON.stringify({ layout: s.layout, focused: s.focused, max: s.max, nextId: s.nextId })); } catch {}
};

const clean = (node: RawNode | null | undefined, seen: Set<string>, ids: Set<number>): LayoutNode | null => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'split' && Array.isArray(node.children)) {
    const kept = node.children.map((c, i): [LayoutNode | null, number | undefined] => [clean(c, seen, ids), node.sizes?.[i]]).filter((pair): pair is [LayoutNode, number | undefined] => pair[0] !== null);
    const sizes = kept.map(([, n]) => n);
    const numeric = sizes.filter((n): n is number => n !== undefined);
    return split(node.dir === 'col' ? 'col' : 'row', kept.map(([c]) => c), numeric.length === sizes.length && numeric.every((n) => n > 0) ? numeric : undefined);
  }
  const id = Number(node.id);
  if (!Number.isInteger(id) || id < 1 || ids.has(id)) return null;
  ids.add(id);
  const tabs = (node.tabs || []).filter((t): t is string => typeof t === 'string' && !seen.has(t) && Boolean(seen.add(t)));
  return { ...group(id, tabs, node.active), preview: node.preview ?? null };
};

const restore = (slug: string): Data => {
  try {
    const raw = JSON.parse(localStorage.getItem(key(slug)) ?? 'null');
    const seen = new Set<string>();
    const ids = new Set<number>();
    let layout: LayoutNode | null | undefined;
    if (raw.layout) layout = clean(raw.layout, seen, ids);
    else {
      const groups = (raw.groups || []).slice(0, 2).map((g: RawNode, i: number) => clean({ ...g, id: i + 1 }, seen, ids)).filter((g: LayoutNode | null): g is LayoutNode => g !== null);
      const sizes = Array.isArray(raw.sizes) && raw.sizes.length === 2 && raw.sizes.every((n: number) => n > 0) ? raw.sizes : undefined;
      layout = groups.length > 1 ? split('row', groups, sizes) : groups[0];
    }
    return fix({ ...base(slug), layout: layout || group(1, []), focused: raw.focused, max: Boolean(raw.max), nextId: raw.nextId });
  } catch { return fix(base(slug)); }
};

export const useWorkbench = create<WorkbenchState>()((set, get) => {
  const upd = (f: (s: WorkbenchState) => Partial<Data>) => { const next = fix({ ...get(), ...f(get()) }); set(next); save(next); };
  return {
    ...base(''),
    load: (slug) => set(restore(slug)),
    open: (tabId, { group: gid, preview = false, focus = true } = {}) => upd((s) => {
      const own = owner(s, tabId);
      if (own) return { layout: patch(s.layout, own.id, () => ({ active: tabId })), focused: focus ? own.id : s.focused };
      let { layout, nextId } = s;
      let target = gid ?? s.focused;
      if (!s.groups.some((g) => g.id === target)) { target = nextId++; layout = splitAt(layout, s.focused, 'right', group(target)); }
      layout = patch(layout, target, (g) => ({
        tabs: preview && g.preview ? g.tabs.map((t) => (t === g.preview ? tabId : t)) : [...g.tabs, tabId],
        active: tabId,
        preview: preview ? tabId : g.preview,
      }));
      return { layout, nextId, focused: focus ? target : s.focused };
    }),
    close: (tabId) => upd((s) => {
      const own = owner(s, tabId);
      if (!own || (tabId === 'plan' && s.groups.reduce((n, g) => n + g.tabs.length, 0) === 1)) return {};
      return { layout: patch(s.layout, own.id, (g) => without(g, tabId)) };
    }),
    activate: (tabId) => upd((s) => {
      const own = owner(s, tabId);
      return own ? { layout: patch(s.layout, own.id, () => ({ active: tabId })), focused: own.id } : {};
    }),
    pin: (tabId) => upd((s) => ({ layout: mapGroups(s.layout, (g) => (g.preview === tabId ? { ...g, preview: null } : g)) })),
    moveTab: (tabId, to, index) => upd((s) => {
      const own = owner(s, tabId);
      if (!own || !s.groups.some((g) => g.id === to)) return {};
      let layout = patch(s.layout, own.id, (g) => without(g, tabId));
      layout = patch(layout, to, (g) => {
        const tabs = [...g.tabs];
        const at = index == null ? tabs.length : Math.min(tabs.length, index - (own.id === to && own.tabs.indexOf(tabId) < index ? 1 : 0));
        tabs.splice(at, 0, tabId);
        return { tabs, active: tabId };
      });
      return { layout, focused: to };
    }),
    splitWith: (tabId, target, edge) => upd((s) => {
      const own = owner(s, tabId);
      if (!own || !s.groups.some((g) => g.id === target) || (own.id === target && own.tabs.length === 1)) return {};
      const id = s.nextId;
      const layout = splitAt(patch(s.layout, own.id, (g) => without(g, tabId)), target, edge, group(id, [tabId]));
      return { layout, nextId: id + 1, focused: id };
    }),
    moveToOtherGroup: (tabId) => {
      const s = get();
      const own = owner(s, tabId);
      if (!own) return;
      if (s.groups.length > 1) s.moveTab(tabId, s.groups[(s.groups.indexOf(own) + 1) % s.groups.length].id);
      else s.splitWith(tabId, own.id, 'right');
    },
    focus: (id) => upd((s) => (s.groups.some((g) => g.id === id) ? { focused: id } : {})),
    toggleMax: () => upd((s) => ({ max: !s.max })),
    setMax: (max) => upd(() => ({ max })),
    resize: (path, sizes) => upd((s) => ({ layout: setAt(s.layout, path, (n) => (n.type === 'split' ? { ...n, sizes } : n)) })),
    replaceLayout: (first, second, focused) => upd(() => ({
      layout: second.length ? split('row', [group(1, first), group(2, second)]) : group(1, first),
      nextId: 3,
      focused,
    })),
    setLayout: (layout, focused) => upd(() => ({ layout: clean(layout, new Set(), new Set()) || group(1, ['plan']), focused, max: false })),
    setDrag: (drag) => set({ drag }),
    setTitle: (title) => { if (get().title !== title) set({ title }); },
    pendingLine: {},
    setPendingLine: (tabId, line, side = 'head') => set((s) => ({ pendingLine: { ...s.pendingLine, [tabId]: { line, side } } })),
    takePendingLine: (tabId) => {
      const hit = get().pendingLine[tabId];
      if (hit) set((s) => { const { [tabId]: _, ...rest } = s.pendingLine; return { pendingLine: rest }; });
      return hit;
    },
    // next group in reading order; a fresh id when there is one group, which open() turns into a split to the right
    otherGroup: () => {
      const s = get();
      if (matchMedia('(max-width: 900px)').matches) return s.focused;
      if (s.groups.length < 2) return s.nextId;
      const i = s.groups.findIndex((g) => g.id === s.focused);
      return s.groups[(i + 1) % s.groups.length].id;
    },
  };
});

export const layoutRects = (node: LayoutNode, box: Rect, path: number[] = [], out: LayoutRects = { groups: [], handles: [] }): LayoutRects => {
  if (node.type === 'group') { out.groups.push({ id: node.id, ...box }); return out; }
  const row = node.dir === 'row';
  const H = 6;
  const n = node.children.length;
  const avail = Math.max(0, (row ? box.width : box.height) - H * (n - 1));
  let off = 0;
  node.children.forEach((c, i) => {
    const size = avail * node.sizes[i];
    layoutRects(c, row ? { left: box.left + off, top: box.top, width: size, height: box.height } : { left: box.left, top: box.top + off, width: box.width, height: size }, [...path, i], out);
    off += size;
    if (i < n - 1) {
      out.handles.push({ path, i, dir: node.dir, sizes: node.sizes, origin: (row ? box.left : box.top) + off - size, avail, left: row ? box.left + off : box.left, top: row ? box.top : box.top + off, width: row ? H : box.width, height: row ? box.height : H });
      off += H;
    }
  });
  return out;
};
