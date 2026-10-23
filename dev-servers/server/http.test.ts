import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { logsResultSchema, serverViewSchema, startResultSchema, stopResultSchema } from "../shared/contracts.ts";
import { FIXTURE, freePort, gitRepo, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { createHttpApi, type HttpApi } from "./http.ts";
import { openPortRegistry } from "./ports.ts";
import { isAlive } from "./proc.ts";
import { createService } from "./service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

let dir = "";
let stateDir = "";
let worktree = "";
let running: { http: HttpApi; supervisor: Supervisor; store: JsonStore<DevServersState> }[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-http-")));
  stateDir = path.join(dir, "state");
  worktree = gitRepo(path.join(dir, "widgets-alice"), "git@github.example:acme/widgets.git");
  running = [];
});

afterEach(async () => {
  for (const { http, supervisor } of running) {
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

type Reply = { status: number; body: Record<string, any> };

const serve = async (projects: object[]) => {
  const config = parseConfig({ stateDir, projects });
  const store = openStateStore(stateDir);
  const ports = openPortRegistry(stateDir);
  await store.load();
  await ports.load();
  const supervisor = createSupervisor({ store, stateDir, project: (id) => config.projects.find((project) => project.id === id), pollMs: 100 });
  const service = createService({ config, store, ports, supervisor });
  const api = createHttpApi({ service, bind: "127.0.0.1", port: 0 });
  const { port } = await api.listen();
  running.push({ http: api, supervisor, store });

  const call = (method: string, pathname: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const contentType = payload === undefined ? {} : { "content-type": "application/json" };
      const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { ...contentType, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  return { call, store, port };
};

const errorOf = (reply: Reply) => [reply.status, reply.body.error?.code];

test("start, status, logs and stop over HTTP", async () => {
  const { call } = await serve([widgets(await freePort())]);

  const started = await call("POST", "/api/servers/start", { body: { cwd: path.join(worktree, "src"), waitSeconds: 10 } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const result = startResultSchema.parse(started.body);
  const { server } = result;
  assert.equal(server.state, "ready", server.lastError);
  assert.deepEqual(result.placement, {
    mode: "own",
    servedFrom: worktree,
    because: ["no other worktree builds on this worktree's commit: it is the top of its stack"],
  });
  assert.equal(result.lease, null);
  assert.equal(result.next, `ready at ${server.url}`);
  assert.equal(server.url, `http://127.0.0.1:${server.port}`);
  assert.deepEqual(server.reserved, [server.port]);
  assert.deepEqual({ branch: server.worktree.branch, dirty: server.worktree.dirty }, { branch: "main", dirty: false });
  assert.match(server.worktree.head, /^[0-9a-f]{40}$/);
  assert.equal(await (await fetch(`${server.url}/health`)).text(), "ok");

  const again = startResultSchema.parse((await call("POST", "/api/servers/start", { body: { cwd: worktree } })).body);
  assert.equal(again.server.id, server.id);
  assert.equal(again.server.port, server.port);

  const list = await call("GET", "/api/servers");
  assert.deepEqual(
    list.body.servers.map((entry: unknown) => serverViewSchema.parse(entry)).map(({ id, state }: { id: string; state: string }) => [id, state]),
    [[server.id, "ready"]],
  );
  const one = await call("GET", `/api/servers/${server.id}`);
  assert.equal(serverViewSchema.parse(one.body.server).port, server.port);

  const tail = logsResultSchema.parse((await call("GET", `/api/servers/${server.id}/logs?lines=2`)).body);
  assert.equal(tail.lines.length, 2);
  assert.equal(tail.truncated, true);
  assert.match(tail.lines[1], /widgets ready on/);
  const building = logsResultSchema.parse((await call("GET", `/api/servers/${server.id}/logs?grep=BUILDING%20widgets`)).body);
  assert.deepEqual(
    building.lines.map((line) => /widgets \d\/3/.exec(line)?.[0]),
    ["widgets 1/3", "widgets 2/3", "widgets 3/3"],
  );
  assert.deepEqual(errorOf(await call("GET", `/api/servers/${server.id}/logs?grep=(`)), [400, "bad_request"]);
  assert.deepEqual(errorOf(await call("GET", `/api/servers/${server.id}/logs?source=app`)), [404, "not_found"]);
  assert.deepEqual(errorOf(await call("GET", `/api/servers/${server.id}/logs?lines=0`)), [400, "bad_request"]);

  const leftover = Number(/leftover helper pid (\d+)/.exec(fs.readFileSync(server.logs.run, "utf8"))?.[1]);
  const stopped = stopResultSchema.parse((await call("POST", `/api/servers/${server.id}/stop`, { body: {} })).body);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.server.state, "stopped");
  assert.deepEqual(stopped.swept, [leftover]);
  assert.deepEqual(stopped.portsBusy, []);
  assert.equal(isAlive(leftover), false);
  await assert.rejects(fetch(`${server.url}/health`));
  assert.deepEqual((await call("GET", "/healthz")).body, { ok: true });
});

test("opt-ins need a reason, restart a running server, and a pinned server stops only with force", async () => {
  const { call, store } = await serve([widgets(await freePort())]);
  assert.deepEqual(errorOf(await call("POST", "/api/servers/start", { body: { cwd: worktree, services: ["mailer"] } })), [422, "reason_required"]);

  const plain = startResultSchema.parse((await call("POST", "/api/servers/start", { body: { cwd: worktree, pin: true } })).body);
  assert.equal(plain.server.pinned, true);
  const firstPid = store.snapshot().servers[plain.server.id].process?.pid;

  const body = { cwd: worktree, services: ["mailer"], dedicatedDb: true, reason: "check the welcome mail", waitSeconds: 10 };
  const opted = startResultSchema.parse((await call("POST", "/api/servers/start", { body })).body);
  assert.equal(opted.placement.mode, "dedicated");
  assert.match(opted.placement.because.join("\n"), /restarted to add services mailer and a dedicated database/);
  assert.deepEqual(opted.server.optIns, { services: ["mailer"], dedicatedDb: true, reason: "check the welcome mail" });
  assert.equal(opted.server.state, "ready");
  const secondPid = store.snapshot().servers[opted.server.id].process?.pid;
  assert.notEqual(secondPid, firstPid);
  assert.equal(isAlive(firstPid!), false);
  assert.match(fs.readFileSync(opted.server.logs.run, "utf8").split("--- dev-servers").at(-1)!, /--fresh-db/);

  const kept = stopResultSchema.parse((await call("POST", `/api/servers/${opted.server.id}/stop`, { body: {} })).body);
  assert.deepEqual([kept.stopped, kept.kept, kept.server.state], [false, "pinned", "ready"]);
  assert.ok(isAlive(secondPid!));
  const forced = stopResultSchema.parse(
    (await call("POST", `/api/servers/${opted.server.id}/stop`, { body: { force: true, holder: { kind: "coco", id: "work/1" } } })).body,
  );
  assert.deepEqual([forced.stopped, forced.server.state], [true, "stopped"]);
  assert.equal(isAlive(secondPid!), false);
});

test("errors carry stable codes", async () => {
  const held = net.createServer();
  const heldPort = await new Promise<number>((resolve) => held.listen(0, "127.0.0.1", () => resolve((held.address() as AddressInfo).port)));
  const broken = gitRepo(path.join(dir, "broken"));
  const crowded = gitRepo(path.join(dir, "crowded"));
  const gadgets = gitRepo(path.join(dir, "gadgets"), "https://git.example/acme/gadgets.git");
  const plain = path.join(dir, "plain");
  fs.mkdirSync(plain);
  const base = await freePort();
  const { call } = await serve([
    widgets(base),
    { id: "broken", match: { paths: [broken] }, command: ["no-such-widgets-binary"], ports: { range: [base, base + 40], step: 1 } },
    { id: "crowded", match: { paths: [crowded] }, command: ["node", FIXTURE], ports: { range: [heldPort, heldPort], step: 1 } },
  ]);
  try {
    const start = async (body: unknown) => errorOf(await call("POST", "/api/servers/start", { body }));
    assert.deepEqual(await start({}), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: "relative/path" }), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: worktree, waitSecond: 5 }), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: worktree, waitSeconds: 51 }), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: worktree, holder: { kind: "agent", id: "a1" } }), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: worktree, serveFrom: gadgets }), [400, "bad_request"]);
    assert.deepEqual(await start("{not json"), [400, "bad_request"]);
    assert.deepEqual(await start([worktree]), [400, "bad_request"]);
    assert.deepEqual(await start({ cwd: plain }), [422, "not_a_project_worktree"]);
    assert.deepEqual(await start({ cwd: gadgets }), [422, "not_a_project_worktree"]);
    assert.deepEqual(await start({ cwd: path.join(dir, "missing") }), [422, "not_a_project_worktree"]);
    assert.deepEqual(await start({ cwd: broken, dedicatedDb: true, reason: "fresh data" }), [400, "bad_request"]);

    const failed = await call("POST", "/api/servers/start", { body: { cwd: broken } });
    assert.deepEqual(errorOf(failed), [500, "start_failed"]);
    assert.match(failed.body.error.message, /no-such-widgets-binary was not found/);

    const unavailable = await call("POST", "/api/servers/start", { body: { cwd: crowded } });
    assert.deepEqual(errorOf(unavailable), [503, "port_unavailable"]);
    assert.ok(Array.isArray(unavailable.body.error.details.reasons));

    assert.deepEqual(errorOf(await call("GET", "/api/servers/wt_000000000000")), [404, "not_found"]);
    assert.deepEqual(errorOf(await call("GET", "/api/servers/wt_000000000000/logs")), [404, "not_found"]);
    assert.deepEqual(errorOf(await call("POST", "/api/servers/wt_000000000000/stop", { body: {} })), [404, "not_found"]);
    assert.deepEqual(errorOf(await call("POST", "/api/servers/wt_000000000000/stop", { body: { force: "yes" } })), [400, "bad_request"]);
    assert.deepEqual(errorOf(await call("GET", "/api/elsewhere")), [404, "not_found"]);
    const wrongMethod = await call("DELETE", "/api/servers");
    assert.deepEqual(errorOf(wrongMethod), [405, "method_not_allowed"]);
    assert.deepEqual(wrongMethod.body.error.details, { allow: ["GET"] });
  } finally {
    await new Promise((resolve) => held.close(resolve));
  }
});

