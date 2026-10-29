import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { NavMode } from './nav/nav.ts';

export type Shell = 'A' | 'B' | 'C';
export type Prefs = {
  nav: NavMode;
  shell: Shell;
  details: 'inspector' | 'tab';
  planned: 'fold' | 'all';
  questions: 'inline' | 'tab';
  narrow: 'drop' | 'keep';
  avatar: 'rounded' | 'circle';
};
export type PrefKey = keyof Prefs;

export const NAV_MODES: { value: NavMode; label: string; hint: string }[] = [
  { value: 'classic', label: 'Classic', hint: "Today's pages, unchanged" },
  { value: 'drill', label: 'Drill', hint: 'One summary row per item; opening one replaces the view, a breadcrumb leads back' },
  { value: 'expand', label: 'Expand', hint: 'One summary row per item; its children open in place under it' },
  { value: 'columns', label: 'Columns', hint: 'Each level opens in a column to the right of the last, like Finder' },
];

export const CHOICES: { key: PrefKey; label: string; options: { value: string; label: string; rec?: boolean }[] }[] = [
  { key: 'nav', label: 'Navigation', options: NAV_MODES.map((m) => ({ value: m.value, label: m.label, rec: m.value === 'classic' })) },
  { key: 'shell', label: 'Shell', options: [{ value: 'A', label: 'A · activity bar', rec: true }, { value: 'B', label: 'B · sidebar' }, { value: 'C', label: 'C · rail' }] },
  { key: 'details', label: 'PR details', options: [{ value: 'inspector', label: 'Inspector', rec: true }, { value: 'tab', label: 'Tab' }] },
  { key: 'planned', label: 'Planned PRs', options: [{ value: 'fold', label: 'Next 2 + fold', rec: true }, { value: 'all', label: 'All rows' }] },
  { key: 'questions', label: 'Agent questions', options: [{ value: 'inline', label: 'Inline + status bar', rec: true }, { value: 'tab', label: 'Own tab' }] },
  { key: 'narrow', label: 'Narrow stack', options: [{ value: 'drop', label: 'Drop columns', rec: true }, { value: 'keep', label: 'Keep all' }] },
  { key: 'avatar', label: 'coco avatar', options: [{ value: 'rounded', label: 'Rounded', rec: true }, { value: 'circle', label: 'Circle' }] },
];

const KEY = 'cc.design-preview';
const DEFAULTS: Prefs = { nav: 'classic', shell: 'A', details: 'inspector', planned: 'fold', questions: 'inline', narrow: 'drop', avatar: 'rounded' };

const read = (): Prefs => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return DEFAULTS; }
};

export const usePrefs = create<Prefs & { set: (key: PrefKey, value: string) => void }>()((set, get) => ({
  ...read(),
  set: (key, value) => {
    set({ [key]: value });
    const { set: _, ...prefs } = get();
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
  },
}));

export const workHref = (slug: string) => `#/work/${slug}`;

const readList = (key: string): string[] => { try { const v: unknown = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
export const usePersistedList = (key: string, initial: (saved: string[]) => string[]) => {
  const [list, setList] = useState(() => initial(readList(key)));
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(list)); } catch {} }, [list]);
  const toggle = (s: string) => setList((l) => (l.includes(s) ? l.filter((x) => x !== s) : [...l, s]));
  return { list, toggle, set: setList };
};

// the last model and thinking picked in a composer, per kind of agent it starts (ask, thread, dispatch-<kind>)
export type ModelPickPref = { provider: string; thinking: string | null };
const PICKS = 'cc.model-picks';
const readPicks = (): Record<string, ModelPickPref> => {
  try { return JSON.parse(localStorage.getItem(PICKS) || '{}') || {}; } catch { return {}; }
};
export const useModelPicks = create<{ picks: Record<string, ModelPickPref>; remember: (kind: string, pick: ModelPickPref) => void }>()((set, get) => ({
  picks: readPicks(),
  remember: (kind, pick) => {
    const picks = { ...get().picks, [kind]: pick };
    set({ picks });
    try { localStorage.setItem(PICKS, JSON.stringify(picks)); } catch {}
  },
}));

// the model menu lists the newest model of each family; all: every model Paseo offers, 1M-context variants included
const ALL_MODELS = 'cc.model-all';
const readAll = () => {
  try { return localStorage.getItem(ALL_MODELS) === '1'; } catch { return false; }
};
export const useModelList = create<{ all: boolean; toggle: () => void }>()((set, get) => ({
  all: readAll(),
  toggle: () => {
    const all = !get().all;
    set({ all });
    try { localStorage.setItem(ALL_MODELS, all ? '1' : '0'); } catch {}
  },
}));

export const useBetaPanel = create<{ open: boolean; toggle: () => void; close: () => void }>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); useBetaPanel.getState().toggle(); }
});
