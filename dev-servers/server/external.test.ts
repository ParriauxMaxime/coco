import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Holder } from "../shared/contracts.ts";
import { FIXTURE, freePort, gitRepo, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { createExternalScanner } from "./external.ts";
import { createLeaseManager, openLeaseStore, type Clock, type LeaseManager } from "./leases.ts";
import { openPortRegistry } from "./ports.ts";
import { isAlive, waitUntil } from "./proc.ts";
import { probeHttp } from "./readiness.ts";
import { createScheduler } from "./scheduler.ts";
import { createService, type DevServersService } from "./service.ts";
import { openStateStore, serverIdFor, type DevServersState, type JsonStore } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

const HEALTH = { path: "/health", bodyIncludes: "ok" };
const REMOTE = "git@github.example:acme/widgets.git";

let dir = "";
let stateDir = "";
let byHand: ChildProcess[] = [];
let running: { supervisor: Supervisor; store: JsonStore<DevServersState>; leases: LeaseManager }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-external-")));
  stateDir = path.join(dir, "state");
  byHand = [];
  running = [];
});

afterEach(async () => {
  for (const { supervisor, leases } of running) {
    leases.close();
    supervisor.close();
  }
  for (const child of byHand) child.kill("SIGKILL");
  await killTestProcesses(
    running.map(({ store }) => store),
    stateDir,
    dir,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const startByHand = async (cwd: string) => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, "--port", String(port), "--ttl", "60"], { cwd, stdio: "ignore" });
  byHand.push(child);
  assert.ok(await waitUntil(() => probeHttp(`http://127.0.0.1:${port}`, HEALTH, 300), 10_000), "the hand-started fixture never answered");
  return { child, port };
};

const serve = async (cap: number) => {
  const config = parseConfig({
    stateDir,
    cap,
    worktreeRoots: [dir],
    coco: { url: null },
    projects: [widgets(await freePort(), { match: { paths: [dir] }, adopt: { probe: HEALTH } })],
  });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((project) => project.id === id), pollMs: 100 });
  let now = Date.now();
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => void (timer.cancelled = true) };
    },
  };
  const idleStops: string[] = [];
  let service: DevServersService | null = null;
  const leases = createLeaseManager({
    store: leaseStore,
    servers: store,
    idleStopMinutes: 30,
    leaseTtlMinutes: 240,
    clock,
    onWarning: () => {},
    stopIdle: async (id) => {
      idleStops.push(id);
      await service!.stop(id, {}, { holder: { kind: "user", id: "idle-timer" } });
    },
  });
  running.push({ supervisor, store, leases });
  const externals = createExternalScanner({ store, projects: config.projects, leases: leases.book, onWarning: () => {} });
  const capacity = createScheduler({ store, cap, stop: (id) => supervisor.stop(id), leases: leases.book, onWarning: () => {} });
  service = createService({ config, store, ports, supervisor, leases: leases.book, capacity, externals });
  supervisor.subscribe((record) => void leases.settle(record.id));
  const advance = async (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.cancelled || timer.at > now) continue;
      timer.cancelled = true;
      timer.run();
    }
    await leases.flush();
  };
  return { service, store, supervisor, leases, externals, idleStops, advance };
};

const user = (id: string): Holder => ({ kind: "user", id });
const errorCode = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

