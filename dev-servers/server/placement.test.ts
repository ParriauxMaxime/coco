import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { startReplySchema, type BoardServer, type Holder } from "../shared/contracts.ts";
import { freePort, gitRepo, killTestProcesses, runGit, widgets } from "../test/helpers.ts";
import { createPresenter } from "./board.ts";
import { cocoStackOrder, type StackOrder } from "./coco.ts";
import { parseConfig, type ProjectConfig } from "./config.ts";
import { statusFiles } from "./git.ts";
import { createLeaseManager, openLeaseStore } from "./leases.ts";
import { createMcpTools } from "./mcp.ts";
import { createStackPlacement, type PlacementRequest } from "./placement.ts";
import { openPortRegistry } from "./ports.ts";
import { createService } from "./service.ts";
import { openStateStore, serverIdFor, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

let dir = "";
let main = "";
let roots = "";
let records: ServerRecord[] = [];
let cleanup: { supervisor: Supervisor; store: JsonStore<DevServersState> }[] = [];
const project: ProjectConfig = parseConfig({ projects: [widgets(8100)] }).projects[0];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-placement-")));
  main = gitRepo(path.join(dir, "widgets"), "git@github.example:acme/widgets.git");
  runGit(main, "update-ref", "refs/remotes/origin/main", "HEAD");
  roots = path.join(dir, "worktrees");
  records = [];
  cleanup = [];
});