test("the Host and Origin guard turns away other sites, rebinding and form posts", async () => {
  const { call, port } = await serve([widgets(await freePort())]);
  const start = (headers: Record<string, string>, body: unknown = { cwd: worktree }) => call("POST", "/api/servers/start", { body, headers });

  assert.deepEqual(errorOf(await start({ origin: "http://widgets.example" })), [403, "forbidden_origin"]);
  assert.deepEqual(errorOf(await start({ origin: "null" })), [403, "forbidden_origin"]);
  assert.deepEqual(errorOf(await start({ origin: "file://" })), [403, "forbidden_origin"]);
  assert.deepEqual(errorOf(await call("GET", "/api/servers", { headers: { origin: "https://127.0.0.1.widgets.example" } })), [403, "forbidden_origin"]);
  assert.deepEqual(errorOf(await call("GET", "/api/servers", { headers: { host: `widgets.example:${port}` } })), [403, "forbidden_host"]);
  assert.deepEqual(errorOf(await start({ host: "widgets.example" })), [403, "forbidden_host"]);
  assert.deepEqual(errorOf(await start({ "content-type": "text/plain" })), [415, "unsupported_media_type"]);
  assert.deepEqual(errorOf(await start({ "content-type": "application/x-www-form-urlencoded" }, "cwd=/tmp")), [415, "unsupported_media_type"]);
  assert.deepEqual(errorOf(await start({}, { cwd: worktree, reason: "x".repeat(70_000) })), [413, "payload_too_large"]);
  assert.deepEqual((await call("GET", "/api/servers")).body, { servers: [] });

  const allowed: Record<string, string>[] = [
    { origin: `http://localhost:${port}` },
    { origin: "http://[::1]:5173" },
    { host: `localhost:${port}` },
    { host: `[::1]:${port}` },
  ];
  for (const headers of allowed) {
    const reply = await call("GET", "/api/servers", { headers });
    assert.equal(reply.status, 200, JSON.stringify(headers));
  }
  await assert.rejects(createHttpApi({ service: {} as never, bind: "0.0.0.0", port: 0 }).listen(), /not a loopback address/);
});
