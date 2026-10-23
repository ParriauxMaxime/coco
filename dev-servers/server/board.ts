import { UI_HOLDER, type Board, type BoardServer, type Holder, type ServerView } from "../shared/contracts.ts";
import type { DevServersConfig } from "./config.ts";
import type { LeaseManager } from "./leases.ts";
import { countsTowardCap } from "./scheduler.ts";
import type { DevServersState, JsonStore } from "./store.ts";

export type BoardDeps = {
  leases: Pick<LeaseManager, "agentOf" | "titleOf" | "lostNotices">;
  store: Pick<JsonStore<DevServersState>, "snapshot">;
  config: Pick<DevServersConfig, "cap" | "projects">;
};

export type Presenter = {
  server: (view: ServerView, me?: Holder) => BoardServer;
  board: (views: ServerView[]) => Board;
};

const sameHolder = (a: Pick<Holder, "kind" | "id">, b: Pick<Holder, "kind" | "id">) => a.kind === b.kind && a.id === b.id;

// An agent's holder id is its lease key, which lets anyone act as that agent: what leaves the plugin names holders by title and agent id only.
export function createPresenter({ leases, store, config }: BoardDeps): Presenter {
  const server = (view: ServerView, me: Holder = UI_HOLDER): BoardServer => {
    const record = store.snapshot().servers[view.id];
    const { leases: held, pinnedBy, ...rest } = view;
    return {
      ...rest,
      leases: held.map(({ id, holder, since, lastUsedAt }) => ({
        id,
        kind: holder.kind,
        holderId: holder.kind === "agent" ? null : holder.id,
        title: holder.title ?? leases.titleOf(holder),
        agentId: leases.agentOf(holder),
        mine: sameHolder(holder, me),
        since,
        lastUsedAt,
      })),
      pinnedBy: pinnedBy ? (sameHolder(pinnedBy, me) ? (me.title ?? "you") : leases.titleOf(pinnedBy)) : null,
      running: Boolean(record && countsTowardCap(record)),
      canLogin: Boolean(config.projects.find(({ id }) => id === view.project)?.provider),
    };
  };

  return {
    server,
    board: (views) => ({
      error: null,
      cap: config.cap,
      servers: views.map((view) => server(view)),
      lost: leases.lostNotices().map(({ id, serverId, worktree, why, at, holder, seenAt }) => ({
        id,
        serverId,
        worktree,
        why,
        at,
        holder: leases.titleOf(holder),
        agentId: leases.agentOf(holder),
        seen: Boolean(seenAt),
      })),
    }),
  };
}

export const presentResult = <T extends { server: ServerView | null }>(present: Presenter, result: T, me?: Holder) => ({
  ...result,
  server: result.server && present.server(result.server, me),
});
