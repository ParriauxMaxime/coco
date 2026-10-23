import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { boardSchema, loginRpc, logsRpc, pinRpc, placementRpc, startRpc, stopRpc, type Holder } from "../shared/contracts.ts";
import { FIXTURE, PATIENCE_MS, freePort, gitRepo, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { createLeaseManager, openLeaseStore, type LeaseManager, type LostEntry } from "./leases.ts";
import { openPortRegistry } from "./ports.ts";
import { createRpcHandlers } from "./rpc.ts";
import { createScheduler } from "./scheduler.ts";
import { createService } from "./service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

const PROVIDER = fileURLToPath(new URL("../test/fixtures/widgets-provider.mjs", import.meta.url));
const REMOTE = "git@github.example:acme/widgets.git";

let dir = "";
let stateDir = "";
let worktree = "";
let running: { supervisor: Supervisor; store: JsonStore<DevServersState>; leases: LeaseManager }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-rpc-")));
  stateDir = path.join(dir, "state");
  worktree = gitRepo(path.join(dir, "widgets-alice"), REMOTE);
  running = [];
});

afterEach(async () => {
  for (const { supervisor, leases } of running) {
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

const serve = async ({ buildMs = 150, provider = false } = {}) => {
  const config = parseConfig({
    stateDir,
    worktreeRoots: [dir],
    coco: { url: null },
    projects: [
      widgets(await freePort(), {
        command: ["node", FIXTURE, "--port", "{port}", "--ttl", "60", "--build-ms", String(buildMs)],
        ...(provider && { provider: PROVIDER, login: { timeoutSeconds: 20 } }),
      }),
    ],
  });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((project) => project.id === id), pollMs: 100 });
  const lost: LostEntry[] = [];
  const leases = createLeaseManager({
    store: leaseStore,
    servers: store,
    idleStopMinutes: 30,
    leaseTtlMinutes: 240,
    stopIdle: async () => {},
    onLost: (entries) => lost.push(...entries),
    onWarning: () => {},
  });
  const capacity = createScheduler({ store, cap: config.cap, stop: (id) => supervisor.stop(id), leases: leases.book, onWarning: () => {} });
  const service = createService({ config, store, ports, supervisor, leases: leases.book, capacity, onWarning: () => {} });
  supervisor.subscribe((record) => void leases.settle(record.id));
  running.push({ supervisor, store, leases });
  const rpc = createRpcHandlers(async () => ({ deps: { service, leases, store, config }, error: null }));
  const agent = async (agentId: string, title: string): Promise<Holder> => {
    const key = await leases.issueKey(worktree, title);
    await leases.bindAgent({ agentId, cwd: worktree });
    return { kind: "agent", id: key };
  };
  const ready = (id: string) => supervisor.waitFor(id, (record) => record?.state === "ready", PATIENCE_MS);
  return { rpc, service, store, supervisor, leases, lost, agent, ready };
};

test("the board gives the UI who holds each server, by title and agent id, and what counts toward the cap, never the agents' keys", async () => {
  const { rpc, service, agent, ready } = await serve();
  const alice = await agent("agent-alice", "Alice");
  const { server } = await service.start({ cwd: worktree }, { holder: alice });
  await ready(server.id);

  const started = await rpc.start(startRpc.input.parse({ cwd: path.join(worktree, "src") }));
  assert.ok(started.ok, JSON.stringify(started));
  assert.equal(started.value.serverId, server.id);
  assert.equal(started.value.placement.mode, "own");
  assert.match(started.value.next, /^ready at http:\/\/127\.0\.0\.1:\d+$/);

  const board = boardSchema.parse(await rpc.board());
  assert.equal(board.error, null);
  assert.equal(board.cap, 3);
  const [shown] = board.servers;
  assert.deepEqual(
    shown.leases.map(({ kind, title, agentId, mine }) => ({ kind, title, agentId, mine })),
    [
      { kind: "agent", title: "Alice", agentId: "agent-alice", mine: false },
      { kind: "user", title: "you, in Paseo", agentId: null, mine: true },
    ],
  );
  assert.deepEqual([shown.state, shown.running, shown.canLogin, shown.pinnedBy], ["ready", true, false, null]);
  assert.equal(JSON.stringify(board).includes(alice.id), false);

  const pinned = await rpc.pin(pinRpc.input.parse({ id: server.id, pinned: true }));
  assert.ok(pinned.ok);
  assert.match(pinned.value.next, /^pinned/);
  assert.equal((await rpc.board()).servers[0].pinnedBy, "you, in Paseo");
});

test("a plain stop from the UI only lets go of its own hold; a forced one stops it and the agent gets a lost notice", async () => {
  const { rpc, service, agent, ready, lost } = await serve();
  const alice = await agent("agent-alice", "Alice");
  const { server } = await service.start({ cwd: worktree }, { holder: alice });
  await ready(server.id);
  assert.ok((await rpc.start(startRpc.input.parse({ cwd: worktree }))).ok);

  const kept = await rpc.stop(stopRpc.input.parse({ id: server.id }));
  assert.deepEqual(kept, { ok: true, value: { stopped: false, kept: "leased", next: "kept running for Alice; your lease is released" } });
  assert.deepEqual(
    (await rpc.board()).servers[0].leases.map(({ title }) => title),
    ["Alice"],
  );

  const forced = await rpc.stop(stopRpc.input.parse({ id: server.id, force: true }));
  assert.ok(forced.ok);
  assert.equal(forced.value.stopped, true);
  const board = await rpc.board();
  assert.deepEqual([board.servers[0].state, board.servers[0].running, board.servers[0].leases], ["stopped", false, []]);
  assert.deepEqual(
    board.lost.map(({ serverId, holder, agentId, why, seen }) => ({ serverId, holder, agentId, why, seen })),
    [{ serverId: server.id, holder: "Alice", agentId: "agent-alice", why: "stopped by you, in Paseo", seen: false }],
  );
  assert.deepEqual(
    lost.map(({ serverId, holder }) => [serverId, holder.id]),
    [[server.id, alice.id]],
  );
});

test("logs read the tail without counting as use, and failures come back with their code instead of throwing", async () => {
  const { rpc, service, store, ready } = await serve();
  const unknown = await rpc.stop(stopRpc.input.parse({ id: "wt_000000000000" }));
  assert.deepEqual(unknown.ok ? null : unknown.error.code, "not_found");

  const outside = gitRepo(path.join(dir, "gadgets"), "git@github.example:acme/gadgets.git");
  const placement = await rpc.placement(placementRpc.input.parse({ cwd: outside }));
  assert.equal(placement.ok ? null : placement.error.code, "not_a_project_worktree");

  const { server } = await service.start({ cwd: worktree }, { holder: { kind: "user", id: "bruno" } });
  await ready(server.id);
  const used = store.snapshot().servers[server.id].lastUsedAt;
  const logs = await rpc.logs(logsRpc.input.parse({ id: server.id, lines: 5 }));
  assert.ok(logs.ok, JSON.stringify(logs));
  assert.ok(logs.value.lines.length <= 5);
  assert.match(logs.value.lines.join("\n"), /widgets ready on/);
  assert.equal(store.snapshot().servers[server.id].lastUsedAt, used);

  const preview = await rpc.placement(placementRpc.input.parse({ cwd: worktree }));
  assert.deepEqual(preview.ok && { mode: preview.value.placement.mode, serverId: preview.value.serverId }, { mode: "own", serverId: server.id });

  const login = await rpc.login(loginRpc.input.parse({ id: server.id }));
  assert.equal(login.ok ? null : login.error.code, "login_unavailable");

  const down = createRpcHandlers(async () => ({ deps: null, error: "config file not found" }));
  assert.deepEqual(await down.board(), { error: "config file not found", cap: null, servers: [], lost: [] });
  assert.deepEqual(await down.start(startRpc.input.parse({ cwd: worktree })), { ok: false, error: { code: "internal", message: "config file not found" } });
});

test("open logged in is refused with the state while the server builds, then answers the seed to apply once it is ready", async () => {
  const { rpc, service, ready } = await serve({ buildMs: 1500, provider: true });
  const { server } = await service.start({ cwd: worktree }, { holder: { kind: "user", id: "bruno" } });
  assert.equal((await rpc.board()).servers[0].canLogin, true);

  const early = await rpc.login(loginRpc.input.parse({ id: server.id }));
  assert.deepEqual(early.ok ? null : [early.error.code, early.error.details], ["not_ready", { id: server.id, state: "building" }]);

  await ready(server.id);
  const login = await rpc.login(loginRpc.input.parse({ id: server.id, path: "/widgets/42" }));
  assert.ok(login.ok, JSON.stringify(login));
  assert.equal(login.value.apply?.then, `${server.url}/widgets/42`);
  assert.equal(login.value.apply?.open, `${server.url}/`);
});
