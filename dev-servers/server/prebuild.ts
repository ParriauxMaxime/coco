import path from "node:path";
import type { ProjectConfig } from "./config.ts";
import { systemClock, type Clock } from "./leases.ts";
import { resolveTarget, type Target } from "./placement.ts";
import { realPath } from "./proc.ts";
import type { DevServersService } from "./service.ts";
import { serverIdFor, type DevServersState, type JsonStore, type PrebuildJob, type ServerRecord } from "./store.ts";
import { describeWarm } from "./warm.ts";

export type EnqueueResult = { queued: boolean; worktree?: string; why: string };

export type PrebuildQueue = {
  enqueue(cwd: string): Promise<EnqueueResult>;
  forget(worktree: string): Promise<boolean>;
  jobs(): PrebuildJob[];
  start(): void;
  idle(): Promise<void>;
  close(): void;
};

export type PrebuildQueueOptions = {
  store: JsonStore<DevServersState>;
  projects: ProjectConfig[];
  service: Pick<DevServersService, "prewarm" | "finishPrewarm">;
  subscribe: (listener: (record: ServerRecord) => void) => () => void;
  resolve?: (cwd: string, projects: ProjectConfig[]) => Promise<Target>;
  clock?: Clock;
  retryMs?: number[];
  maxCancels?: number;
  waitMarginMs?: number;
  onLog?: (message: string) => void;
  onWarning?: (message: string) => void;
};

