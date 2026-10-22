import type { RunKind } from "./contracts";

export type LabeledRun = { kind: RunKind; slug: string; runId: string; pr: string | null; commentCount: number };

// cocopilot labels the agents it launches: source=cocopilot, kind, run, work, comments, pr (review only).
export function runFromLabels(labels: Readonly<Record<string, string>>): LabeledRun | null {
  const { source, kind, run, work, comments, pr } = labels;
  if (source !== "cocopilot" || !run || !work || (kind !== "review" && kind !== "stack-fix")) return null;
  return { kind, slug: work, runId: run, pr: kind === "review" ? (pr ?? null) : null, commentCount: Number(comments) || 0 };
}
