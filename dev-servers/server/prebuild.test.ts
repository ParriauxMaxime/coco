import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig } from "./config.ts";
import { ServiceError } from "./errors.ts";
import type { Clock } from "./leases.ts";
import { createPrebuildQueue, type PrebuildQueue } from "./prebuild.ts";
import { waitUntil } from "./proc.ts";
import type { FinishResult, PrewarmResult } from "./service.ts";
import { openStateStore, serverIdFor, type ServerRecord } from "./store.ts";

let dir = "";
let queues: PrebuildQueue[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-prebuild-")));
  queues = [];
});

afterEach(() => {
  for (const queue of queues) queue.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Script = { prewarm?: (name: string, call: number) => PrewarmResult["outcome"]; finish?: (name: string, call: number) => FinishResult["outcome"] };

const setup = async (script: Script = {}, { maxCancels = 2, start = true } = {}) => {
  const store = openStateStore(path.join(dir, "state"));
  await store.load();
  const projects = parseConfig({
    projects: [
      {
        id: "widgets",
        match: { paths: [path.join(dir, "widgets")] },
        command: ["true"],
        mainCheckout: path.join(dir, "widgets", "main"),
        warm: { prebuild: true },
      },
      { id: "gadgets", match: { paths: [path.join(dir, "gadgets")] }, command: ["true"] },
    ],
  }).projects;
  const listeners = new Set<(record: ServerRecord) => void>();
  const timers: { ms: number; run: () => void; done: boolean }[] = [];
  const clock: Clock = {
    now: () => Date.now(),
    setTimeout: (run, ms) => {
      const timer = { ms, run, done: false };
      timers.push(timer);
      return { cancel: () => void (timer.done = true) };
    },
  };
  const events: string[] = [];
  const logs: string[] = [];
  const calls = new Map<string, number>();
  let building = 0;
  let mostAtOnce = 0;
  const nameOf = (worktree: string) => path.basename(worktree);
  const count = (key: string) => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return calls.get(key)!;
  };
  const setState = async (id: string, worktree: string, state: ServerRecord["state"], prebuild: boolean) => {
    await store.update((draft) => {
      draft.servers[id] = {
        id,
        project: "widgets",
        worktree,
        port: 8100,
        reserved: [8100],
        state,
        stateSince: new Date().toISOString(),
        process: state === "stopped" ? null : { pid: 4242, pgid: 4242, startedAt: "Mon Mar  2 09:00:00 2026" },
        pinned: false,
        ...(prebuild && { prebuild: true as const }),
        optIns: { services: [], dedicatedDb: false, reason: null },
        lastUsedAt: new Date().toISOString(),
        deadlines: {},
        logs: { run: "/dev/null" },
      };
    });
    for (const listener of listeners) listener(store.snapshot().servers[id]);
  };

  const queue = createPrebuildQueue({
    store,
    projects,
    clock,
    maxCancels,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    resolve: async (cwd, all) => {
      const project = all.find(({ match }) => match.paths?.some((root) => cwd.startsWith(root)));
      if (!project) throw new ServiceError("not_a_project_worktree", `${cwd} matches no configured project`);
      return { worktree: cwd, project };
    },
    service: {
      prewarm: async (target, { warm } = {}) => {
        const name = nameOf(target.worktree);
        const id = serverIdFor(target.worktree);
        events.push(`prewarm ${name}${warm ? " +warm" : ""}`);
        const outcome = script.prewarm?.(name, count(`prewarm ${name}`)) ?? "started";
        if (outcome === "started") {
          building += 1;
          mostAtOnce = Math.max(mostAtOnce, building);
          await setState(id, target.worktree, "prewarming", true);
          setImmediate(() => void setState(id, target.worktree, "ready", true));
        }
        return { id, outcome, warmed: [] };
      },
      finishPrewarm: async (id) => {
        const record = store.snapshot().servers[id];
        const name = nameOf(record.worktree);
        events.push(`finish ${name}`);
        building -= 1;
        await setState(id, record.worktree, "stopped", false);
        return { id, outcome: script.finish?.(name, count(`finish ${name}`)) ?? "done" };
      },
    },
    onLog: (message) => logs.push(message),
    onWarning: (message) => logs.push(`warning: ${message}`),
  });
  queues.push(queue);
  if (start) queue.start();
  const worktree = (name: string) => path.join(dir, "widgets", name);
  const fireRetries = () => {
    for (const timer of timers) {
      if (timer.done || timer.ms > 10 * 60_000) continue;
      timer.done = true;
      timer.run();
    }
  };
  return { store, queue, events, logs, timers, worktree, setState, fireRetries, mostAtOnce: () => mostAtOnce };
};

test("prebuilds run one at a time in the order their workspaces were created, each warmed once, built, then stopped", async () => {
  const { queue, events, logs, worktree, mostAtOnce } = await setup();
  const results = [];
  for (const name of ["alpha", "bravo", "charlie"]) results.push(await queue.enqueue(worktree(name)));
  assert.deepEqual(
    results.map(({ queued }) => queued),
    [true, true, true],
  );
  assert.deepEqual(await queue.enqueue(worktree("bravo")), { queued: false, worktree: worktree("bravo"), why: "already queued" });
  await queue.idle();
  assert.deepEqual(events, ["prewarm alpha +warm", "finish alpha", "prewarm bravo +warm", "finish bravo", "prewarm charlie +warm", "finish charlie"]);
  assert.equal(mostAtOnce(), 1);
  assert.deepEqual(queue.jobs(), []);
  assert.deepEqual(
    logs.map((line) => line.replace(dir, "")),
    ["prebuild of /widgets/alpha finished", "prebuild of /widgets/bravo finished", "prebuild of /widgets/charlie finished"],
  );
});

test("only worktrees of a project with prebuild on are queued, never its main checkout", async () => {
  const { queue, events } = await setup({}, { start: false });
  assert.equal((await queue.enqueue(path.join(dir, "widgets", "main"))).why, "the main checkout is never prebuilt");
  assert.equal((await queue.enqueue(path.join(dir, "gadgets", "alpha"))).why, "prebuild is off for project gadgets");
  assert.match((await queue.enqueue(path.join(dir, "notes"))).why, /matches no configured project/);
  assert.deepEqual(queue.jobs(), []);
  assert.deepEqual(events, []);
});

test("at the cap a prebuild waits and retries with a growing delay, warming only on its first try, and never stops anything", async () => {
  const { queue, events, timers, worktree, fireRetries } = await setup({ prewarm: (name, call) => (name === "alpha" && call <= 2 ? "full" : "started") });
  await queue.enqueue(worktree("alpha"));
  await queue.enqueue(worktree("bravo"));
  for (const expected of [1, 2]) {
    assert.ok(await waitUntil(() => timers.filter(({ done, ms }) => !done && ms < 10 * 60_000).length === 1, 2000));
    assert.equal(events.filter((event) => event.startsWith("prewarm alpha")).length, expected);
    assert.ok(!events.some((event) => event.includes("bravo")));
    fireRetries();
  }
  await queue.idle();
  assert.deepEqual(
    timers.filter(({ ms }) => ms < 10 * 60_000).map(({ ms }) => ms),
    [15_000, 30_000],
  );
  assert.deepEqual(events, ["prewarm alpha +warm", "prewarm alpha", "prewarm alpha", "finish alpha", "prewarm bravo +warm", "finish bravo"]);
});

test("a prebuild cancelled to make room goes to the back of the queue, and is dropped after being cancelled too often", async () => {
  const { queue, events, logs, worktree } = await setup({ finish: (name) => (name === "alpha" ? "cancelled" : "done") });
  await queue.enqueue(worktree("alpha"));
  await queue.enqueue(worktree("bravo"));
  await queue.idle();
  assert.deepEqual(events, [
    "prewarm alpha +warm",
    "finish alpha",
    "prewarm bravo +warm",
    "finish bravo",
    "prewarm alpha +warm",
    "finish alpha",
    "prewarm alpha +warm",
    "finish alpha",
  ]);
  assert.deepEqual(queue.jobs(), []);
  assert.deepEqual(
    logs.map((line) => line.replace(dir, "")),
    [
      "prebuild of /widgets/alpha was cancelled to make room; queued again",
      "prebuild of /widgets/bravo finished",
      "prebuild of /widgets/alpha was cancelled to make room; queued again",
      "warning: prebuild of /widgets/alpha dropped after being cancelled 3 times to make room",
    ],
  );
});

test("a queued prebuild that a start or an archive takes out is never run, even while it waits for a slot", async () => {
  const { queue, events, worktree, timers } = await setup({ prewarm: (name) => (name === "alpha" ? "full" : "started") });
  await queue.enqueue(worktree("alpha"));
  await queue.enqueue(worktree("bravo"));
  await queue.enqueue(worktree("charlie"));
  assert.ok(await waitUntil(() => timers.some(({ done, ms }) => !done && ms < 10 * 60_000), 2000));
  assert.equal(await queue.forget(worktree("charlie")), true);
  assert.equal(await queue.forget(worktree("alpha")), true);
  assert.equal(await queue.forget(worktree("alpha")), false);
  await queue.idle();
  assert.deepEqual(events, ["prewarm alpha +warm", "prewarm bravo +warm", "finish bravo"]);
});

test("a start that took over the prebuild ends the job without stopping the server, and a prebuild left running by a reload is finished", async () => {
  const { store, queue, events, logs, worktree, setState } = await setup({ finish: () => "taken-over" }, { start: false });
  const orphan = worktree("alpha");
  await setState(serverIdFor(orphan), orphan, "prewarming", true);
  queue.start();
  assert.ok(await waitUntil(() => queue.jobs().length === 1, 2000));
  assert.equal(queue.jobs()[0].worktree, orphan);
  assert.deepEqual(events, []);
  await setState(serverIdFor(orphan), orphan, "ready", true);
  await queue.idle();
  assert.deepEqual(events, ["finish alpha"]);
  assert.deepEqual(store.snapshot().prebuilds, []);
  assert.deepEqual(
    logs.map((line) => line.replace(dir, "")),
    ["prebuild of /widgets/alpha was taken over by a start"],
  );
});
