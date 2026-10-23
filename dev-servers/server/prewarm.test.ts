import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Holder } from "../shared/contracts.ts";
import { FIXTURE, freePort, gitRepo, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { createLeaseManager, openLeaseStore, type Clock, type LeaseManager } from "./leases.ts";
import { openPortRegistry } from "./ports.ts";
import { createPrebuildQueue, type PrebuildQueue } from "./prebuild.ts";
import { isAlive, waitUntil } from "./proc.ts";
import { createScheduler } from "./scheduler.ts";
import { createService, type DevServersService } from "./service.ts";
import { openStateStore, serverIdFor, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

const REMOTE = "git@github.example:acme/widgets.git";

let dir = "";
let stateDir = "";
let main = "";
let running: { supervisor: Supervisor; store: JsonStore<DevServersState>; leases: LeaseManager; queue: PrebuildQueue }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-prewarm-")));
  stateDir = path.join(dir, "state");
  main = gitRepo(path.join(dir, "widgets-main"), REMOTE);
  fs.mkdirSync(path.join(main, "node_modules", "left-pad"), { recursive: true });
  fs.writeFileSync(path.join(main, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(main, ".cache"), { recursive: true });
  fs.writeFileSync(path.join(main, ".cache", "widgets.bundle"), "compiled widgets\n");
  running = [];
});

afterEach(async () => {
  for (const { supervisor, leases, queue } of running) {
    queue.close();
    leases.close();
    supervisor.close();
  }
  await killTestProcesses(
    running.map(({ store }) => store),
    stateDir,
    dir,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const serve = async ({ cap = 3, buildMs = 150, startQueue = true, settings = false } = {}) => {
  const config = parseConfig({
    stateDir,
    cap,
    worktreeRoots: [dir],
    coco: { url: null },
    projects: [
      widgets(await freePort(), {
        mainCheckout: main,
        command: ["node", FIXTURE, "--port", "{port}", "--ttl", "30", "--build-ms", String(buildMs)],
        warm: { symlink: ["node_modules"], clone: [".cache"], prebuild: true },
        ...(settings && { settings: { file: "widgets.settings.json", overlay: { port: "{port}" } } }),
      }),
    ],
  });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((project) => project.id === id), pollMs: 100 });
  const leases = createLeaseManager({
    store: leaseStore,
    servers: store,
    idleStopMinutes: 30,
    leaseTtlMinutes: 240,
    stopIdle: async () => {},
    onWarning: () => {},
  });
  const capacity = createScheduler({ store, cap, stop: (id) => supervisor.stop(id), leases: leases.book, onWarning: () => {} });
  const logs: string[] = [];
  let service: DevServersService | null = null;
  const queue = createPrebuildQueue({
    store,
    projects: config.projects,
    service: { prewarm: (target, options) => service!.prewarm(target, options), finishPrewarm: (id) => service!.finishPrewarm(id) },
    subscribe: supervisor.subscribe,
    clock: refClock,
    retryMs: [100],
    onLog: (message) => logs.push(message.replaceAll(dir, "")),
    onWarning: (message) => logs.push(`warning: ${message.replaceAll(dir, "")}`),
  });
  service = createService({ config, store, ports, supervisor, leases: leases.book, capacity, prebuilds: queue, onWarning: () => {} });
  supervisor.subscribe((record) => void leases.settle(record.id));
  running.push({ supervisor, store, leases, queue });
  if (startQueue) queue.start();
  return { service, store, ports, supervisor, leases, queue, logs };
};

const user = (id: string): Holder => ({ kind: "user", id });

// The plugin's timers are unref'd since the worker lives on IPC; a test keeps its own loop alive while it waits on a build.
const refClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, Math.min(ms, 30_000));
    return { cancel: () => clearTimeout(timer) };
  },
};

const track = (supervisor: Supervisor, id: string) => {
  const states: string[] = [];
  supervisor.subscribe((record) => record.id === id && states.at(-1) !== record.state && states.push(record.state));
  return states;
};

