import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serverViewSchema, startResultSchema, stopResultSchema } from "../shared/contracts.ts";
import { freePort, gitRepo, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { createHttpApi, type HttpApi } from "./http.ts";
import { createLeaseManager, openLeaseStore, type LeaseManager } from "./leases.ts";
import { MCP_PATH, MCP_TOOL_NAMES, createMcpHandler } from "./mcp.ts";
import { openPortRegistry } from "./ports.ts";
import { isAlive } from "./proc.ts";
import { createService, type DevServersService } from "./service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

let dir = "";
let stateDir = "";
let worktree = "";
let running: { http: HttpApi; supervisor: Supervisor; store: JsonStore<DevServersState>; leases: LeaseManager; clients: Client[] }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-mcp-")));
  stateDir = path.join(dir, "state");
  worktree = gitRepo(path.join(dir, "widgets-alice"), "git@github.example:acme/widgets.git");
  running = [];
});

afterEach(async () => {
  for (const { http, supervisor, leases, clients } of running) {
    for (const client of clients) await client.close();
    leases.close();
    await http.close();
    supervisor.close();
  }
  await killTestProcesses(
    running.map(({ store }) => store),
    stateDir,
    dir,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const serve = async ({ idleStopMinutes = 30 } = {}) => {
  const config = parseConfig({ stateDir, idleStopMinutes, projects: [widgets(await freePort())] });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  const leaseStore = openLeaseStore(stateDir);
  await Promise.all([store.load(), ports.load(), leaseStore.load()]);
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((project) => project.id === id), pollMs: 100 });
  let service: DevServersService | null = null;
  const leases = createLeaseManager({
    store: leaseStore,
    servers: store,
    idleStopMinutes,
    leaseTtlMinutes: 240,
    stopIdle: (id) => service!.stop(id, {}, { holder: { kind: "user", id: "idle-timer" } }),
  });
  service = createService({ config, store, ports, supervisor, leases: leases.book });
  supervisor.subscribe((record) => void leases.settle(record.id));
  const api = createHttpApi({ service, bind: "127.0.0.1", port: 0, mounts: { [MCP_PATH]: createMcpHandler({ service, leases }) } });
  const { port } = await api.listen();
  const entry = { http: api, supervisor, store, leases, clients: [] as Client[] };
  running.push(entry);

  const agent = async (agentId: string, cwd: string, title?: string) => {
    const key = await leases.issueKey(cwd, title);
    await leases.bindAgent({ agentId, cwd });
    const client = new Client({ name: "widgets-test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`), { requestInit: { headers: { "x-dev-servers-key": key } } }),
    );
    entry.clients.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      return { isError: result.isError ?? false, body: JSON.parse(result.content[0].text) };
    };
    return { key, client, call };
  };
  return { agent, store, supervisor, leases, port };
};

test("an agent lists the tools, then starts, follows and stops its server with nothing but its key", async () => {
  const { agent, store } = await serve();
  const alice = await agent("agent-alice", path.join(worktree, "src"), "Fix the widget");

  const { tools } = await alice.client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [...MCP_TOOL_NAMES].sort());
  const schemaOf = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema;
  assert.ok(Object.keys(schemaOf("dev_server_start").properties ?? {}).includes("waitSeconds"));
  assert.deepEqual(Object.keys(schemaOf("dev_server_stop").properties ?? {}), ["id"]);
  assert.ok(tools.every(({ description }) => description && description.length > 40));

  const started = await alice.call("dev_server_start", { waitSeconds: 10 });
  assert.equal(started.isError, false, JSON.stringify(started.body));
  const result = startResultSchema.parse(started.body);
  assert.equal(result.server.state, "ready", result.server.lastError);
  assert.equal(result.server.worktree.path, worktree);
  assert.match(result.lease?.id ?? "", /^ls_/);
  assert.deepEqual(
    result.server.leases.map(({ holder }) => holder),
    [{ kind: "agent", id: alice.key, title: "Fix the widget" }],
  );
  assert.equal(result.next, `ready at ${result.server.url}`);

  const status = await alice.call("dev_server_status");
  assert.deepEqual(
    status.body.servers.map(({ id, state, next }: { id: string; state: string; next: string }) => [id, state, next]),
    [[result.server.id, "ready", `ready at ${result.server.url}`]],
  );
  const logs = await alice.call("dev_server_logs", { lines: 1, grep: "widgets ready" });
  assert.match(logs.body.lines[0], /widgets ready on/);

  const forced = await alice.call("dev_server_stop", { force: true });
  assert.deepEqual([forced.isError, forced.body.error.code], [true, "bad_request"]);
  const pid = store.snapshot().servers[result.server.id].process!.pid;
  const stopped = stopResultSchema.parse((await alice.call("dev_server_stop")).body);
  assert.deepEqual([stopped.stopped, stopped.server.state], [true, "stopped"]);
  assert.equal(isAlive(pid), false);

  const after = await alice.call("dev_server_status");
  assert.deepEqual(
    after.body.servers.map(({ state, next }: { state: string; next: string }) => [state, next]),
    [["stopped", "stopped; start it again to use it"]],
  );
});

