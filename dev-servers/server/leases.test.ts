import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Holder } from "../shared/contracts.ts";
import { createLeaseManager, openLeaseStore, type Clock, type LeaseManager } from "./leases.ts";
import { openStateStore, type ServerRecord } from "./store.ts";

const MINUTE = 60_000;

type Timer = { at: number; run: () => void; cancelled: boolean };

const fakeClock = (start = Date.parse("2026-03-02T09:00:00.000Z")) => {
  let now = start;
  const timers: Timer[] = [];
  const clock: Clock & { advance(ms: number): Promise<void>; at(offsetMs: number): string } = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => void (timer.cancelled = true) };
    },
    advance: async (ms) => {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        now = Math.max(now, due.at);
        due.run();
        for (const manager of managers) await manager.flush();
      }
      now = target;
    },
    at: (offsetMs) => new Date(start + offsetMs).toISOString(),
  };
  return clock;
};

let dir = "";
let clock = fakeClock();
let managers: LeaseManager[] = [];
let stopped: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-leases-"));
  clock = fakeClock();
  managers = [];
  stopped = [];
});

afterEach(() => {
  for (const manager of managers) manager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const agent = (id: string): Holder => ({ kind: "agent", id });

const setup = async ({ idleStopMinutes = 30, leaseTtlMinutes = 240 } = {}) => {
  const servers = openStateStore(dir);
  const store = openLeaseStore(dir);
  await servers.load();
  await store.load();
  const manager = createLeaseManager({
    store,
    servers,
    idleStopMinutes,
    leaseTtlMinutes,
    clock,
    onWarning: () => {},
    stopIdle: async (id) => {
      stopped.push(`${id}@${new Date(clock.now()).toISOString()}`);
      await servers.update((draft) => {
        Object.assign(draft.servers[id], { state: "stopped", process: null });
      });
    },
  });
  managers.push(manager);

  const seed = async (id: string, patch: Partial<ServerRecord> = {}) => {
    const now = new Date(clock.now()).toISOString();
    await servers.update((draft) => {
      draft.servers[id] = {
        id,
        project: "widgets",
        worktree: `/work/${id}`,
        port: 8100,
        reserved: [8100],
        state: "ready",
        stateSince: now,
        process: { pid: 4242, pgid: 4242, startedAt: "Mon Mar  2 09:00:00 2026" },
        pinned: false,
        optIns: { services: [], dedicatedDb: false, reason: null },
        lastUsedAt: now,
        deadlines: {},
        logs: { run: "/dev/null" },
        ...patch,
      };
    });
  };
  const server = (id: string) => servers.snapshot().servers[id];
  return { manager, servers, store, seed, server };
};

test("a lease keeps a server ready; the last release starts the idle timer, which stops it when the delay runs out", async () => {
  const { manager, seed, server, servers } = await setup();
  await seed("wt_a", { state: "building" });
  await manager.book.take("wt_a", agent("dk_alice"));
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines], ["building", {}]);

  await servers.update((draft) => void (draft.servers.wt_a.state = "ready"));
  await manager.settle("wt_a");
  const second = await manager.book.take("wt_a", agent("dk_bruno"));
  assert.deepEqual(await manager.book.take("wt_a", agent("dk_bruno")), second);
  assert.deepEqual(
    manager.book.holders("wt_a").map(({ holder }) => holder.id),
    ["dk_alice", "dk_bruno"],
  );

  await manager.book.release("wt_a", agent("dk_alice"));
  await clock.advance(120 * MINUTE);
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines, stopped], ["ready", {}, []]);

  await manager.book.release("wt_a", agent("dk_bruno"));
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines.idle], ["idle", clock.at(150 * MINUTE)]);
  await clock.advance(30 * MINUTE - 1);
  assert.deepEqual(stopped, []);
  await clock.advance(1);
  assert.deepEqual(stopped, [`wt_a@${clock.at(150 * MINUTE)}`]);
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines], ["stopped", {}]);
});

test("taking an idle server back cancels its stop, and a touch pushes the stop back", async () => {
  const { manager, seed, server, servers } = await setup();
  await seed("wt_a");
  await manager.settleAll();
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines.idle], ["idle", clock.at(30 * MINUTE)]);

  await clock.advance(20 * MINUTE);
  await manager.book.take("wt_a", agent("dk_alice"));
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines], ["ready", {}]);
  await clock.advance(60 * MINUTE);
  assert.deepEqual(stopped, []);

  await manager.book.release("wt_a", agent("dk_alice"));
  await clock.advance(20 * MINUTE);
  await servers.update((draft) => void (draft.servers.wt_a.lastUsedAt = new Date(clock.now()).toISOString()));
  await clock.advance(15 * MINUTE);
  assert.deepEqual(stopped, []);
  await clock.advance(15 * MINUTE);
  assert.deepEqual(stopped, [`wt_a@${clock.at(130 * MINUTE)}`]);
});

