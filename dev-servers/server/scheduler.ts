import { ServiceError } from "./errors.ts";
import type { Capacity, Evicted, LeaseBook } from "./service.ts";
import type { DevServersState, JsonStore, ServerRecord } from "./store.ts";

const WITH_PROCESS: ServerRecord["state"][] = ["prewarming", "building", "ready", "idle", "crashed"];

// A prebuild counts only while it builds; a crashed server counts while its process lives, since the dev tool waits for a fix.
export const countsTowardCap = (record: ServerRecord) => record.state === "external" || Boolean(record.process && WITH_PROCESS.includes(record.state));

const evictable = (record: ServerRecord) => record.state !== "external" && !record.pinned && Boolean(record.process);

// Prebuilds go first: cancelling one loses no one's work. Then the least recently used.
const victimOrder = (a: ServerRecord, b: ServerRecord) =>
  Number(b.state === "prewarming") - Number(a.state === "prewarming") || a.lastUsedAt.localeCompare(b.lastUsedAt) || a.id.localeCompare(b.id);

export type SchedulerOptions = {
  store: JsonStore<DevServersState>;
  cap: number;
  stop: (id: string) => Promise<unknown>;
  leases?: Pick<LeaseBook, "holders" | "lose">;
  onWarning?: (message: string) => void;
};

export type Scheduler = Capacity & { running(): ServerRecord[] };

export function createScheduler({ store, cap, stop, leases, onWarning = console.warn }: SchedulerOptions): Scheduler {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const running = () => Object.values(store.snapshot().servers).filter(countsTowardCap);

  const full = (servers: ServerRecord[], message: string) =>
    new ServiceError("capacity_full", message, {
      cap,
      servers: servers.map((record) => ({
        id: record.id,
        worktree: record.worktree,
        state: record.state,
        port: record.port,
        pinned: record.pinned,
        external: record.state === "external",
        lastUsedAt: record.lastUsedAt,
        holders: leases?.holders(record.id).map(({ holder }) => holder.title ?? `${holder.kind} ${holder.id}`) ?? [],
      })),
    });

  return {
    running,

    // Admission and launch run under one lock, so two starts never both take the last slot.
    admit: (target, launch, { evict = true } = {}) =>
      serialize(async () => {
        const evicted: Evicted[] = [];
        const failed = new Set<string>();
        for (;;) {
          const others = running().filter((record) => record.id !== target.id);
          if (others.length < cap) break;
          if (!evict) throw full(others, `all ${cap} server slots are taken, and a prebuild never stops another server`);
          const victim = others.filter((record) => evictable(record) && !failed.has(record.id)).sort(victimOrder)[0];
          if (!victim) {
            throw full(
              others,
              `all ${cap} server slots are taken by servers that are pinned or were started outside the plugin; unpin or stop one, or raise cap`,
            );
          }
          const why = victim.state === "prewarming" ? "it was only a prebuild" : `it was the least recently used of the ${cap} running servers`;
          try {
            await leases?.lose(victim.id, `stopped to make room for ${target.worktree}: ${why}`);
            await stop(victim.id);
          } catch (error) {
            onWarning(`evicting ${victim.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          const after = store.snapshot().servers[victim.id];
          if (after && countsTowardCap(after)) failed.add(victim.id);
          else evicted.push({ id: victim.id, worktree: victim.worktree, why });
        }
        return { evicted, result: await launch() };
      }),
  };
}
