export const CATEGORIES = ['core', 'refactor', 'wiring', 'tests', 'other'];
export const CAT_CHIP = { core: 'c-blue', refactor: 'c-purple', wiring: 'c-grey', tests: 'c-green', other: 'c-grey' };

// Reading groups: coco's plan steps then Skim, or the deterministic categories before any plan
export function orderGroups(files, st) {
  const byPath = new Map(files.map((f) => [f.filename, f]));
  const used = new Set();
  const pick = (paths) => paths.filter((p) => byPath.has(p) && !used.has(p) && used.add(p)).map((p) => byPath.get(p));
  const plan = st.plan;
  const groups = plan
    ? [
      ...plan.steps.map((s, i) => ({ key: `step-${i}`, title: `${i + 1}. ${s.title}`, why: s.why, files: pick(s.files.map((x) => x.path)) })),
      { key: 'skim', title: 'Skim', why: 'coco says a glance is enough', files: pick(plan.skim.map((x) => x.path)) },
    ]
    : CATEGORIES.map((c) => ({ key: c, title: c, files: pick(st.suggested.filter((p) => st.categories[p]?.category === c)) }));
  const rest = files.filter((f) => !used.has(f.filename));
  if (rest.length) groups.push({ key: 'rest', title: 'Not in the plan', files: rest });
  return groups.filter((g) => g.files.length);
}

// path → what coco asks to check there (step focus, or the skim reason)
export function planNotes(plan) {
  const out = {};
  if (!plan) return out;
  for (const s of plan.steps) for (const f of s.files) if (f.focus) out[f.path] = f.focus;
  for (const f of plan.skim) if (f.reason) out[f.path] = `skim: ${f.reason}`;
  return out;
}
