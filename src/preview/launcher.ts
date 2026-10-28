// The New agent launcher (#/agents/new): where it opens from, the place it last started in, and a message handed to it (a flagged coco issue).
import { create } from 'zustand';
import type { NewAgentPlace } from '../types.ts';

const LAST = 'cc.newagent';
// place: the id of the last place; modes: the last mode per provider family (absent: its default)
type Last = { place?: string; modes?: Record<string, string | null> };

export const readLast = (): Last => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LAST) || '{}');
    return v && typeof v === 'object' ? (v as Last) : {};
  } catch {
    return {};
  }
};
export const keepLast = (patch: Last) => {
  try {
    const last = readLast();
    localStorage.setItem(LAST, JSON.stringify({ ...last, ...patch, modes: { ...last.modes, ...patch.modes } }));
  } catch {}
};

// a place as an id: repo:<id> · fresh:<id> · work:<slug> · row:<slug>:<key>; `app` is coco's own checkout
export const placeId = (p: NewAgentPlace) => (p.kind === 'row' ? `row:${p.slug}:${p.key}` : p.kind === 'work' ? `work:${p.slug}` : `${p.kind}:${p.repoId}`);
export function parsePlace(id: string | null | undefined): NewAgentPlace | null {
  const m = /^(repo|fresh|work|row):([^:]+)(?::(.+))?$/.exec(id || '');
  if (!m) return null;
  const [, kind, a, b] = m;
  if (kind === 'row') return b ? { kind, slug: a, key: b } : null;
  return kind === 'work' ? { kind, slug: a } : { kind: kind as 'repo' | 'fresh', repoId: a };
}

// a message to put in the launcher's composer, taken once by the page
export const useLaunchDraft = create<{ text: string | null; seq: number }>(() => ({ text: null, seq: 0 }));
export const takeDraft = () => {
  const { text } = useLaunchDraft.getState();
  useLaunchDraft.setState({ text: null });
  return text;
};

export const launcherHref = (place?: string | null) => `#/agents/new${place ? `?place=${encodeURIComponent(place)}` : ''}`;
export function openLauncher({ place, text }: { place?: string | null; text?: string } = {}) {
  useLaunchDraft.setState((s) => ({ text: text ?? null, seq: s.seq + 1 }));
  location.hash = launcherHref(place);
}
