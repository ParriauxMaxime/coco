import { create } from 'zustand';

export type Shell = 'A' | 'B' | 'C';
export type Prefs = {
  workbench: 'on' | 'off';
  shell: Shell;
  details: 'inspector' | 'tab';
  planned: 'fold' | 'all';
  questions: 'inline' | 'tab';
  preset: 'last' | 'plan' | 'review';
  narrow: 'drop' | 'keep';
};
export type PrefKey = keyof Prefs;

export const CHOICES: { key: PrefKey; label: string; options: { value: string; label: string; rec?: boolean }[] }[] = [
  { key: 'shell', label: 'Shell', options: [{ value: 'A', label: 'A · activity bar', rec: true }, { value: 'B', label: 'B · sidebar' }, { value: 'C', label: 'C · rail' }] },
  { key: 'details', label: 'PR details', options: [{ value: 'inspector', label: 'Inspector', rec: true }, { value: 'tab', label: 'Tab' }] },
  { key: 'planned', label: 'Planned PRs', options: [{ value: 'fold', label: 'Next 2 + fold', rec: true }, { value: 'all', label: 'All rows' }] },
  { key: 'questions', label: 'Agent questions', options: [{ value: 'inline', label: 'Inline + status bar', rec: true }, { value: 'tab', label: 'Own tab' }] },
  { key: 'preset', label: 'Opens in', options: [{ value: 'last', label: 'Last used', rec: true }, { value: 'plan', label: 'Plan preset' }, { value: 'review', label: 'Review preset' }] },
  { key: 'narrow', label: 'Narrow stack', options: [{ value: 'drop', label: 'Drop columns', rec: true }, { value: 'keep', label: 'Keep all' }] },
];

const KEY = 'cc.design-preview';
const WORKBENCH_KEY = 'cc.beta.workbench';
const DEFAULTS: Prefs = { workbench: 'on', shell: 'A', details: 'inspector', planned: 'fold', questions: 'inline', preset: 'last', narrow: 'drop' };

const read = (): Prefs => {
  try {
    const workbench = localStorage.getItem(WORKBENCH_KEY) === 'off' ? 'off' : 'on';
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}'), workbench };
  } catch { return DEFAULTS; }
};

export const usePrefs = create<Prefs & { set: (key: PrefKey, value: string) => void }>()((set, get) => ({
  ...read(),
  set: (key, value) => {
    set({ [key]: value });
    const { set: _, workbench, ...prefs } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
      localStorage.setItem(WORKBENCH_KEY, workbench);
    } catch {}
  },
}));

export const workHref = (slug: string) => (usePrefs.getState().workbench === 'on' ? `#/work/${slug}` : `#/design-preview/${slug}`);

export const useBetaPanel = create<{ open: boolean; toggle: () => void; close: () => void }>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
}));

addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); useBetaPanel.getState().toggle(); }
});