afterEach(async () => {
  for (const { supervisor } of cleanup) supervisor.close();
  await killTestProcesses(
    cleanup.map(({ store }) => store),
    path.join(dir, "state"),
    dir,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const commit = (worktree: string, name: string) => {
  fs.writeFileSync(path.join(worktree, "src", `${name}.js`), `export const ${name.replaceAll("-", "_")} = 1;\n`);
  runGit(worktree, "add", ".");
  runGit(worktree, "commit", "-q", "-m", name);
  return worktree;
};

// A worktree on a new branch from `from` (a branch or commit), with one commit of its own unless `commits` is 0.
const worktree = (name: string, from = "main", commits = 1) => {
  const at = path.join(roots, name);
  runGit(main, "worktree", "add", "-q", "-b", `feat/${name}`, at, from);
  for (let index = 0; index < commits; index++) commit(at, `${name}-${index}`);
  return at;
};

const running = (at: string, over: Partial<ServerRecord> = {}): ServerRecord => {
  const record: ServerRecord = {
    id: serverIdFor(at),
    project: project.id,
    worktree: at,
    port: 8100,
    reserved: [8100],
    state: "ready",
    stateSince: new Date().toISOString(),
    process: { pid: 1, pgid: 1, startedAt: "test" },
    pinned: false,
    optIns: { services: [], dedicatedDb: false, reason: null },
    lastUsedAt: new Date().toISOString(),
    deadlines: {},
    logs: { run: "/dev/null" },
    ...over,
  };
  records.push(record);
  return record;
};

const placer = (stackOrder?: StackOrder) =>
  createStackPlacement({ worktreeRoots: [roots], servers: () => records, dirtyFiles: statusFiles, stackOrder, cacheMs: 0 });
const place = (at: string, request: PlacementRequest = {}, stackOrder?: StackOrder) => placer(stackOrder)({ worktree: at, project }, request);
const served = async (at: string, request: PlacementRequest = {}, stackOrder?: StackOrder) => {
  const { mode, servedFrom } = await place(at, request, stackOrder);
  return [mode, servedFrom];
};

test("a linear stack is served by its top, and the top serves itself", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  const c = worktree("c", "feat/b");
  assert.deepEqual(await served(a), ["stack-top", c]);
  assert.deepEqual(await served(b), ["stack-top", c]);
  const top = await place(c);
  assert.deepEqual([top.mode, top.servedFrom], ["own", c]);
  assert.match(top.because[0], /top of its stack/);
  assert.deepEqual((await place(a)).because, [`feat/c (${c}) is the top of the stack and contains this worktree's commit`]);
});

test("a worktree on the base branch, a dedicated request and a worktree with its own running server stay on their own", async () => {
  const base = worktree("base", "main", 0);
  const a = worktree("a");
  worktree("b", "feat/a");
  const onBase = await place(base);
  assert.deepEqual([onBase.mode, onBase.servedFrom], ["own", base]);
  assert.match(onBase.because[0], /no commit of its own above origin\/main/);
  assert.deepEqual(await place(a, { dedicated: true }), { mode: "dedicated", servedFrom: a, because: ["a dedicated server was asked for"] });
  running(a);
  assert.deepEqual(await place(a), { mode: "own", servedFrom: a, because: ["the worktree's own server is already running"] });
});

test("a dirty lower worktree runs its own server; a dirty top serves with its dirty files named", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  fs.writeFileSync(path.join(b, "src", "wip.js"), "export const wip = 1;\n");
  fs.appendFileSync(path.join(b, "src", "index.js"), "// wip\n");
  const top = await place(a);
  assert.deepEqual([top.mode, top.servedFrom], ["stack-top", b]);
  assert.match(top.because.join("\n"), new RegExp(`feat/b \\(${b}\\) has uncommitted changes you will see too: src/index.js, src/wip.js`));

  fs.writeFileSync(path.join(a, "src", "draft.js"), "export const draft = 1;\n");
  fs.mkdirSync(path.join(a, ".build"));
  fs.writeFileSync(path.join(a, ".build", "ignored.js"), "");
  const lower = await place(a);
  assert.deepEqual([lower.mode, lower.servedFrom], ["own", a]);
  assert.deepEqual(lower.because, ["the worktree has uncommitted changes, so it runs its own server: src/draft.js"]);
});

test("worktrees on the same commit fold into one top, preferring the one with a running server", async () => {
  const a = worktree("a");
  const c = worktree("c", "feat/a");
  const d = worktree("d", "feat/c", 0);
  const outcome = await place(a);
  assert.deepEqual([outcome.mode, outcome.servedFrom, outcome.ambiguous], ["stack-top", c, undefined]);
  assert.match((await place(c)).because[0], /top of its stack \(another worktree is on the same commit\)/);
  running(d);
  assert.deepEqual(await served(a), ["stack-top", d]);
});

test("a restacked child no longer serves its parent, even when asked with serveFrom", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  assert.deepEqual(await served(a), ["stack-top", b]);
  fs.writeFileSync(path.join(a, "src", "a-0.js"), "export const a_0 = 2;\n");
  runGit(a, "commit", "-q", "-a", "--amend", "--no-edit");
  const alone = await place(a);
  assert.deepEqual([alone.mode, alone.servedFrom], ["own", a]);
  const asked = await place(a, { serveFrom: path.join(b, "src") });
  assert.deepEqual([asked.mode, asked.servedFrom], ["own", a]);
  assert.match(asked.because[0], /does not contain this worktree's commit/);
  assert.deepEqual(await served(b, { serveFrom: a }), ["own", b]);
});

test("a fork with two tops asks coco, then reports an ambiguous placement and serves the worktree itself", async () => {
  const a = worktree("a");
  const b1 = worktree("b1", "feat/a");
  const b2 = worktree("b2", "feat/a");
  const asked: string[] = [];
  const coco =
    (rows: { key: number | string; branch: string | null }[] | null): StackOrder =>
    async (branch) => {
      asked.push(branch);
      return rows;
    };

  const picked = await place(
    a,
    {},
    coco([
      { key: 10, branch: "feat/a" },
      { key: 11, branch: "feat/b2" },
      { key: "b:feat:later", branch: "feat/later" },
    ]),
  );
  assert.deepEqual([picked.mode, picked.servedFrom, picked.ambiguous], ["stack-top", b2, undefined]);
  assert.match(picked.because[0], /2 stacks build on this worktree's commit; feat\/b2 .* is the latest row of its coco work/);
  assert.deepEqual(asked, ["feat/a"]);

  for (const [order, why] of [
    [coco([]), "no coco work orders them"],
    [coco(null), "coco did not answer"],
    [undefined, "coco is not configured"],
  ] as const) {
    const unsure = await place(a, {}, order);
    assert.deepEqual([unsure.mode, unsure.servedFrom], ["own", a]);
    assert.equal(unsure.because[0], `2 stacks build on this worktree's commit and ${why}, so it runs its own server`);
    assert.deepEqual(
      unsure.ambiguous?.options.map(({ worktree, branch, running }) => [worktree, branch, running]),
      [
        [b1, "feat/b1", false],
        [b2, "feat/b2", false],
      ],
    );
    assert.match(unsure.ambiguous?.question ?? "", /serveFrom/);
  }
  assert.deepEqual(await served(a, { serveFrom: b1 }), ["stack-top", b1]);
});

test("a running clean server that contains the caller's commit is reused before building the top", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  const c = worktree("c", "feat/b");
  running(b, { state: "building" });
  const reuse = await place(a);
  assert.deepEqual([reuse.mode, reuse.servedFrom], ["stack-running", b]);
  assert.deepEqual(reuse.because, [`reuses the running server of feat/b (${b}), which contains this worktree's commit`]);

  running(c, { state: "stopped", process: null });
  assert.deepEqual(await served(a), ["stack-running", b]);
  running(c);
  assert.deepEqual(await served(a), ["stack-top", c]);

  records = [];
  running(b);
  fs.writeFileSync(path.join(b, "src", "wip.js"), "");
  assert.deepEqual(await served(a), ["stack-top", c]);
});

test("a clean server started by hand serves the worktrees below it, after the plugin's own; a dirty one never does", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  const c = worktree("c", "feat/b");
  running(c, { state: "external", process: null });
  const reuse = await place(a);
  assert.deepEqual([reuse.mode, reuse.servedFrom], ["external", c]);
  assert.match(
    reuse.because[0],
    new RegExp(`reuses the server of feat/c \\(${c}\\), which contains this worktree's commit; it was started outside the plugin`),
  );

  running(b, { state: "building" });
  assert.deepEqual(await served(a), ["stack-running", b]);

  records = [];
  running(c, { state: "external", process: null });
  fs.writeFileSync(path.join(c, "src", "wip.js"), "");
  const dirty = await place(a);
  assert.deepEqual([dirty.mode, dirty.servedFrom], ["own", a]);
  assert.match(dirty.because[0], /started outside the plugin and it has uncommitted changes, so this worktree runs its own server/);
});

