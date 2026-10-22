import { create } from 'zustand';

const key = (slug) => `cc.wb.${slug}`;
const group = (id, tabs = [], active = tabs.at(-1) ?? null) => ({ type: 'group', id, tabs, active, preview: null });
const split = (dir, children, sizes) => ({ type: 'split', dir, children, sizes: sizes || children.map(() => 1 / children.length) });
const base = (slug) => ({ slug, layout: group(1, ['plan']), groups: [], focused: 1, max: false, nextId: 2, title: '', drag: null });

const leaves = (node, out = []) => { if (node.type === 'group') out.push(node); else node.children.forEach((c) => leaves(c, out)); return out; };
const mapGroups = (node, f) => (node.type === 'group' ? f(node) : { ...node, children: node.children.map((c) => mapGroups(c, f)) });
const patch = (layout, id, f) => mapGroups(layout, (g) => (g.id === id ? { ...g, ...f(g) } : g));
const setAt = (node, path, f) => (path.length ? { ...node, children: node.children.map((c, i) => (i === path[0] ? setAt(c, path.slice(1), f) : c)) } : f(node));
const owner = (s, tabId) => s.groups.find((g) => g.tabs.includes(tabId));
const without = (g, tabId) => {
  const tabs = g.tabs.filter((t) => t !== tabId);
  const active = g.active === tabId ? tabs[Math.max(0, g.tabs.indexOf(tabId) - 1)] ?? null : g.active;
  return { tabs, active, preview: g.preview === tabId ? null : g.preview };
};
const dirOf = (edge) => (edge === 'left' || edge === 'right' ? 'row' : 'col');
const splitAt = (node, id, edge, g) => {
  if (node.type === 'group') return node.id === id ? split(dirOf(edge), edge === 'left' || edge === 'top' ? [g, node] : [node, g]) : node;
  return { ...node, children: node.children.map((c) => splitAt(c, id, edge, g)) };
};

// drop empty groups, collapse single-child splits, flatten same-direction nesting, renormalize sizes
const prune = (node) => {
  if (node.type === 'group') return node.tabs.length ? { ...node, active: node.tabs.includes(node.active) ? node.active : node.tabs.at(-1), preview: node.tabs.includes(node.preview) ? node.preview : null } : null;
  const kept = [];
  node.children.forEach((c, i) => { const p = prune(c); if (p) kept.push([p, node.sizes[i] > 0 ? node.sizes[i] : 1]); });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0][0];
  const children = [];
  const sizes = [];
  kept.forEach(([c, size]) => {
    if (c.type === 'split' && c.dir === node.dir) c.children.forEach((cc, j) => { children.push(cc); sizes.push(size * c.sizes[j]); });
    else { children.push(c); sizes.push(size); }
  });
  const total = sizes.reduce((a, b) => a + b, 0);
  return split(node.dir, children, sizes.map((n) => n / total));
};

const fix = (s) => {
  const layout = prune(s.layout) || group(1, ['plan']);
  const groups = leaves(layout);
  const nextId = Math.max(s.nextId || 1, ...groups.map((g) => g.id + 1));
  return { ...s, layout, groups, nextId, focused: groups.some((g) => g.id === s.focused) ? s.focused : groups[0].id };
};

const save = (s) => {
  try { localStorage.setItem(key(s.slug), JSON.stringify({ layout: s.layout, focused: s.focused, max: s.max, nextId: s.nextId })); } catch {}
};

const clean = (node, seen, ids) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'split' && Array.isArray(node.children)) {
    const kept = node.children.map((c, i) => [clean(c, seen, ids), node.sizes?.[i]]).filter(([c]) => c);
    const sizes = kept.map(([, n]) => n);
    return split(node.dir === 'col' ? 'col' : 'row', kept.map(([c]) => c), sizes.every((n) => n > 0) ? sizes : undefined);
  }
  const id = Number(node.id);
  if (!Number.isInteger(id) || id < 1 || ids.has(id)) return null;
  ids.add(id);
  const tabs = (node.tabs || []).filter((t) => typeof t === 'string' && !seen.has(t) && seen.add(t));
  return { ...group(id, tabs, node.active), preview: node.preview ?? null };
};

const restore = (slug) => {
  try {
    const raw = JSON.parse(localStorage.getItem(key(slug)));
    const seen = new Set();
    const ids = new Set();
    let layout;
    if (raw.layout) layout = clean(raw.layout, seen, ids);
    else {
      const groups = (raw.groups || []).slice(0, 2).map((g, i) => clean({ ...g, id: i + 1 }, seen, ids)).filter(Boolean);
      const sizes = Array.isArray(raw.sizes) && raw.sizes.length === 2 && raw.sizes.every((n) => n > 0) ? raw.sizes : undefined;
      layout = groups.length > 1 ? split('row', groups, sizes) : groups[0];
    }
    return fix({ ...base(slug), layout: layout || group(1, []), focused: raw.focused, max: Boolean(raw.max), nextId: raw.nextId });
  } catch { return fix(base(slug)); }
};

export const useWorkbench = create((set, get) => {
  const upd = (f) => { const next = fix({ ...get(), ...f(get()) }); set(next); save(next); };
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
    resize: (path, sizes) => upd((s) => ({ layout: setAt(s.layout, path, (n) => ({ ...n, sizes })) })),
    replaceLayout: (first, second, focused) => upd(() => ({
      layout: second.length ? split('row', [group(1, first), group(2, second)]) : group(1, first),
      nextId: 3,
      focused,
    })),
    setDrag: (drag) => set({ drag }),
    setTitle: (title) => get().title !== title && set({ title }),
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

export const layoutRects = (node, box, path = [], out = { groups: [], handles: [] }) => {
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
