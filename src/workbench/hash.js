import { useWorkbench } from './workbench-store.js';

const TAB = /^(plan|artifacts|ask|timeline|notes|decisions|findings|rules|pr-\d+|artifact-.+|diff-.+|file-.+|review-.+|findings-.+|brief-.+|agent-.+|stack-.+)$/;
const PANE = /^(ask|artifacts|timeline|notes|pr-\d+|artifact-.+)$/;
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export const toHash = (slug, tabId, max) => `#/work/${slug}/${encodeURIComponent(tabId)}${max ? '/max' : ''}`;

export function parseHash(hash) {
  const [root, slug, t, x] = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(dec);
  if (root !== 'work' || !slug || slug === 'new') return null;
  if (t === 'plan' && PANE.test(x || '')) return { slug, legacy: x };
  if (!TAB.test(t || '')) return { slug };
  return { slug, tabId: t, max: x === 'max' };
}

const focusedTab = (s) => s.groups.find((g) => g.id === s.focused)?.active || 'plan';
const allTabs = (s) => s.groups.flatMap((g) => g.tabs);

export function startHashSync(slug) {
  const store = useWorkbench;
  let applying = false;
  const write = (s, push) => {
    const h = parseHash(location.hash);
    const tab = focusedTab(s);
    if (!h || h.slug !== slug || (h.tabId === tab && Boolean(h.max) === s.max)) return;
    history[push ? 'pushState' : 'replaceState'](null, '', toHash(slug, tab, s.max));
  };
  const apply = () => {
    const h = parseHash(location.hash);
    if (!h || h.slug !== slug) return;
    applying = true;
    const s = store.getState();
    if (h.legacy) s.replaceLayout(['plan'], [h.legacy], 2);
    else if (h.tabId) {
      if (allTabs(s).includes(h.tabId)) s.activate(h.tabId); else s.open(h.tabId);
      s.setMax(h.max);
    }
    applying = false;
    write(store.getState(), false);
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.slug !== slug || applying) return;
    write(s, prev.slug === s.slug && !allTabs(prev).includes(focusedTab(s)));
  });
  addEventListener('hashchange', apply);
  addEventListener('popstate', apply);
  apply();
  return () => { unsub(); removeEventListener('hashchange', apply); removeEventListener('popstate', apply); };
}
