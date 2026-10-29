import { useWorkbench } from './workbench-store.ts';
import type { WorkbenchState } from './workbench-store.ts';
import { isNavSegment, navSegment, parseNavSegment } from '../preview/nav/nav.ts';
import type { NavPath } from '../preview/nav/nav.ts';
import { navPathOf, setNavPath, useNavPaths } from '../preview/nav/use-nav.ts';

const TAB = /^(plan|stack|waiting|artifacts|ask|timeline|notes|decisions|findings|rules|pr-\d+|artifact-.+|diff-.+|file-.+|review-.+|commit-.+|findings-.+|brief-.+|agent-.+|ag-.+|ask-.+|stack-.+|sub-.+|git-.+|gitcommit-.+|wsfile-.+|term-.+)$/;
const PANE = /^(ask|artifacts|timeline|notes|pr-\d+|artifact-.+)$/;
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export const toHash = (slug: string, tabId: string, max: boolean, nav: NavPath = []) => `#/work/${slug}/${encodeURIComponent(tabId)}${max ? '/max' : ''}${nav.length ? `/${navSegment(nav)}` : ''}`;

type ParsedHash = { slug: string; legacy?: string; tabId?: string; max?: boolean; finding?: string; nav?: NavPath };

// #/work/<slug>/<tabId>[/max][/f-<commentId>][/n-<key>~<key>]: the Findings tab opens with that finding selected; n- holds the levels a beta navigation mode opened
export function parseHash(hash: string): ParsedHash | null {
  const raw = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [root, slug, t, ...rest] = raw.map(dec);
  const x = rest[0];
  if (root !== 'work' || !slug || slug === 'new') return null;
  if (t === 'plan' && PANE.test(x || '')) return { slug, legacy: x };
  if (!TAB.test(t || '')) return { slug };
  return { slug, tabId: t, max: rest.includes('max'), finding: rest.find((p) => p.startsWith('f-'))?.slice(2), nav: parseNavSegment(raw.slice(3).find(isNavSegment)) };
}

const focusedTab = (s: WorkbenchState) => s.groups.find((g) => g.id === s.focused)?.active || 'plan';
const allTabs = (s: WorkbenchState) => s.groups.flatMap((g) => g.tabs);
const sameNav = (a: NavPath = [], b: NavPath = []) => navSegment(a) === navSegment(b);

export function startHashSync(slug: string) {
  const store = useWorkbench;
  let applying = false;
  const write = (s: WorkbenchState, push: boolean) => {
    const h = parseHash(location.hash);
    const tab = focusedTab(s);
    const nav = navPathOf(tab);
    if (!h || h.slug !== slug || (h.tabId === tab && Boolean(h.max) === s.max && sameNav(h.nav, nav))) return;
    history[push ? 'pushState' : 'replaceState'](null, '', toHash(slug, tab, s.max, nav));
  };
  const apply = () => {
    const h = parseHash(location.hash);
    if (!h || h.slug !== slug) return;
    applying = true;
    const s = store.getState();
    if (h.legacy) s.replaceLayout(['plan'], [h.legacy], 2);
    else if (h.tabId) {
      const other = h.tabId !== focusedTab(s);
      if (allTabs(s).includes(h.tabId)) s.activate(h.tabId); else s.open(h.tabId);
      // a link to another tab keeps a maximized pane maximized; on the same tab the hash's /max decides
      s.setMax(Boolean(h.max) || (other && s.max));
      setNavPath(h.tabId, h.nav ?? []);
    }
    applying = false;
    write(store.getState(), false);
  };
  const unsub = store.subscribe((s, prev) => {
    if (s.slug !== slug || applying) return;
    // a new tab is a step back walks over; on a phone, where one tab shows at a time, every tab change is
    const stepped = matchMedia('(max-width: 640px)').matches ? focusedTab(prev) !== focusedTab(s) : !allTabs(prev).includes(focusedTab(s));
    write(s, prev.slug === s.slug && stepped);
  });
  // a level opened or closed in the focused tab is a step back walks over
  const unsubNav = useNavPaths.subscribe((paths, prev) => {
    const s = store.getState();
    const tab = focusedTab(s);
    if (s.slug !== slug || applying || sameNav(paths[tab], prev[tab])) return;
    write(s, true);
  });
  addEventListener('hashchange', apply);
  addEventListener('popstate', apply);
  apply();
  return () => { unsub(); unsubNav(); removeEventListener('hashchange', apply); removeEventListener('popstate', apply); };
}