test("a server started by hand is adopted as external, used read-only, and never stopped by a stop, a force stop or the idle timer", async () => {
  const handTree = gitRepo(path.join(dir, "widgets-hand"), REMOTE);
  const deepTree = gitRepo(path.join(dir, "widgets-deep"), REMOTE);
  const { child, port } = await startByHand(handTree);
  const deep = await startByHand(path.join(deepTree, "src"));
  const { service, store, supervisor, leases, externals, idleStops, advance } = await serve(3);
  const id = serverIdFor(handTree);

  assert.deepEqual(await externals.scan(), [{ id, worktree: handTree, port, change: "adopted" }]);
  assert.deepEqual(Object.keys(store.snapshot().servers), [id]);
  const record = store.snapshot().servers[id];
  assert.deepEqual([record.state, record.process, record.external?.pid, record.port], ["external", null, child.pid, port]);
  assert.deepEqual(await externals.scan(), []);

  const alice = user("alice");
  const started = await service.start({ cwd: handTree }, { holder: alice });
  assert.equal(started.placement.mode, "external");
  assert.match(started.placement.because.join("\n"), new RegExp(`its server on port ${port} was started outside the plugin`));
  assert.ok(started.lease);
  assert.deepEqual([started.server.state, started.server.url], ["external", `http://127.0.0.1:${port}`]);
  assert.match(started.next, /started outside the plugin/);
  assert.equal(store.snapshot().servers[id].process, null);

  const kept = await service.stop(id, {}, { holder: alice });
  assert.deepEqual([kept.stopped, kept.kept, kept.server.leases], [false, "external", []]);
  await assert.rejects(service.stop(id, { force: true }, { holder: user("coco") }), errorCode("external_readonly"));
  assert.equal((await supervisor.stop(id)).signalled, "refused");
  await assert.rejects(service.pin(id, {}, { holder: alice }), errorCode("external_readonly"));
  await assert.rejects(service.logs(id, {}), errorCode("not_found"));
  await assert.rejects(service.start({ cwd: handTree, services: ["mailer"], reason: "check the mail" }, { holder: alice }), errorCode("external_readonly"));

  await service.start({ cwd: handTree }, { holder: user("bruno") });
  await service.stop(id, {}, { holder: user("bruno") });
  assert.deepEqual(store.snapshot().servers[id].deadlines, {});
  await advance(3 * 60 * 60_000);
  assert.deepEqual(idleStops, []);
  assert.ok(isAlive(child.pid!));
  assert.ok(isAlive(deep.child.pid!));
  assert.ok(await probeHttp(`http://127.0.0.1:${port}`, HEALTH, 1000));

  await service.start({ cwd: handTree }, { holder: alice });
  child.kill("SIGTERM");
  assert.ok(await waitUntil(() => !isAlive(child.pid!), 5000));
  assert.deepEqual(await externals.scan(), [{ id, worktree: handTree, port, change: "gone" }]);
  assert.deepEqual(store.snapshot().servers, {});
  const [notice] = await leases.takeLost(alice);
  assert.equal(notice.worktree, handTree);
  assert.match(notice.why, /started outside the plugin is no longer running/);
});

test("a server started by hand takes a slot that is never freed for another: the plugin evicts its own servers, then answers capacity_full", async () => {
  const handTree = gitRepo(path.join(dir, "widgets-hand"), REMOTE);
  const [second, third, fourth] = ["widgets-second", "widgets-third", "widgets-fourth"].map((name) => gitRepo(path.join(dir, name), REMOTE));
  const { child } = await startByHand(handTree);
  const { service, store } = await serve(2);

  const opted = await service.start({ cwd: second, services: ["mailer"], reason: "check the welcome mail" }, { holder: user("alice") });
  assert.equal(opted.evicted, undefined);
  assert.match(
    opted.placement.because.join("\n"),
    /a server started outside the plugin runs .*widgets-hand on port \d+ with its own settings.*mailer may run twice/,
  );
  assert.equal(store.snapshot().servers[serverIdFor(handTree)].state, "external");

  const next = await service.start({ cwd: third, pin: true }, { holder: user("bruno") });
  assert.deepEqual(
    next.evicted?.map(({ worktree }) => worktree),
    [second],
  );
  assert.match(
    next.placement.because.join("\n"),
    /stopped the server of .*widgets-second to make room: it was the least recently used of the 2 running servers/,
  );
  assert.equal(store.snapshot().servers[serverIdFor(second)].state, "stopped");
  assert.deepEqual(next.server.pinnedBy, { kind: "user", id: "bruno" });

  await assert.rejects(service.start({ cwd: fourth }, { holder: user("chloe") }), (error: unknown) => {
    assert.ok(errorCode("capacity_full")(error));
    const servers = (error as ServiceError).details?.servers as { worktree: string; external: boolean; pinned: boolean }[];
    assert.deepEqual(servers.map(({ worktree, external, pinned }) => [path.basename(worktree), external, pinned]).sort(), [
      ["widgets-hand", true, false],
      ["widgets-third", false, true],
    ]);
    return true;
  });
  assert.equal(store.snapshot().servers[serverIdFor(fourth)], undefined);
  assert.ok(isAlive(child.pid!));
});
