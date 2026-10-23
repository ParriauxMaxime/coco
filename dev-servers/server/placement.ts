import type { Placement, PlacementOption, StartInput } from "../shared/contracts.ts";
import type { StackOrder } from "./coco.ts";
import type { ProjectConfig } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { defaultRemoteRef, independent, isAncestor, listWorktrees, refsContaining, remoteMatches, remoteUrls, toplevel, type WorktreeEntry } from "./git.ts";
import { isUnder, realPath } from "./proc.ts";
import type { ServerRecord } from "./store.ts";

export type Target = { worktree: string; project: ProjectConfig };
export type PlacementRequest = Pick<StartInput, "serveFrom" | "dedicated" | "services" | "dedicatedDb" | "reason">;
export type Place = (target: Target, request: PlacementRequest) => Promise<Placement>;

export async function projectOf(worktree: string, projects: ProjectConfig[]): Promise<ProjectConfig | undefined> {
  const remotes = await remoteUrls(worktree);
  const real = realPath(worktree);
  return projects.find(
    ({ match }) => (match.remote && remotes.some((url) => remoteMatches(url, match.remote!))) || match.paths?.some((dir) => isUnder(real, realPath(dir))),
  );
}

export async function resolveTarget(cwd: string, projects: ProjectConfig[]): Promise<Target> {
  const worktree = await toplevel(cwd);
  if (!worktree) throw new ServiceError("not_a_project_worktree", `${cwd} is not inside a git worktree`, { cwd });
  const project = await projectOf(worktree, projects);
  if (!project) {
    throw new ServiceError("not_a_project_worktree", `${worktree} matches no configured project`, { worktree, projects: projects.map(({ id }) => id) });
  }
  return { worktree, project };
}

export type StackPlacementOptions = {
  worktreeRoots: string[];
  servers: () => ServerRecord[];
  dirtyFiles: (worktree: string) => Promise<string[]>;
  stackOrder?: StackOrder;
  cacheMs?: number;
};

type Candidate = WorktreeEntry & { record: ServerRecord | null };
type Graph = { onBase: boolean; above: Set<string>; tops: string[] };
type Cache<T> = Map<string, { at: number; value: Promise<T> }>;

const RUNNING: ServerRecord["state"][] = ["prewarming", "building", "ready", "idle"];
const SERVING: ServerRecord["state"][] = ["ready", "idle"];
const MAX_FILES = 10;
const DEFAULT_REF_MS = 5 * 60_000;

const fileList = (files: string[]) => files.slice(0, MAX_FILES).join(", ") + (files.length > MAX_FILES ? ` and ${files.length - MAX_FILES} more` : "");
const label = ({ branch, path }: WorktreeEntry) => (branch ? `${branch} (${path})` : path);
const branchRef = (branch: string | null) => `refs/heads/${branch}`;
const option = ({ path, branch, head, record }: Candidate): PlacementOption => ({ worktree: path, branch, head, running: Boolean(record) });

const isExternal = (entry: Candidate) => entry.record?.state === "external";
const isLive = (record: ServerRecord) => (record.process && RUNNING.includes(record.state)) || record.state === "external";

// The plugin's own servers before servers started by hand, running ones first, ready before building, then the most recently used.
const preferred = (a: Candidate, b: Candidate) =>
  Number(isExternal(a)) - Number(isExternal(b)) ||
  Number(!a.record) - Number(!b.record) ||
  Number(!SERVING.includes(a.record?.state ?? "stopped")) - Number(!SERVING.includes(b.record?.state ?? "stopped")) ||
  (b.record?.lastUsedAt ?? "").localeCompare(a.record?.lastUsedAt ?? "") ||
  a.path.localeCompare(b.path);

function remember<T>(cache: Cache<T>, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  for (const [stale, { at }] of cache) if (now - at >= ttlMs) cache.delete(stale);
  const value = load();
  cache.set(key, { at: now, value });
  return value;
}

function explicitReasons({ dedicated, services = [], dedicatedDb, reason }: PlacementRequest) {
  const because: string[] = [];
  if (dedicated) because.push("a dedicated server was asked for");
  if (services.length) because.push(`opt-in services ${services.join(", ")}: ${reason}`);
  if (dedicatedDb) because.push(`dedicated database: ${reason}`);
  return because;
}

