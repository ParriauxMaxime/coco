import { create } from 'zustand';

export type Shell = 'A' | 'B' | 'C';
export type Prefs = {
  shell: Shell;
  details: 'inspector' | 'tab';
  planned: 'fold' | 'all';
  questions: 'inline' | 'tab';
  narrow: 'drop' | 'keep';
};
export type PrefKey = keyof Prefs;

export const CHOICES: { key: PrefKey; label: string; options: { value: string; label: string; rec?: boolean }[] }[] = [
  { key: 'shell', label: 'Shell', options: [{ value: 'A', label: 'A · activity bar', rec: true }, { value: 'B', label: 'B · sidebar' }, { value: 'C', label: 'C · rail' }] },
  { key: 'details', label: 'PR details', options: [{ value: 'inspector', label: 'Inspector', rec: true }, { value: 'tab', label: 'Tab' }] },
  { key: 'planned', label: 'Planned PRs', options: [{ value: 'fold', label: 'Next 2 + fold', rec: true }, { value: 'all', label: 'All rows' }] },
  { key: 'questions', label: 'Agent questions', options: [{ value: 'inline', label: 'Inline + status bar', rec: true }, { value: 'tab', label: 'Own tab' }] },
  { key: 'narrow', label: 'Narrow stack', options: [{ value: 'drop', label: 'Drop columns', rec: true }, { value: 'keep', label: 'Keep all' }] },
];

const KEY = 'cc.design-preview';
const DEFAULTS: Prefs = { shell: 'A', details: 'inspector', planned: 'fold', questions: 'inline', narrow: 'drop' };

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

export const useBetaPanel = create<{ open: boolean; toggle: () => void; close: () => void }>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); useBetaPanel.getState().toggle(); }
});
