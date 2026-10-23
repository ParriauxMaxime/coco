import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Holder } from "../shared/contracts.ts";
import { ServiceError } from "./errors.ts";
import { createLeaseManager, openLeaseStore, type Clock, type LeaseManager } from "./leases.ts";
import { createScheduler } from "./scheduler.ts";
import { openStateStore, type DevServersState, type ServerRecord } from "./store.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-03-02T09:00:00.000Z");

let dir = "";
let now = START;
let managers: LeaseManager[] = [];
const clock: Clock = { now: () => now, setTimeout: () => ({ cancel: () => {} }) };
const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();
const agent = (id: string): Holder => ({ kind: "agent", id });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-scheduler-"));
  now = START;
  managers = [];
});

afterEach(() => {
  for (const manager of managers) manager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup = async (cap: number) => {
  const store = openStateStore(dir);
  const leaseStore = openLeaseStore(dir);
  await store.load();
  await leaseStore.load();
  const events: string[] = [];
  const stopServer = (draft: DevServersState, id: string) => Object.assign(draft.servers[id], { state: "stopped", process: null });
  const leases = createLeaseManager({ store: leaseStore, servers: store, idleStopMinutes: 30, leaseTtlMinutes: 240, clock, stopIdle: async () => {} });
  managers.push(leases);
  const scheduler = createScheduler({
    store,
    cap,
    leases: leases.book,
    onWarning: () => {},
    stop: async (id) => {
      events.push(`stop ${id}`);
      await store.update((draft) => void stopServer(draft, id));
    },
  });

  const seed = (id: string, minutes: number, patch: Partial<ServerRecord> = {}) =>
    store.update((draft) => {
      draft.servers[id] = {
        id,
        project: "widgets",
        worktree: `/work/${id}`,
        port: 8100,
        reserved: [8100],
        state: "ready",
        stateSince: at(minutes),
        process: { pid: 4242, pgid: 4242, startedAt: "Mon Mar  2 09:00:00 2026" },
        pinned: false,
        optIns: { services: [], dedicatedDb: false, reason: null },
        lastUsedAt: at(minutes),
        deadlines: {},
        logs: { run: "/dev/null" },
        ...patch,
      };
    });

  const start = (id: string, options?: { evict?: boolean }) =>
    scheduler.admit(
      { id, worktree: `/work/${id}` },
      async () => {
        events.push(`launch ${id}`);
        await seed(id, (now - START) / MINUTE);
      },
      options,
    );

  return { store, leases, scheduler, events, seed, start };
};

const capacityFull = (error: unknown) => error instanceof ServiceError && error.code === "capacity_full" && Array.isArray(error.details?.servers);

test("at the cap a start stops the least recently used server first, and its holders find a lost notice on their next call", async () => {
  const { store, leases, events, seed, start } = await setup(3);
  await seed("wt_a", 0);
  await seed("wt_b", 1);
  await seed("wt_c", 2);
  await leases.book.take("wt_a", agent("dk_alice"));
  await leases.book.take("wt_b", agent("dk_bruno"));
  now = START + 5 * MINUTE;
  await leases.touch(agent("dk_alice"));

  const first = await start("wt_d");
  assert.deepEqual(events, ["stop wt_b", "launch wt_d"]);
  assert.deepEqual(first.evicted, [{ id: "wt_b", worktree: "/work/wt_b", why: "it was the least recently used of the 3 running servers" }]);
  assert.deepEqual(leases.book.holders("wt_b"), []);

  const [notice, ...others] = await leases.takeLost(agent("dk_bruno"));
  assert.deepEqual(others, []);
  assert.deepEqual(
    { serverId: notice.serverId, worktree: notice.worktree, why: notice.why, at: notice.at },
    {
      serverId: "wt_b",
      worktree: "/work/wt_b",
      why: "stopped to make room for /work/wt_d: it was the least recently used of the 3 running servers",
      at: at(5),
    },
  );
  assert.deepEqual(await leases.takeLost(agent("dk_bruno")), []);
  assert.deepEqual(await leases.takeLost(agent("dk_alice")), []);
  assert.equal(leases.lostNotices().length, 1);

  events.length = 0;
  await start("wt_e");
  assert.deepEqual(events, ["stop wt_c", "launch wt_e"]);
  assert.deepEqual(
    Object.values(store.snapshot().servers)
      .filter((record) => record.process)
      .map(({ id }) => id)
      .sort(),
    ["wt_a", "wt_d", "wt_e"],
  );
});

test("pinned and external servers are never evicted, and when only they are left the start gets capacity_full with the list", async () => {
  const { store, events, seed, start } = await setup(3);
  await seed("wt_pinned", 0, { pinned: true });
  await seed("wt_hand", 1, { state: "external", process: null, logs: { run: "" } });
  await seed("wt_crashed", 5, { state: "crashed" });
  await seed("wt_dead", 2, { state: "crashed", process: null });
  await seed("wt_stopped", 3, { state: "stopped", process: null });

  const { evicted } = await start("wt_new");
  assert.deepEqual(
    evicted.map(({ id }) => id),
    ["wt_crashed"],
  );

  events.length = 0;
  await store.update((draft) => void (draft.servers.wt_new.pinned = true));
  await assert.rejects(start("wt_more"), (error: ServiceError) => {
    assert.ok(capacityFull(error));
    assert.match(error.message, /pinned or were started outside the plugin/);
    const servers = error.details?.servers as { id: string; pinned: boolean; external: boolean }[];
    assert.deepEqual(servers.map(({ id, pinned, external }) => [id, pinned, external]).sort(), [
      ["wt_hand", false, true],
      ["wt_new", true, false],
      ["wt_pinned", true, false],
    ]);
    return true;
  });
  assert.deepEqual(events, []);
});

test("a prebuild counts only while it builds, is cancelled before any other server, and a prebuild never evicts", async () => {
  const { store, events, seed, start } = await setup(2);
  await seed("wt_old", 0);
  await seed("wt_prebuild", 9, { state: "prewarming" });
  const cancelled = await start("wt_a");
  assert.deepEqual(events, ["stop wt_prebuild", "launch wt_a"]);
  assert.deepEqual(cancelled.evicted[0].why, "it was only a prebuild");

  events.length = 0;
  await store.update((draft) => void delete draft.servers.wt_a);
  await seed("wt_prebuild", 9, { state: "stopped", process: null });
  await start("wt_b");
  assert.deepEqual(events, ["launch wt_b"]);

  events.length = 0;
  await assert.rejects(start("wt_queued", { evict: false }), capacityFull);
  assert.deepEqual(events, []);
  await seed("wt_prebuild", 10, { state: "prewarming" });
  await store.update((draft) => void delete draft.servers.wt_b);
  await assert.rejects(start("wt_queued", { evict: false }), capacityFull);
  assert.deepEqual(events, []);
});

test("two starts racing for the last slot never both take it, and a restart of a counted server needs no room", async () => {
  const { store, events, seed, start } = await setup(2);
  await seed("wt_old", 0);
  now = START + MINUTE;
  const [x, y] = await Promise.all([start("wt_x"), start("wt_y")]);
  assert.deepEqual(events, ["launch wt_x", "stop wt_old", "launch wt_y"]);
  assert.deepEqual([x.evicted.length, y.evicted.map(({ id }) => id)], [0, ["wt_old"]]);

  events.length = 0;
  await start("wt_x");
  assert.deepEqual(events, ["launch wt_x"]);
  assert.equal(Object.values(store.snapshot().servers).filter((record) => record.process).length, 2);
});