export function createStackPlacement({ worktreeRoots, servers, dirtyFiles, stackOrder, cacheMs = 30_000 }: StackPlacementOptions): Place {
  const graphs: Cache<Graph> = new Map();
  const defaultRefs: Cache<string | null> = new Map();

  const graph = (worktree: string, head: string, defaultRef: string | null, candidates: Candidate[]) => {
    const key = [head, defaultRef, ...candidates.map(({ branch, head }) => `${branch}=${head}`).sort()].join(" ");
    return remember(graphs, key, cacheMs, async () => {
      const refs = candidates.map(({ branch }) => branchRef(branch));
      const containing = await refsContaining(worktree, head, defaultRef ? [...refs, defaultRef] : refs);
      const above = candidates.filter(({ branch }) => containing.has(branchRef(branch)));
      return {
        onBase: Boolean(defaultRef && containing.has(defaultRef)),
        above: new Set(above.map(({ path }) => path)),
        tops: await independent(
          worktree,
          above.map(({ head }) => head),
        ),
      };
    });
  };

  const withDirtyNote = async (from: Candidate, because: string[]) => {
    const files = await dirtyFiles(from.path);
    return files.length ? [...because, `${label(from)} has uncommitted changes you will see too: ${fileList(files)}`] : because;
  };

  return async (target, request) => {
    const worktree = target.worktree;
    const explicit = explicitReasons(request);
    if (explicit.length) return { mode: "dedicated", servedFrom: worktree, because: explicit };
    const own = (because: string): Placement => ({ mode: "own", servedFrom: worktree, because: [because] });

    const dirty = await dirtyFiles(worktree);
    if (dirty.length) return own(`the worktree has uncommitted changes, so it runs its own server: ${fileList(dirty)}`);

    const real = realPath(worktree);
    const records = servers().filter((record) => record.project === target.project.id && isLive(record));
    const recordAt = (dir: string) => records.find((record) => realPath(record.worktree) === dir) ?? null;
    const entries = (await listWorktrees(worktree)).map((entry) => {
      const path = realPath(entry.path);
      return { ...entry, path, record: recordAt(path) };
    });
    const self = entries.find(({ path }) => path === real);
    if (!self) return own("git does not list the worktree, so it runs its own server");
    const others = entries.filter((entry) => entry !== self);

    if (request.serveFrom) {
      const from = await toplevel(request.serveFrom);
      if (from && realPath(from) === real) return own("serveFrom names the worktree itself");
      const picked = from ? others.find(({ path }) => path === realPath(from)) : undefined;
      if (!picked) throw new ServiceError("bad_request", `serveFrom ${request.serveFrom} is not a worktree of the repository of ${worktree}`);
      if (!(await isAncestor(worktree, self.head, picked.head))) {
        return own(`${label(picked)} does not contain this worktree's commit (restacked since?), so the worktree runs its own server`);
      }
      return { mode: "stack-top", servedFrom: picked.path, because: await withDirtyNote(picked, [`serveFrom chose ${label(picked)}`]) };
    }

    if (self.record) return own("the worktree's own server is already running");

    const roots = [...worktreeRoots, target.project.mainCheckout].filter(Boolean).map(realPath);
    const candidates = others.filter(({ branch, path }) => branch && roots.some((root) => isUnder(path, root)));
    const defaultRef = await remember(defaultRefs, real, DEFAULT_REF_MS, () => defaultRemoteRef(worktree));
    const { onBase, above: abovePaths, tops } = await graph(worktree, self.head, defaultRef, candidates);
    if (onBase) return own(`the worktree has no commit of its own above ${defaultRef?.replace(/^refs\/remotes\//, "")}, so it runs its own server`);
    const above = candidates.filter(({ path }) => abovePaths.has(path));
    if (!above.length) return own("no other worktree builds on this worktree's commit: it is the top of its stack");

    const topHeads = new Set(tops);
    const reusable = (
      await Promise.all(above.filter(({ record }) => record).map(async (entry) => ((await dirtyFiles(entry.path)).length ? null : entry)))
    ).filter((entry): entry is Candidate => entry !== null);
    const best = reusable.sort(
      (a, b) => Number(isExternal(a)) - Number(isExternal(b)) || Number(!topHeads.has(a.head)) - Number(!topHeads.has(b.head)) || preferred(a, b),
    )[0];
    if (best && isExternal(best)) {
      return {
        mode: "external",
        servedFrom: best.path,
        because: [
          `reuses the server of ${label(best)}, which contains this worktree's commit; it was started outside the plugin, runs with its own settings and is never stopped by the plugin`,
        ],
      };
    }
    if (best) {
      return {
        mode: topHeads.has(best.head) ? "stack-top" : "stack-running",
        servedFrom: best.path,
        because: [`reuses the running server of ${label(best)}, which contains this worktree's commit`],
      };
    }
    if (topHeads.has(self.head)) return own("the worktree is the top of its stack (another worktree is on the same commit)");

    // A clean external top was reused above, so an external top here has uncommitted changes and cannot be rebuilt by the plugin.
    const viaTop = async (top: Candidate, because: string): Promise<Placement> =>
      isExternal(top)
        ? own(
            `${label(top)} is the top of the stack, but its server was started outside the plugin and it has uncommitted changes, so this worktree runs its own server`,
          )
        : { mode: "stack-top", servedFrom: top.path, because: await withDirtyNote(top, [because]) };

    const groups = tops.map((head) => above.filter((entry) => entry.head === head).sort(preferred)).filter((group) => group.length);
    if (groups.length === 1) {
      const top = groups[0][0];
      return viaTop(top, `${label(top)} is the top of the stack and contains this worktree's commit`);
    }

    const order = self.branch && stackOrder ? await stackOrder(self.branch) : null;
    const rankOf = (group: Candidate[]) => Math.max(...group.map(({ branch }) => order?.findIndex((row) => row.branch === branch) ?? -1));
    const ranked = groups.map((group) => ({ group, rank: rankOf(group) })).filter(({ rank }) => rank >= 0);
    if (ranked.length) {
      const top = ranked.sort((a, b) => b.rank - a.rank)[0].group[0];
      return viaTop(top, `${groups.length} stacks build on this worktree's commit; ${label(top)} is the latest row of its coco work`);
    }
    const why = !self.branch
      ? "the worktree has no branch"
      : !stackOrder
        ? "coco is not configured"
        : order
          ? "no coco work orders them"
          : "coco did not answer";
    return {
      ...own(`${groups.length} stacks build on this worktree's commit and ${why}, so it runs its own server`),
      ambiguous: {
        question: "Which stack is this worktree part of? Call dev_server_start again with serveFrom set to one of the options to share its server.",
        options: groups.map((group) => option(group[0])),
      },
    };
  };
}