const RETRY_MS = [15_000, 30_000, 60_000, 120_000];
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// One prebuild at a time, oldest first. The head job stays in the store while it runs, so a reload resumes it.
export function createPrebuildQueue({
  store,
  projects,
  service,
  subscribe,
  resolve = resolveTarget,
  clock = systemClock,
  retryMs = RETRY_MS,
  maxCancels = 2,
  waitMarginMs = 60_000,
  onLog = (message) => console.log(`coco-dev-servers: ${message}`),
  onWarning = console.warn,
}: PrebuildQueueOptions): PrebuildQueue {
  const wake: { idle: (() => void) | null; retry: (() => void) | null } = { idle: null, retry: null };
  let loop: Promise<void> | null = null;
  let busy = false;
  let closed = false;
  const idlers: (() => void)[] = [];
  const onClose = new Set<() => void>();

  const pause = (kind: keyof typeof wake, ms?: number) =>
    new Promise<void>((done) => {
      const timer = ms === undefined ? null : clock.setTimeout(() => finish(), ms);
      const finish = () => {
        timer?.cancel();
        if (wake[kind] === finish) wake[kind] = null;
        onClose.delete(finish);
        done();
      };
      wake[kind] = finish;
      onClose.add(finish);
    });

  const queued = (worktree: string) => store.snapshot().prebuilds.some((job) => job.worktree === worktree);

  const remove = (worktree: string) =>
    store.update((draft) => {
      const before = draft.prebuilds.length;
      draft.prebuilds = draft.prebuilds.filter((job) => job.worktree !== worktree);
      return draft.prebuilds.length < before;
    });

  // A prebuild cancelled to free a slot for a real start goes to the back of the queue, at most maxCancels times.
  const requeue = (worktree: string) =>
    store.update((draft) => {
      const index = draft.prebuilds.findIndex((job) => job.worktree === worktree);
      if (index < 0) return "gone" as const;
      const [job] = draft.prebuilds.splice(index, 1);
      if (job.cancels >= maxCancels) return "dropped" as const;
      draft.prebuilds.push({ ...job, cancels: job.cancels + 1 });
      return "requeued" as const;
    });

  const waitBuilt = (id: string, timeoutMs: number) =>
    new Promise<void>((done) => {
      const settled = (record: ServerRecord | undefined) => !record || !record.prebuild || record.state !== "prewarming";
      const finish = () => {
        unsubscribe();
        timer.cancel();
        onClose.delete(finish);
        done();
      };
      const unsubscribe = subscribe((record) => record.id === id && settled(record) && finish());
      const timer = clock.setTimeout(finish, timeoutMs);
      onClose.add(finish);
      if (settled(store.snapshot().servers[id])) finish();
    });

  const runJob = async (job: PrebuildJob) => {
    let target: Target;
    try {
      target = await resolve(job.worktree, projects);
    } catch (error) {
      onLog(`prebuild of ${job.worktree} dropped: ${messageOf(error)}`);
      await remove(job.worktree);
      return;
    }
    const id = serverIdFor(target.worktree);
    const record = store.snapshot().servers[id];
    if (!(record?.prebuild && record.process)) {
      for (let attempt = 0; ; attempt += 1) {
        if (closed || !queued(job.worktree)) return;
        const result = await service.prewarm(target, { warm: attempt === 0 });
        const warmed = describeWarm(result.warmed);
        if (warmed.length) onLog(`prebuild of ${target.worktree}: ${warmed.join("; ")}`);
        if (result.outcome === "started") break;
        if (result.outcome === "running") {
          await remove(job.worktree);
          return;
        }
        await pause("retry", retryMs[Math.min(attempt, retryMs.length - 1)]);
      }
    }
    await waitBuilt(id, target.project.readiness.timeoutMinutes * 60_000 + waitMarginMs);
    if (closed) return;
    const finished = await service.finishPrewarm(id);
    if (finished.outcome === "cancelled") {
      const next = await requeue(job.worktree);
      if (next === "requeued") onLog(`prebuild of ${target.worktree} was cancelled to make room; queued again`);
      if (next === "dropped") onWarning(`prebuild of ${target.worktree} dropped after being cancelled ${maxCancels + 1} times to make room`);
      return;
    }
    await remove(job.worktree);
    if (finished.outcome === "failed") onWarning(`prebuild of ${target.worktree} failed: ${finished.detail}`);
    else
      onLog(
        `prebuild of ${target.worktree} ${finished.outcome === "done" ? "finished" : "was taken over by a start"}${finished.detail ? ` (${finished.detail})` : ""}`,
      );
  };

  const run = async () => {
    while (!closed) {
      const job = store.snapshot().prebuilds[0];
      if (!job) {
        for (const done of idlers.splice(0)) done();
        await pause("idle");
        continue;
      }
      busy = true;
      try {
        await runJob(job);
      } catch (error) {
        onWarning(`prebuild of ${job.worktree} failed: ${messageOf(error)}`);
        await remove(job.worktree).catch(() => false);
      } finally {
        busy = false;
      }
    }
    for (const done of idlers.splice(0)) done();
  };

  // A server left in prebuild by a worker that stopped mid-job goes back to the head of the queue.
  const resumeOrphans = () =>
    store.update((draft) => {
      const orphans = Object.values(draft.servers).filter(
        (record) => record.prebuild && record.process && !draft.prebuilds.some((job) => job.worktree === record.worktree),
      );
      const now = new Date(clock.now()).toISOString();
      draft.prebuilds.unshift(...orphans.map((record) => ({ worktree: record.worktree, project: record.project, queuedAt: now, cancels: 0 })));
    });

  return {
    enqueue: async (cwd) => {
      let target: Target;
      try {
        target = await resolve(cwd, projects);
      } catch (error) {
        return { queued: false, why: messageOf(error) };
      }
      const { project } = target;
      const worktree = path.resolve(target.worktree);
      if (!project.warm.prebuild) return { queued: false, worktree, why: `prebuild is off for project ${project.id}` };
      if (project.mainCheckout && realPath(project.mainCheckout) === realPath(worktree))
        return { queued: false, worktree, why: "the main checkout is never prebuilt" };
      const added = await store.update((draft) => {
        if (draft.prebuilds.some((job) => job.worktree === worktree)) return false;
        draft.prebuilds.push({ worktree, project: project.id, queuedAt: new Date(clock.now()).toISOString(), cancels: 0 });
        return true;
      });
      wake.idle?.();
      return { queued: added, worktree, why: added ? `queued behind ${store.snapshot().prebuilds.length - 1} other prebuild(s)` : "already queued" };
    },

    forget: async (worktree) => {
      const key = path.resolve(worktree);
      if (!queued(key)) return false;
      const wasHead = store.snapshot().prebuilds[0]?.worktree === key;
      const removed = await remove(key);
      if (wasHead) wake.retry?.();
      return removed;
    },

    jobs: () => structuredClone(store.snapshot().prebuilds),

    start: () => {
      if (loop || closed) return;
      loop = resumeOrphans()
        .catch((error) => onWarning(`prebuild resume failed: ${messageOf(error)}`))
        .then(run);
    },

    idle: () =>
      new Promise<void>((done) => {
        if (!loop || closed || (!busy && !store.snapshot().prebuilds.length)) done();
        else idlers.push(done);
      }),

    close: () => {
      closed = true;
      for (const finish of [...onClose]) finish();
    },
  };
}
