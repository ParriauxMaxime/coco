import { useWorkbench } from './workbench-store.ts';
import type { WorkbenchState } from './workbench-store.ts';

const TAB = /^(plan|stack|waiting|artifacts|ask|timeline|notes|decisions|findings|rules|pr-\d+|artifact-.+|diff-.+|file-.+|review-.+|commit-.+|findings-.+|brief-.+|agent-.+|ag-.+|ask-.+|stack-.+|sub-.+)$/;
const PANE = /^(ask|artifacts|timeline|notes|pr-\d+|artifact-.+)$/;
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export const toHash = (slug: string, tabId: string, max: boolean) => `#/work/${slug}/${encodeURIComponent(tabId)}${max ? '/max' : ''}`;

type ParsedHash = { slug: string; legacy?: string; tabId?: string; max?: boolean; finding?: string };

// #/work/<slug>/<tabId>[/max][/f-<commentId>]: the Findings tab opens with that finding selected
export function parseHash(hash: string): ParsedHash | null {
  const [root, slug, t, ...rest] = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(dec);
  const x = rest[0];
  if (root !== 'work' || !slug || slug === 'new') return null;
  if (t === 'plan' && PANE.test(x || '')) return { slug, legacy: x };
  if (!TAB.test(t || '')) return { slug };
  return { slug, tabId: t, max: rest.includes('max'), finding: rest.find((p) => p.startsWith('f-'))?.slice(2) };
}

const focusedTab = (s: WorkbenchState) => s.groups.find((g) => g.id === s.focused)?.active || 'plan';
const allTabs = (s: WorkbenchState) => s.groups.flatMap((g) => g.tabs);

export function startHashSync(slug: string) {
  const store = useWorkbench;
  let applying = false;
  const write = (s: WorkbenchState, push: boolean) => {
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
      s.setMax(Boolean(h.max));
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
