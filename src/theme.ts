import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
type ThemeState = { mode: ThemeMode; resolved: ResolvedTheme };

const KEY = 'cc.theme';
const MODES: ThemeMode[] = ['system', 'light', 'dark'];
const mq = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

const isMode = (m: string | null): m is ThemeMode => MODES.some((x) => x === m);
const readMode = (): ThemeMode => {
  try { const m = localStorage.getItem(KEY); return isMode(m) ? m : 'system'; } catch { return 'system'; }
};
const resolve = (mode: ThemeMode): ResolvedTheme => (mode === 'system' ? (mq.matches ? 'dark' : 'light') : mode);

let state: ThemeState = { mode: readMode(), resolved: resolve(readMode()) };

const apply = () => {
  const resolved = resolve(state.mode);
  document.documentElement.dataset.theme = resolved;
  state = { mode: state.mode, resolved };
  listeners.forEach((l) => l());
};

export const setThemeMode = (mode: ThemeMode) => {
  try { localStorage.setItem(KEY, mode); } catch {}
  state = { ...state, mode };
  apply();
};
export const cycleTheme = () => setThemeMode(MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]);

mq.addEventListener('change', () => { if (state.mode === 'system') apply(); });
addEventListener('storage', (e) => { if (e.key === KEY) { state = { ...state, mode: readMode() }; apply(); } });
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); cycleTheme(); }
});
document.documentElement.dataset.theme = state.resolved;

const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const getTheme = () => state;
export const useTheme = () => useSyncExternalStore(subscribe, getTheme);
export const onThemeChange = (cb: (theme: ResolvedTheme) => void) => {
  let last = state.resolved;
  const l = () => { if (state.resolved !== last) { last = state.resolved; cb(last); } };
  listeners.add(l);
  return () => { listeners.delete(l); };
};
