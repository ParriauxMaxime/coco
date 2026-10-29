import { usePrefs } from './preview/prefs.ts';

// nav: the beta navigation mode a view was seen in, left out for Classic
type UiEvent = { at: string; t: 'view' | 'click'; hash: string; ms?: number; label?: string; cls?: string; nav?: string };

const queue: UiEvent[] = [];
const now = () => new Date().toISOString();

const flush = () => {
  if (!queue.length) return;
  const body = JSON.stringify(queue.splice(0));
  if (!navigator.sendBeacon?.('/api/ui-events', new Blob([body], { type: 'application/json' }))) {
    void fetch('/api/ui-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
};

const labelOf = (el: Element) =>
  (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);

// the workbench moves between tabs with history.replaceState, which fires no hashchange: the view is read on a tick
export function watchUsage() {
  let hash = location.hash || '#/';
  let since = performance.now();
  const leave = () => {
    const ms = Math.round(performance.now() - since);
    const nav = usePrefs.getState().nav;
    if (document.visibilityState === 'visible' && ms >= 500) queue.push({ at: now(), t: 'view', hash, ms, ...(nav === 'classic' ? {} : { nav }) });
    since = performance.now();
  };
  setInterval(() => {
    const next = location.hash || '#/';
    if (next === hash) return;
    leave();
    hash = next;
  }, 500);
  setInterval(flush, 15_000);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { leave(); flush(); } else since = performance.now();
  });
  addEventListener('click', (e) => {
    const el = (e.target as Element | null)?.closest?.('button, a, summary, [role=button], [role=tab], [role=menuitem], input[type=checkbox], input[type=radio]');
    if (!el) return;
    const cls = [...el.classList].filter((c) => c.startsWith('dp-')).slice(0, 3).join(' ');
    queue.push({ at: now(), t: 'click', hash: location.hash || '#/', label: labelOf(el), cls });
  }, { capture: true });
}