test("serveFrom outside the repository is refused", async () => {
  const a = worktree("a");
  const other = gitRepo(path.join(dir, "gadgets"));
  await assert.rejects(place(a, { serveFrom: other }), (error: { code?: string }) => error.code === "bad_request");
});

test("the coco client reads the work's rows, and treats an unknown branch, an error and a hang apart", async () => {
  const replies: Record<string, (res: http.ServerResponse) => void> = {
    "feat/a": (res) => res.end(JSON.stringify({ work: { slug: "invoices", title: "Invoices" }, rows: [{ key: 10, branch: "feat/a" }] })),
    "feat/none": (res) => res.end(JSON.stringify({ work: null, rows: [] })),
    "feat/broken": (res) => res.writeHead(500).end("{}"),
    "feat/slow": () => {},
  };
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push(url.pathname);
    replies[url.searchParams.get("branch") ?? ""]?.(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const order = cocoStackOrder({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 300 })!;
    assert.deepEqual(await order("feat/a"), [{ key: 10, branch: "feat/a" }]);
    assert.deepEqual(await order("feat/none"), []);
    assert.equal(await order("feat/broken"), null);
    assert.equal(await order("feat/slow"), null);
    assert.deepEqual([...new Set(seen)], ["/api/paseo-link/stack"]);
    assert.equal(cocoStackOrder({ url: null, timeoutMs: 300 }), undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("start from a lower worktree runs and leases the server of the top", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  const stateDir = path.join(dir, "state");
  const config = parseConfig({ stateDir, worktreeRoots: [roots], coco: { url: null }, projects: [widgets(await freePort())] });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  await store.load();
  await ports.load();
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((entry) => entry.id === id), pollMs: 100 });
  cleanup.push({ supervisor, store });
  const service = createService({ config, store, ports, supervisor });

  const result = await service.start({ cwd: a }, { holder: { kind: "user", id: "alice" } });
  assert.equal(result.placement.mode, "stack-top");
  assert.equal(result.server.id, serverIdFor(b));
  assert.equal(result.server.worktree.path, b);
  assert.equal(result.server.worktree.branch, "feat/b");
  assert.deepEqual(Object.keys(store.snapshot().servers), [serverIdFor(b)]);

  const again = await service.start({ cwd: b }, { holder: { kind: "user", id: "bob" } });
  assert.deepEqual([again.placement.mode, again.server.id], ["own", serverIdFor(b)]);
  assert.equal(again.placement.because[0], "the worktree's own server is already running");
});

test("the placement preview starts nothing, and a lease on the top's server turns stale once the caller's own worktree has changes", async () => {
  const a = worktree("a");
  const b = worktree("b", "feat/a");
  const stateDir = path.join(dir, "state");
  const config = parseConfig({ stateDir, worktreeRoots: [roots], coco: { url: null }, projects: [widgets(await freePort())] });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((entry) => entry.id === id), pollMs: 100 });
  cleanup.push({ supervisor, store });
  const leases = createLeaseManager({ store: leaseStore, servers: store, idleStopMinutes: 30, leaseTtlMinutes: 240, stopIdle: async () => {} });
  try {
    const service = createService({ config, store, ports, supervisor, leases: leases.book, gitCacheMs: 0 });
    const user: Holder = { kind: "user", id: "alice" };
    const preview = await service.placement({ cwd: a }, { holder: user });
    assert.deepEqual([preview.placement.mode, preview.placement.servedFrom, preview.server], ["stack-top", b, null]);
    assert.deepEqual(store.snapshot().servers, {});

    const tools = createMcpTools(service, leases, createPresenter({ leases, store, config }));
    const holder: Holder = { kind: "agent", id: await leases.issueKey(a) };
    const context = { holder, caller: { holder, cwd: a } };
    const started = startReplySchema.parse(await tools.dev_server_start.run({}, context));
    assert.equal(started.server.worktree.path, b);
    type Status = { servers: (BoardServer & { stale?: { because: string[] }; next: string })[] };
    const status = async () => ((await tools.dev_server_status.run({}, context)) as Status).servers[0];
    assert.equal((await status()).stale, undefined);
    assert.equal((await service.placement({ cwd: a }, { holder: user })).server?.id, started.server.id);

    fs.writeFileSync(path.join(b, "src", "top-wip.js"), "");
    assert.equal((await status()).stale, undefined);

    fs.writeFileSync(path.join(a, "src", "wip.js"), "");
    const stale = await status();
    assert.match(stale.stale?.because[0] ?? "", /the worktree has uncommitted changes, so it runs its own server: src\/wip.js/);
    assert.match(stale.next, /call dev_server_start again/);
  } finally {
    leases.close();
  }
});
