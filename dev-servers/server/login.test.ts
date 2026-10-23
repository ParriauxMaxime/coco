import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { loginResultSchema } from "../shared/contracts.ts";
import { gitRepo, widgets } from "../test/helpers.ts";
import { createPresenter } from "./board.ts";
import { parseConfig } from "./config.ts";
import { createHttpApi, type HttpApi } from "./http.ts";
import { createLeaseManager, openLeaseStore, type LeaseManager } from "./leases.ts";
import { MCP_PATH, createMcpHandler } from "./mcp.ts";
import { openPortRegistry } from "./ports.ts";
import { createService } from "./service.ts";
import { openStateStore, serverIdFor, type ServerRecord } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";

const PROVIDER = fileURLToPath(new URL("../test/fixtures/widgets-provider.mjs", import.meta.url));
const PORT = 8140;
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Reply = { status: number; body: Record<string, any> };

let dir = "";
let running: { http: HttpApi; leases: LeaseManager }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-login-")));
  running = [];
});

afterEach(async () => {
  for (const { http, leases } of running) {
    leases.close();
    await http.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const serve = async ({ provider = PROVIDER as string | null, state = "ready" as ServerRecord["state"] } = {}) => {
  const run = fs.mkdtempSync(path.join(dir, "run-"));
  const stateDir = path.join(run, "state");
  const worktree = gitRepo(path.join(run, "widgets-alice"), "git@github.example:acme/widgets.git");
  const config = parseConfig({ stateDir, projects: [widgets(8100, { ...(provider && { provider }), login: { timeoutSeconds: 5 } })] });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const id = serverIdFor(worktree);
  const before = "2026-01-01T00:00:00.000Z";
  await store.update((draft) => {
    draft.servers[id] = {
      id,
      project: "widgets",
      worktree,
      port: PORT,
      reserved: [PORT],
      state,
      stateSince: before,
      process: { pid: 4242, pgid: 4242, startedAt: "Thu Jan  1 00:00:00 2026" },
      pinned: false,
      optIns: { services: [], dedicatedDb: false, reason: null },
      lastUsedAt: before,
      deadlines: {},
      logs: { run: "/dev/null" },
      ...(state === "building" && { progress: "building widgets 1/3" }),
    };
  });
  const supervisor = {} as Supervisor;
  const service = createService({ config, store, ports, supervisor, onWarning: () => {} });
  const leases = createLeaseManager({ store: leaseStore, servers: store, idleStopMinutes: 30, leaseTtlMinutes: 240, stopIdle: async () => {} });
  const present = createPresenter({ leases, store, config });
  const http = createHttpApi({ service, present, bind: "127.0.0.1", port: 0, mounts: { [MCP_PATH]: createMcpHandler({ service, leases, present }) } });
  const { port } = await http.listen();
  running.push({ http, leases });
  const post = async (route: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const tool = async (args: Record<string, unknown>, cwd = worktree) => {
    const key = await leases.issueKey(cwd);
    const { body } = await post(
      MCP_PATH,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dev_server_login", arguments: args } },
      { "x-dev-servers-key": key },
    );
    return { isError: body.result.isError ?? false, body: JSON.parse(body.result.content[0].text) };
  };
  return { id, store, post, tool, before };
};

test("dev_server_login logs the agent's own server in: the seed, one script to set it on the origin, the page, and a short next", async () => {
  const { id, store, tool, before, post } = await serve();
  const { isError, body } = await tool({ path: "/widgets/42" });
  assert.equal(isError, false, JSON.stringify(body));
  const result = loginResultSchema.parse(body);
  const origin = ORIGIN;
  assert.equal(result.id, id);
  assert.equal(result.url, `${origin}/widgets/42`);
  assert.deepEqual(result.user, { id: "usr_ada", name: "Ada" });
  assert.equal(result.expiresAt, "2030-01-01T00:00:00.000Z");
  assert.deepEqual(result.seed, {
    storage: "localStorage",
    origin,
    entries: { "widgets.session": `tok_usr_ada_${PORT}`, "widgets.user": "usr_ada" },
  });
  const script = `localStorage.setItem("widgets.session", "tok_usr_ada_${PORT}"); localStorage.setItem("widgets.user", "usr_ada");`;
  assert.deepEqual(result.apply, { open: `${origin}/`, function: `() => { ${script} return location.origin; }`, script, then: `${origin}/widgets/42` });
  assert.match(
    result.next,
    new RegExp(`^logged in as usr_ada until 2030-01-01T00:00:00.000Z once the browser holds the seed: open ${origin}/, run apply.function`),
  );
  assert.notEqual(store.snapshot().servers[id].lastUsedAt, before);

  const listed = await post(MCP_PATH, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const login = listed.body.result.tools.find(({ name }: { name: string }) => name === "dev_server_login");
  assert.deepEqual(Object.keys(login.inputSchema.properties).sort(), ["path", "server", "user"]);
});

test("POST /api/servers/:id/login takes a user and a path and answers the same shape", async () => {
  const { id, post } = await serve();
  const { status, body } = await post(`/api/servers/${id}/login`, { user: "usr_grace", path: "/settings" });
  assert.equal(status, 200, JSON.stringify(body));
  const result = loginResultSchema.parse(body);
  assert.equal(result.url, `${ORIGIN}/settings`);
  assert.deepEqual(result.seed?.entries, { "widgets.session": `tok_usr_grace_${PORT}`, "widgets.user": "usr_grace" });
  assert.equal(result.apply?.then, `${ORIGIN}/settings`);

  const bad = await post(`/api/servers/${id}/login`, { path: "settings" });
  assert.deepEqual([bad.status, bad.body.error.code], [400, "bad_request"]);
});

test("a server that is still building is refused with not_ready and what it is doing", async () => {
  const { id, post, tool } = await serve({ state: "building" });
  const { status, body } = await post(`/api/servers/${id}/login`, {});
  assert.deepEqual([status, body.error.code, body.error.details], [409, "not_ready", { id, state: "building" }]);
  assert.match(body.error.message, /not serving yet: building \(building widgets 1\/3\)/);
  const viaTool = await tool({});
  assert.deepEqual([viaTool.isError, viaTool.body.error.code], [true, "not_ready"]);
});

test("an unknown server is not_found, over HTTP and through the tool", async () => {
  const { post, tool } = await serve();
  const { status, body } = await post("/api/servers/wt_000000000000/login", {});
  assert.deepEqual([status, body.error.code], [404, "not_found"]);
  const viaTool = await tool({ server: "wt_000000000000" });
  assert.deepEqual([viaTool.isError, viaTool.body.error.code], [true, "not_found"]);
});

test("a provider that throws, or seeds another origin than its page, is login_failed with its reason", async () => {
  const { id, post } = await serve();
  const thrown = await post(`/api/servers/${id}/login`, { user: "nobody" });
  assert.deepEqual([thrown.status, thrown.body.error.code], [502, "login_failed"]);
  assert.match(thrown.body.error.message, /no user nobody in the widgets database/);
  const elsewhere = await post(`/api/servers/${id}/login`, { user: "elsewhere" });
  assert.deepEqual([elsewhere.status, elsewhere.body.error.code], [502, "login_failed"]);
  assert.match(elsewhere.body.error.message, /the browser would not see it/);
});

test("a project with no provider, or a provider without login, is login_unavailable", async () => {
  const settingsOnly = path.join(dir, "settings-only.mjs");
  fs.writeFileSync(settingsOnly, "export const settingsOverlay = () => ({});\n");
  for (const provider of [null, settingsOnly]) {
    const { id, post } = await serve({ provider });
    const { status, body } = await post(`/api/servers/${id}/login`, {});
    assert.deepEqual([status, body.error.code], [501, "login_unavailable"]);
  }
});
