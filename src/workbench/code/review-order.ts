import type { FileGroup, PlanBody, Proposal, RefFile, ReviewPlanState } from '../types.ts';

export const CATEGORIES = ['core', 'refactor', 'wiring', 'tests', 'other'];

// Reading groups: coco's plan steps then Skim, or the deterministic categories before any plan
export function orderGroups(files: RefFile[], st: ReviewPlanState): FileGroup[] {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const used = new Set<string>();
  const pick = (paths: string[]) => paths.filter((p) => byPath.has(p) && !used.has(p) && used.add(p)).flatMap((p) => byPath.get(p) ?? []);
  const plan = st.plan;
  const groups: FileGroup[] = plan
    ? [
      ...plan.steps.map((s, i) => ({ key: `step:${s.title}`, title: `${i + 1}. ${s.title}`, why: s.why, files: pick(s.files.map((x) => x.path)) })),
      { key: 'skim', title: 'Skim', why: 'coco says a glance is enough', files: pick(plan.skim.map((x) => x.path)) },
    ]
    : CATEGORIES.map((c) => ({ key: c, title: c, files: pick(st.suggested.filter((p) => st.categories[p]?.category === c)) }));
  const rest = files.filter((f) => !used.has(f.filename));
  if (rest.length) groups.push({ key: 'rest', title: 'Not in the plan', files: rest });
  return groups.filter((g) => g.files.length);
}

// path → what coco asks to check there (step focus, or the skim reason)
export function planNotes(plan: PlanBody | null | undefined) {
  const out: Record<string, string> = {};
  if (!plan) return out;
  for (const s of plan.steps) for (const f of s.files) if (f.focus) out[f.path] = f.focus;
  for (const f of plan.skim) if (f.reason) out[f.path] = `skim: ${f.reason}`;
  return out;
}

export function watchByPath(points: Proposal[]) {
  const out: Record<string, Proposal[]> = {};
  for (const w of points) (out[w.path] ||= []).push(w);
  return out;
}

export const watchCount = (group: FileGroup, byPath: Record<string, Proposal[]>) => group.files.reduce((n, f) => n + (byPath[f.filename]?.length || 0), 0);

// path → its folder, longer where another file in the list has the same name
export function dirHints(paths: string[]) {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const name = p.split('/').pop() ?? p;
    byName.set(name, [...(byName.get(name) || []), p]);
  }
  const out: Record<string, string> = {};
  for (const same of byName.values()) {
    const dirs = same.map((p) => p.split('/').slice(0, -1));
    let depth = 1;
    const hint = (d: string[]) => d.slice(-depth).join('/');
    while (depth < Math.max(...dirs.map((d) => d.length)) && new Set(dirs.map(hint)).size < same.length) depth++;
    same.forEach((p, i) => (out[p] = hint(dirs[i])));
  }
  return out;
}
