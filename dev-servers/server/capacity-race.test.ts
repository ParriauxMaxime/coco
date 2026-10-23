import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Holder } from "../shared/contracts.ts";
import { PATIENCE_MS, gitRepo, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { openPortRegistry } from "./ports.ts";
import { waitUntil } from "./proc.ts";
import { createScheduler, countsTowardCap } from "./scheduler.ts";
import { createService, type Capacity } from "./service.ts";
import { openStateStore, serverIdFor, type DevServersState, type JsonStore } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";

const REMOTE = "git@github.example:acme/widgets.git";
const user = (id: string): Holder => ({ kind: "user", id });

let dir = "";

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-race-")));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

// Same per-server serialization as the real supervisor: a start queued behind a stop spawns a new process once the stop is done.
function fakeSupervisor(store: JsonStore<DevServersState>, calls: string[], beforeStopped: (id: string) => Promise<void>): Supervisor {
  const locks = new Map<string, Promise<unknown>>();
  const exclusive = <R>(id: string, task: () => Promise<R>): Promise<R> => {
    const run = (locks.get(id) ?? Promise.resolve()).then(task, task);
    locks.set(
      id,
      run.catch(() => undefined),
    );
    return run;
  };
  let pid = 5000;
  return {
    start: (request) => {
      const id = serverIdFor(request.worktree);
      calls.push(`start ${id}`);
      return exclusive(id, async () => {
        const current = store.snapshot().servers[id];
        if (current?.process && current.state !== "stopping") return current;
        calls.push(`spawn ${id}`);
        pid += 1;
        await store.update((draft) => {
          const now = new Date().toISOString();
          draft.servers[id] = {
            ...draft.servers[id],
            id,
            project: request.project.id,
            worktree: request.worktree,
            port: request.port,
            reserved: request.reserved,
            state: request.prebuild ? "prewarming" : "building",
            stateSince: now,
            process: { pid, pgid: pid, startedAt: now },
            pinned: draft.servers[id]?.pinned ?? false,
            optIns: request.optIns ?? { services: [], dedicatedDb: false, reason: null },
            lastUsedAt: now,
            deadlines: {},
            logs: { run: "/dev/null" },
            ...(request.prebuild && { prebuild: true }),
          };
        });
        return store.snapshot().servers[id];
      });
    },
    stop: (id) =>
      exclusive(id, async () => {
        calls.push(`stop ${id}`);
        await store.update((draft) => void Object.assign(draft.servers[id], { state: "stopping", prebuild: undefined }));
        await beforeStopped(id);
        await store.update((draft) => void Object.assign(draft.servers[id], { state: "stopped", process: null }));
        return { id, found: true, signalled: "group", swept: [], portsBusy: [] };
      }),
    takeOver: (id) =>
      exclusive(id, async () => {
        await store.update((draft) => {
          const record = draft.servers[id];
          delete record.prebuild;
          if (record.state === "prewarming") record.state = "building";
        });
        return store.snapshot().servers[id];
      }),
    forget: async () => true,
    adopt: async () => [],
    get: (id) => store.snapshot().servers[id],
    watching: () => false,
    waitFor: async (id) => store.snapshot().servers[id],
    subscribe: () => () => {},
    close: () => {},
  };
}

const setup = async (cap: number) => {
  const stateDir = path.join(dir, "state");
  const config = parseConfig({ stateDir, cap, worktreeRoots: [dir], coco: { url: null }, projects: [widgets(8100)] });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  await Promise.all([store.load(), ports.load()]);
  const calls: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const stopping = new Map<string, () => void>();
  const supervisor = fakeSupervisor(store, calls, async (id) => {
    stopping.get(id)?.();
    await gates.get(id);
  });
  const scheduler = createScheduler({ store, cap, stop: (id) => supervisor.stop(id), onWarning: () => {} });
  const capacity: Capacity = {
    admit: (target, launch, options) => {
      calls.push(`admit ${target.id}`);
      return scheduler.admit(target, launch, options);
    },
  };
  const service = createService({
    config,
    store,
    ports,
    supervisor,
    capacity,
    place: async (target) => ({ mode: "own", servedFrom: target.worktree, because: [] }),
    probe: async () => "free",
    onWarning: () => {},
  });
  const worktree = (name: string) => gitRepo(path.join(dir, `widgets-${name}`), REMOTE);
  const age = (id: string, iso: string) => store.update((draft) => void (draft.servers[id].lastUsedAt = iso));
  // Holds the stop of one server half-way, until the returned release is called.
  const holdStop = (id: string) => {
    const gate = deferred();
    const begun = deferred();
    gates.set(id, gate.promise);
    stopping.set(id, begun.resolve);
    return { begun: begun.promise, release: gate.resolve };
  };
  // Waits until a start asks the scheduler or the supervisor for the server, the point where it decides whether the server runs.
  const reached = (id: string) => {
    const from = calls.length;
    return waitUntil(() => calls.slice(from).some((call) => call === `admit ${id}` || call === `start ${id}`), PATIENCE_MS, 5);
  };
  const live = () =>
    Object.values(store.snapshot().servers)
      .filter(countsTowardCap)
      .map(({ id }) => id)
      .sort();
  return { config, store, service, calls, worktree, age, holdStop, reached, live };
};

test("a start of the worktree the scheduler is evicting waits for the eviction, then needs a slot like any other start", async () => {
  const { service, worktree, age, holdStop, reached, live } = await setup(2);
  const [a, b, d] = [worktree("a"), worktree("b"), worktree("d")];
  const [ida, idb, idd] = [a, b, d].map(serverIdFor);
  await service.start({ cwd: a }, { holder: user("alice") });
  await service.start({ cwd: b }, { holder: user("bruno") });
  await age(ida, "2026-01-01T00:00:00.000Z");
  await age(idb, "2026-01-02T00:00:00.000Z");

  const evicting = holdStop(ida);
  const forD = service.start({ cwd: d }, { holder: user("dana") });
  await evicting.begun;
  const forA = service.start({ cwd: a }, { holder: user("alice") });
  assert.ok(await reached(ida));
  evicting.release();
  const [startedD, startedA] = await Promise.all([forD, forA]);

  assert.deepEqual(live(), [ida, idd].sort());
  assert.deepEqual(
    startedD.evicted?.map(({ id }) => id),
    [ida],
  );
  assert.deepEqual(
    startedA.evicted?.map(({ id }) => id),
    [idb],
  );
});

test("a start of a prebuild the scheduler is cancelling does not take it over: it waits, then needs a slot", async () => {
  const { config, service, worktree, age, holdStop, reached, live, calls } = await setup(2);
  const [b, p, d] = [worktree("b"), worktree("p"), worktree("d")];
  const [idb, idp, idd] = [b, p, d].map(serverIdFor);
  await service.start({ cwd: b }, { holder: user("bruno") });
  assert.equal((await service.prewarm({ worktree: p, project: config.projects[0] })).outcome, "started");
  await age(idb, "2026-01-01T00:00:00.000Z");

  const cancelling = holdStop(idp);
  const forD = service.start({ cwd: d }, { holder: user("dana") });
  await cancelling.begun;
  const forP = service.start({ cwd: p }, { holder: user("petra") });
  assert.ok(await reached(idp));
  cancelling.release();
  const [startedD, startedP] = await Promise.all([forD, forP]);

  assert.deepEqual(live(), [idd, idp].sort());
  assert.deepEqual(
    startedD.evicted?.map(({ id }) => id),
    [idp],
  );
  assert.deepEqual(
    startedP.evicted?.map(({ id }) => id),
    [idb],
  );
  assert.ok(!startedP.placement.because.some((line) => line.startsWith("took over the prebuild")));
  assert.equal(calls.filter((call) => call === `spawn ${idp}`).length, 2);
});

test("a prebuild queued again right after its cancellation waits for it and finds the cap full", async () => {
  const { config, service, worktree, age, holdStop, live, calls } = await setup(2);
  const [b, p, d] = [worktree("b"), worktree("p"), worktree("d")];
  const [idb, idp, idd] = [b, p, d].map(serverIdFor);
  const target = { worktree: p, project: config.projects[0] };
  await service.start({ cwd: b }, { holder: user("bruno") });
  await service.prewarm(target);
  await age(idb, "2026-01-01T00:00:00.000Z");

  const cancelling = holdStop(idp);
  const forD = service.start({ cwd: d }, { holder: user("dana") });
  await cancelling.begun;
  const again = service.prewarm(target, { warm: false });
  cancelling.release();
  const [, prewarm] = await Promise.all([forD, again]);

  assert.equal(prewarm.outcome, "full");
  assert.deepEqual(live(), [idb, idd].sort());
  assert.equal(calls.filter((call) => call === `spawn ${idp}`).length, 1);
});