const until = async (supervisor: Supervisor, id: string, check: (record: ServerRecord | undefined) => boolean, what: string) => {
  const record = await supervisor.waitFor(id, check, 10_000);
  assert.ok(check(record), `expected ${what}, got ${record?.state}`);
  return record!;
};

test("a prebuild warms the worktree from the main checkout, builds the widgets app until ready, then stops it", async () => {
  const worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  const { queue, store, ports, supervisor, logs } = await serve();
  const id = serverIdFor(worktree);
  const states = track(supervisor, id);
  assert.equal((await queue.enqueue(path.join(worktree, "src"))).queued, true);
  assert.equal((await queue.enqueue(main)).queued, false);
  await queue.idle();

  assert.deepEqual(states, ["prewarming", "ready", "stopping", "stopped"]);
  const record = store.snapshot().servers[id];
  assert.equal(record.prebuild, undefined);
  assert.equal(record.process, null);
  assert.match(fs.readFileSync(record.logs.run, "utf8"), /widgets ready on/);
  assert.equal(ports.get(worktree)?.base, record.port);
  assert.equal(fs.readlinkSync(path.join(worktree, "node_modules")), path.join(main, "node_modules"));
  assert.equal(fs.readFileSync(path.join(worktree, ".cache", "widgets.bundle"), "utf8"), "compiled widgets\n");
  assert.deepEqual(store.snapshot().prebuilds, []);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^prebuild of \/widgets-alice: linked node_modules to the main checkout; cloned \.cache \(/);
  assert.match(logs[1], /^prebuild of \/widgets-alice finished \(built in \d+ s\)$/);
});

test("a start during a prebuild takes it over: same process, state building, a normal lease, and it is not stopped once ready", async () => {
  const worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  const { queue, service, store, supervisor, leases, logs } = await serve({ buildMs: 700 });
  const id = serverIdFor(worktree);
  await queue.enqueue(worktree);
  const prebuilding = await until(supervisor, id, (record) => record?.state === "prewarming", "prewarming");

  const started = await service.start({ cwd: worktree }, { holder: user("alice") });
  assert.equal(started.server.state, "building");
  assert.ok(started.placement.because.includes("took over the prebuild of this worktree: its build goes on and the server stays up"));
  assert.equal(store.snapshot().servers[id].prebuild, undefined);
  assert.equal(store.snapshot().servers[id].process?.pid, prebuilding.process?.pid);

  await queue.idle();
  await until(supervisor, id, (record) => record?.state === "ready", "ready");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(store.snapshot().servers[id].state, "ready");
  assert.ok(isAlive(prebuilding.process!.pid));
  assert.deepEqual(
    leases.book.holders(id).map(({ holder }) => holder.id),
    ["alice"],
  );
  assert.deepEqual(logs.slice(1), ["prebuild of /widgets-alice was taken over by a start"]);
});

test("a prebuild never stops a running server: it waits at the cap and builds once a slot frees", async () => {
  const busy = gitRepo(path.join(dir, "widgets-busy"), REMOTE);
  const worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  const { queue, service, store, supervisor } = await serve({ cap: 1 });
  const holder = user("bruno");
  const { server } = await service.start({ cwd: busy, waitSeconds: 10 }, { holder });
  assert.equal(server.state, "ready");
  const pid = store.snapshot().servers[server.id].process?.pid;

  await queue.enqueue(worktree);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(store.snapshot().servers[server.id].process?.pid, pid);
  assert.equal(store.snapshot().servers[serverIdFor(worktree)]?.process ?? null, null);
  assert.equal(queue.jobs()[0]?.worktree, worktree);
  assert.ok(fs.existsSync(path.join(worktree, "node_modules")));

  const states = track(supervisor, serverIdFor(worktree));
  await service.stop(server.id, {}, { holder });
  await queue.idle();
  assert.deepEqual(states, ["prewarming", "ready", "stopping", "stopped"]);
});

