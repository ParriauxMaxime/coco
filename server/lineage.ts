// Lineage: a work an agent of another work created keeps that work as its parent; the parent's timeline says so and its Overview lists its spun-off works.
import type { TimelineEntry, Work } from './core-types.ts';

type Store = { get(slug: string): Work | null | undefined; save(work: Work, opts?: { touch?: boolean }): unknown };

const CREATED_BY_AGENT = /^created from agent ([0-9a-f]{8})\b/;

export const nextSummary = (next: unknown) => (next && typeof next === 'object' && 'summary' in next && typeof next.summary === 'string' ? next.summary : null);
const nextAt = (next: unknown) => (next && typeof next === 'object' && 'at' in next && typeof next.at === 'string' ? next.at : null);

// newest first, as the timeline is kept
const insertByTs = (timeline: TimelineEntry[], entry: TimelineEntry) => {
  const at = timeline.findIndex((t) => t.ts <= entry.ts);
  timeline.splice(at < 0 ? timeline.length : at, 0, entry);
};

// stamps the parent on the child and the spin-off on the parent's timeline; false when either is missing, they are one work, the child has a parent already or it would make a loop
export function linkParent(store: Store, childSlug: string, parentSlug: string | null | undefined, { ts = new Date().toISOString(), touch = true }: { ts?: string; touch?: boolean } = {}) {
  const child = store.get(childSlug);
  const parent = parentSlug ? store.get(parentSlug) : null;
  if (!child || !parent || child.slug === parent.slug || child.parent) return false;
  for (let up: Work | null | undefined = parent, hops = 0; up?.parent && hops < 20; hops++) {
    if (up.parent === child.slug) return false;
    up = store.get(up.parent);
  }
  child.parent = parent.slug;
  store.save(child, { touch });
  insertByTs((parent.timeline ||= []), { ts, kind: 'coco', text: `spun off work ${child.title}`, link: `#/work/${child.slug}` });
  store.save(parent, { touch });
  return true;
}

// one-time, idempotent: a work whose timeline says "created from agent <id>" gets that agent's work as its parent
export function backfillParents(store: Store & { list(): Work[] }, workOfAgent: (idPrefix: string) => string | null | undefined) {
  const linked: { slug: string; parent: string }[] = [];
  for (const w of store.list()) {
    if (w.parent) continue;
    const entry = (w.timeline || []).find((t) => CREATED_BY_AGENT.test(t.text));
    const parent = entry ? workOfAgent(CREATED_BY_AGENT.exec(entry.text)![1]) : null;
    if (entry && parent && linkParent(store, w.slug, parent, { ts: entry.ts, touch: false })) linked.push({ slug: w.slug, parent });
  }
  return linked;
}

// what the parent's Overview lists of each work spun off it, live ones first
export const spunOff = (all: Work[], slug: string) =>
  all
    .filter((w) => w.parent === slug)
    .map((w) => ({ slug: w.slug, title: w.title, archived: Boolean(w.archived), next: nextSummary(w.next), nextAt: nextAt(w.next), createdAt: w.createdAt || null }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || (b.createdAt || '').localeCompare(a.createdAt || ''));
