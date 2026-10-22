import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { runUrl, workLinks, type CommentCounts, type RunView, type resolveRpc } from "../shared/contracts";
import type { LabeledRun } from "../shared/labels";

// Node's global fetch; the plugin typechecks without DOM or Node libs.
declare const fetch: (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type ServerRun = Omit<RunView, "url">;
type Resolved = Omit<RpcOutput<typeof resolveRpc>, "home" | "links" | "runs"> & { runs: ServerRun[] };

async function post<T>(baseUrl: string, path: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/paseo-link/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`cocopilot ${path} answered ${response.status}`);
  return (await response.json()) as T;
}

const withUrl = (baseUrl: string, run: ServerRun): RunView => ({ ...run, url: runUrl(baseUrl, run) });

export async function resolveWorkspace(baseUrl: string, input: RpcInput<typeof resolveRpc>): Promise<RpcOutput<typeof resolveRpc>> {
  const resolved = await post<Resolved>(baseUrl, "resolve", input);
  return {
    ...resolved,
    runs: (resolved.runs ?? []).map((run) => withUrl(baseUrl, run)),
    home: baseUrl,
    links: resolved.work ? workLinks(baseUrl, resolved.work.slug, resolved.pr?.number ?? null) : null,
  };
}

// cwd lets cocopilot refresh the refs of the work whose branch the agent sits on
export async function settleTurn(baseUrl: string, agent: { id: string; cwd: string }, signal?: AbortSignal): Promise<RunView[]> {
  const { runs } = await post<{ runs: ServerRun[] }>(baseUrl, "turn-ended", { agentId: agent.id, cwd: agent.cwd }, signal);
  return runs.map((run) => withUrl(baseUrl, run));
}

// The run file is written right after launch, so a turn can start before cocopilot knows the run: describe it from its labels then.
export async function currentRun(baseUrl: string, labeled: LabeledRun, signal: AbortSignal): Promise<RunView> {
  const { run } = await post<{ run: ServerRun | null }>(baseUrl, "run", labeled, signal);
  const comments: CommentCounts = { total: labeled.commentCount, sent: labeled.commentCount };
  return withUrl(baseUrl, run ?? { ...labeled, title: labeled.slug, status: "running", agentId: null, startedAt: null, finishedAt: null, comments });
}