test("a start at the cap cancels a prebuild, which goes back in the queue and builds once the slot frees", async () => {
  const busy = gitRepo(path.join(dir, "widgets-busy"), REMOTE);
  const worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  const { queue, service, store, supervisor, logs } = await serve({ cap: 1, buildMs: 700 });
  const id = serverIdFor(worktree);
  await queue.enqueue(worktree);
  await until(supervisor, id, (record) => record?.state === "prewarming", "prewarming");

  const holder = user("bruno");
  const started = await service.start({ cwd: busy }, { holder });
  assert.deepEqual(started.evicted, [{ id, worktree, why: "it was only a prebuild" }]);
  assert.ok(await waitUntil(() => queue.jobs()[0]?.cancels === 1, 5000));
  assert.ok(logs.includes("prebuild of /widgets-alice was cancelled to make room; queued again"));
  assert.equal(store.snapshot().servers[id].process, null);

  await until(supervisor, started.server.id, (record) => record?.state === "ready", "ready");
  const states = track(supervisor, id);
  await service.stop(started.server.id, {}, { holder });
  await queue.idle();
  assert.deepEqual(states, ["prewarming", "ready", "stopping", "stopped"]);
  assert.deepEqual(queue.jobs(), []);
});

test("archiving a workspace drops its queued prebuild and its agents' leases, keeps a server others hold or pinned, else stops it and forgets it", async () => {
  const worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  const other = gitRepo(path.join(dir, "widgets-bruno"), REMOTE);
  const pinnedTree = gitRepo(path.join(dir, "widgets-carol"), REMOTE);
  const queuedTree = gitRepo(path.join(dir, "widgets-dave"), REMOTE);
  fs.writeFileSync(path.join(worktree, "widgets.settings.json"), '{ "theme": "dark" }\n');
  const { queue, service, store, ports, leases } = await serve({ startQueue: false, settings: true });

  await queue.enqueue(queuedTree);
  const queuedArchive = await service.archive(queuedTree);
  assert.deepEqual(queue.jobs(), []);
  assert.equal(queuedArchive.stopped, false);

  const agentHere: Holder = { kind: "agent", id: await leases.issueKey(path.join(worktree, "src"), "Alice") };
  const agentThere: Holder = { kind: "agent", id: await leases.issueKey(other, "Bruno") };
  const { server } = await service.start({ cwd: worktree }, { holder: agentHere });
  await service.start({ cwd: worktree }, { holder: agentThere });
  const baseFiles = () => fs.readdirSync(path.join(stateDir, "base")).filter((name) => name.startsWith(server.id));
  assert.equal(baseFiles().length, 2);

  const kept = await service.archive(path.join(worktree, "."));
  assert.equal(kept.kept, "leased");
  assert.deepEqual(kept.droppedLeases, [server.id]);
  assert.deepEqual(kept.holders, ["Bruno"]);
  assert.ok(store.snapshot().servers[server.id].process);

  await leases.book.release(server.id, agentThere);
  const archived = await service.archive(worktree);
  assert.deepEqual(
    { stopped: archived.stopped, kept: archived.kept, portReleased: archived.portReleased, forgotten: archived.forgotten },
    { stopped: true, kept: undefined, portReleased: true, forgotten: true },
  );
  assert.equal(store.snapshot().servers[server.id], undefined);
  assert.equal(ports.get(worktree), undefined);
  assert.deepEqual(baseFiles(), []);
  assert.equal(fs.readFileSync(path.join(worktree, "widgets.settings.json"), "utf8"), '{ "theme": "dark" }\n');

  const pinned = await service.start({ cwd: pinnedTree, pin: true }, { holder: user("carol") });
  await leases.book.release(pinned.server.id, user("carol"));
  const stays = await service.archive(pinnedTree);
  assert.equal(stays.kept, "pinned");
  assert.ok(store.snapshot().servers[pinned.server.id].process);
  assert.ok(ports.get(pinnedTree));
});
