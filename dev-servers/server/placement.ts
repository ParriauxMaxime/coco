import type { Placement, StartInput } from "../shared/contracts.ts";
import type { ProjectConfig } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { remoteMatches, remoteUrls, toplevel } from "./git.ts";
import { isUnder, realPath } from "./proc.ts";

export type Target = { worktree: string; project: ProjectConfig };
export type PlacementRequest = Pick<StartInput, "serveFrom" | "dedicated" | "services" | "dedicatedDb" | "reason">;
export type Place = (target: Target, request: PlacementRequest) => Promise<Placement>;

export async function resolveTarget(cwd: string, projects: ProjectConfig[]): Promise<Target> {
  const worktree = await toplevel(cwd);
  if (!worktree) throw new ServiceError("not_a_project_worktree", `${cwd} is not inside a git worktree`, { cwd });
  const remotes = await remoteUrls(worktree);
  const real = realPath(worktree);
  const project = projects.find(
    ({ match }) => (match.remote && remotes.some((url) => remoteMatches(url, match.remote!))) || match.paths?.some((dir) => isUnder(real, realPath(dir))),
  );
  if (!project) {
    throw new ServiceError("not_a_project_worktree", `${worktree} matches no configured project`, { worktree, projects: projects.map(({ id }) => id) });
  }
  return { worktree, project };
}

export const placeOwn: Place = async (target, { serveFrom, dedicated, services = [], dedicatedDb, reason }) => {
  if (serveFrom && (await toplevel(serveFrom)) !== target.worktree) {
    throw new ServiceError("bad_request", `serveFrom must be the caller's own worktree ${target.worktree}: serving from another worktree is not available`);
  }
  const because: string[] = [];
  if (dedicated) because.push("a dedicated server was asked for");
  if (services.length) because.push(`opt-in services ${services.join(", ")}: ${reason}`);
  if (dedicatedDb) because.push(`dedicated database: ${reason}`);
  return { mode: because.length ? "dedicated" : "own", servedFrom: target.worktree, because: because.length ? because : ["the worktree runs its own server"] };
};