test("a lease nobody touches for the TTL expires, then the server idles out", async () => {
  const { manager, seed, server } = await setup();
  await seed("wt_a");
  await manager.book.take("wt_a", agent("dk_alice"));
  await clock.advance(180 * MINUTE);
  await manager.touch(agent("dk_alice"));
  assert.equal(server("wt_a").lastUsedAt, clock.at(180 * MINUTE));

  await clock.advance(239 * MINUTE);
  assert.deepEqual(manager.heldBy(agent("dk_alice")), ["wt_a"]);
  await clock.advance(MINUTE);
  assert.deepEqual(manager.heldBy(agent("dk_alice")), []);
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines.idle], ["idle", clock.at(450 * MINUTE)]);
  await clock.advance(30 * MINUTE);
  assert.deepEqual(stopped, [`wt_a@${clock.at(450 * MINUTE)}`]);
});

test("keys bind to agents first in, first out per directory; archiving an agent drops its leases and keys", async () => {
  const { manager, seed, server, store } = await setup();
  await seed("wt_a");
  const first = await manager.issueKey("/work/a", "Fix the widget");
  const second = await manager.issueKey("/work/a/");
  const late = await manager.issueKey("/work/b");
  assert.match(first, /^dk_[A-Za-z0-9_-]{16}$/);

  assert.equal(await manager.bindAgent({ agentId: "agent-1", cwd: "/work/a" }), first);
  assert.equal(await manager.bindAgent({ agentId: "agent-1", cwd: "/work/a", title: "Fix the widget now" }), first);
  assert.equal(await manager.bindAgent({ agentId: "agent-2", cwd: "/work/a" }), second);
  assert.equal(await manager.bindAgent({ agentId: "agent-3", cwd: "/work/a" }), null);
  await clock.advance(61_000);
  assert.equal(await manager.bindAgent({ agentId: "agent-4", cwd: "/work/b" }), null);
  assert.equal((await manager.key(late)).cwd, "/work/b");
  assert.deepEqual(await manager.key("dk_unknownkey1", "/work/c"), { cwd: "/work/c", issuedAt: clock.at(61_000), lastUsedAt: clock.at(61_000) });

  await manager.book.take("wt_a", agent(first));
  await manager.book.take("wt_a", agent(second));
  assert.deepEqual(
    manager.book.holders("wt_a").map(({ holder }) => holder.title),
    ["Fix the widget now", "agent agent-2"],
  );

  assert.deepEqual(await manager.releaseAgent("agent-1"), ["wt_a"]);
  assert.deepEqual(
    manager.book.holders("wt_a").map(({ holder }) => holder.id),
    [second],
  );
  assert.equal(store.snapshot().keys[first], undefined);
  assert.equal(server("wt_a").state, "ready");
  assert.deepEqual(await manager.releaseAgent("agent-1"), []);
  await manager.releaseAgent("agent-2");
  assert.deepEqual([server("wt_a").state, server("wt_a").deadlines.idle], ["idle", clock.at(61_000 + 30 * MINUTE)]);
});

test("a pinned server never idles out, a stopped server loses its leases, and deadlines survive a reload", async () => {
  const { manager, seed, server, servers } = await setup();
  await seed("wt_pinned", { pinned: true });
  await seed("wt_gone");
  await seed("wt_later");
  await manager.book.take("wt_gone", agent("dk_alice"));
  await manager.book.take("wt_later", agent("dk_alice"));
  await manager.settleAll();
  assert.deepEqual([server("wt_pinned").state, server("wt_pinned").deadlines], ["idle", {}]);

  await servers.update((draft) => void Object.assign(draft.servers.wt_gone, { state: "stopped", process: null }));
  await manager.settle("wt_gone");
  assert.deepEqual(manager.heldBy(agent("dk_alice")), ["wt_later"]);
  assert.deepEqual(manager.book.holders("wt_gone"), []);

  await manager.book.release("wt_later", agent("dk_alice"));
  manager.close();
  await clock.advance(2 * 24 * 60 * MINUTE);
  assert.deepEqual(stopped, []);

  const reloaded = await setup();
  await reloaded.manager.settleAll();
  assert.deepEqual(stopped, [`wt_later@${clock.at(2 * 24 * 60 * MINUTE)}`]);
  assert.equal(reloaded.server("wt_pinned").state, "idle");
});
