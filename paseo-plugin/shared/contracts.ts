import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const connectionSettings = defineSettings({
  id: "connection",
  scope: "host",
  version: 1,
  schema: z.object({ baseUrl: z.string().url().default("http://127.0.0.1:8777") }),
});

const commentCounts = z
  .object({ total: z.number() })
  .catchall(z.number())
  .describe("comment count per status: open, sent, fixed, declined, outdated");

const linksSchema = z.object({ plan: z.string(), pr: z.string().nullable(), review: z.string().nullable() });

const runKind = z.enum(["review", "stack-fix"]);
export type RunKind = z.output<typeof runKind>;
export const RUN_KIND_LABELS: Record<RunKind, string> = { review: "review fix", "stack-fix": "stack fix" };

// A PR key is a PR number or a local branch key like "b:feat:x"; labels store it file-safe with "~" for ":".
const prKey = z.union([z.number(), z.string()]).nullable();
type PrKey = z.output<typeof prKey>;

export const runViewSchema = z.object({
  kind: runKind,
  slug: z.string(),
  title: z.string(),
  pr: prKey,
  runId: z.string(),
  status: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  comments: commentCounts,
  url: z.string(),
});
export type RunView = z.output<typeof runViewSchema>;

export const resolveRpc = defineRpc({
  name: "cocopilot.resolve",
  input: z.object({ cwd: z.string(), projectId: z.string(), workspaceId: z.string().optional() }),
  output: z.object({
    home: z.string(),
    branch: z.string().nullable(),
    work: z.object({ slug: z.string(), title: z.string(), stack: z.array(z.number()) }).nullable(),
    pr: z.object({ number: z.number(), comments: commentCounts }).nullable(),
    row: z
      .object({ key: z.union([z.number(), z.string()]), label: z.string(), briefed: z.array(z.string()).describe("agents the row's work brief was sent to") })
      .nullable()
      .describe("the stack row this workspace belongs to"),
    runs: z.array(runViewSchema),
    links: linksSchema.nullable(),
  }),
});

export const addBriefRpc = defineRpc({
  name: "cocopilot.addBrief",
  input: z.object({ agentId: z.string(), workspaceId: z.string(), cwd: z.string() }),
  output: z.object({ label: z.string() }),
});

export const homeRpc = defineRpc({
  name: "cocopilot.home",
  input: z.object({}),
  output: z.object({ url: z.string() }),
});

export const REVIEW_RUN_KIND = "cocopilot-review-run";

// Rows appended before stack fixes existed carry no kind and a numeric PR.
export const reviewRunSchema = z.object({
  kind: runKind.default("review"),
  title: z.string(),
  number: prKey,
  runId: z.string(),
  status: z.string(),
  comments: commentCounts,
  url: z.string(),
});

export type ReviewRun = z.output<typeof reviewRunSchema>;
export type CommentCounts = z.output<typeof commentCounts>;

const workBase = (home: string, slug: string) => `${home.replace(/\/$/, "")}/#/work/${encodeURIComponent(slug)}`;
const colonKey = (pr: PrKey) => String(pr).replaceAll("~", ":");

export const workLinks = (home: string, slug: string, number: number | null) => {
  const base = workBase(home, slug);
  return { plan: `${base}/plan`, pr: number ? `${base}/pr-${number}` : null, review: number ? `${base}/review-${number}` : null };
};

export const runUrl = (home: string, { kind, slug, pr, runId }: { kind: RunKind; slug: string; pr: PrKey; runId: string }) =>
  `${workBase(home, slug)}/${encodeURIComponent(kind === "stack-fix" ? `stack-${runId}` : `review-${colonKey(pr)}`)}`;

const prLabel = (pr: PrKey) => {
  const key = colonKey(pr);
  return /^\d+$/.test(key) ? `#${key}` : key.slice(2).replaceAll(":", "/");
};

export const describeRun = ({ kind, pr }: { kind: RunKind; pr: PrKey }) =>
  kind === "review" && pr !== null ? `${RUN_KIND_LABELS[kind]} ${prLabel(pr)}` : RUN_KIND_LABELS[kind];