test("two agents share one server; it outlives the first stop and idles out once the last holder is archived", async () => {
  const { agent, store, supervisor, leases } = await serve({ idleStopMinutes: 0.02 });
  const alice = await agent("agent-alice", worktree, "Fix the widget");
  const bruno = await agent("agent-bruno", worktree, "Review the widget");

  const first = startResultSchema.parse((await alice.call("dev_server_start", { waitSeconds: 10 })).body);
  const second = startResultSchema.parse((await bruno.call("dev_server_start")).body);
  assert.equal(second.server.id, first.server.id);
  assert.equal(second.server.state, "ready");
  assert.deepEqual(
    second.server.leases.map(({ holder }) => holder.title),
    ["Fix the widget", "Review the widget"],
  );
  const pid = store.snapshot().servers[first.server.id].process!.pid;

  const kept = stopResultSchema.parse((await alice.call("dev_server_stop")).body);
  assert.deepEqual([kept.stopped, kept.kept, kept.next], [false, "leased", "kept running for Review the widget; your lease is released"]);
  assert.ok(isAlive(pid));

  assert.deepEqual(await leases.releaseAgent("agent-bruno"), [first.server.id]);
  const idle = serverViewSchema.parse((await alice.call("dev_server_status")).body.servers[0]);
  assert.equal(idle.state, "idle");
  assert.ok(idle.idleStopAt);
  assert.match((await alice.call("dev_server_status")).body.servers[0].next, /nobody holds it, so it stops at/);

  const gone = await supervisor.waitFor(first.server.id, (record) => record?.state === "stopped", 10_000);
  assert.equal(gone?.state, "stopped");
  assert.equal(isAlive(pid), false);
  assert.deepEqual(gone?.deadlines, {});
});

type Raw = { status: number; body: any };

const raw = (port: number, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Promise<Raw>((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: MCP_PATH,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

test("the endpoint answers every JSON-RPC message, including probes it does not know, behind the same Host and Origin guard", async () => {
  const { port } = await serve();
  const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: "2.0", ...(id !== null && { id }), method, params });

  assert.deepEqual((await raw(port, "POST", rpc("server/discover", {}, 7))).body, {
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32601, message: "Method not found: server/discover" },
  });
  assert.deepEqual(await raw(port, "POST", rpc("notifications/initialized", undefined, null)), { status: 202, body: null });
  assert.equal((await raw(port, "GET")).status, 405);
  assert.equal((await raw(port, "DELETE")).status, 405);
  assert.deepEqual((await raw(port, "POST", "{nope")).body.error.code, -32700);
  assert.deepEqual((await raw(port, "POST", [rpc("ping"), rpc("notifications/cancelled", {}, null)])).body, [{ jsonrpc: "2.0", id: 1, result: {} }]);

  const version = async (protocolVersion: string) =>
    (await raw(port, "POST", rpc("initialize", { protocolVersion, capabilities: {} }))).body.result.protocolVersion;
  assert.equal(await version("2025-03-26"), "2025-03-26");
  assert.equal(await version("2099-01-01"), "2025-11-25");

  const keyless = (await raw(port, "POST", rpc("tools/call", { name: "dev_server_status", arguments: {} }))).body.result;
  assert.equal(keyless.isError, true);
  assert.match(keyless.content[0].text, /x-dev-servers-key/);
  const unknown = await raw(port, "POST", rpc("tools/call", { name: "dev_server_force_stop", arguments: {} }), { "x-dev-servers-key": "dk_widgetstest01" });
  assert.equal(unknown.body.error.code, -32602);

  const hinted = await raw(port, "POST", rpc("tools/call", { name: "dev_server_status", arguments: {} }), {
    "x-dev-servers-key": "dk_widgetstest02",
    "x-dev-servers-cwd": encodeURIComponent(worktree),
  });
  assert.deepEqual(JSON.parse(hinted.body.result.content[0].text), { servers: [], next: "no dev server for your worktree yet; call dev_server_start" });

  assert.deepEqual(
    [await raw(port, "POST", rpc("ping"), { origin: "http://widgets.example" })].map(({ status, body }) => [status, body.error.code]),
    [[403, "forbidden_origin"]],
  );
  assert.equal((await raw(port, "POST", rpc("ping"), { "content-type": "text/plain" })).status, 415);
});
