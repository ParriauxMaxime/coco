import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig } from "./config.ts";
import { groupAlive, infoOf, isAlive, waitUntil, type ProcessInfo } from "./proc.ts";
import { openStateStore, serverIdFor, type ServerRecord } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

const FIXTURE = fileURLToPath(new URL("../test/fixtures/widgets-app/server.mjs", import.meta.url));
const START_AND_EXIT = fileURLToPath(new URL("../test/fixtures/start-and-exit.ts", import.meta.url));

const rawProject = (flags: string[] = ["--leftover"], extra: object = {}) => ({
  id: "widgets",
  match: { remote: "acme/widgets" },
  command: ["node", FIXTURE, "--port", "{port}", "--ttl", "60", ...flags],
  urlTemplate: "http://127.0.0.1:{port}",
  readiness: { http: { path: "/health", bodyIncludes: "ok" }, timeoutMinutes: 1 },
  logPatterns: { progress: "building (widgets \\d/\\d)", ready: "widgets ready on", crash: "server crashed", rebuild: "file change seen" },
  stop: { graceSeconds: 1, sweepCwdUnder: [".build/server"] },
  ...extra,
});
const projectOf = (raw: object) => parseConfig({ projects: [raw] }).projects[0];

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

let dir = "";
let stateDir = "";
let worktree = "";
let supervisors: Supervisor[] = [];
const ours: ProcessInfo[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-sup-")));
  stateDir = path.join(dir, "state");
  worktree = path.join(dir, "widgets-alice");
  fs.mkdirSync(worktree);
  supervisors = [];
  warnings.length = 0;
});

// Only processes this file started are killed, and only while their start time still matches.
afterEach(async () => {
  for (const supervisor of supervisors) supervisor.close();
  for (const proc of ours.splice(0)) {
    const now = await infoOf(proc.pid);
    if (now?.startedAt === proc.startedAt) process.kill(proc.pid, "SIGKILL");
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const remember = async (pid: number | undefined) => {
  const info = pid ? await infoOf(pid) : null;
  if (info) ours.push(info);
  return info;
};

const warnings: string[] = [];
const supervise = async (project = projectOf(rawProject())) => {
  const store = openStateStore(stateDir);
  await store.load();
  const supervisor = createSupervisor({ store, stateDir, project: () => project, pollMs: 100, onWarning: (message) => warnings.push(message) });
  supervisors.push(supervisor);
  return { store, supervisor, project };
};

const startWidgets = async (supervisor: Supervisor, project: ReturnType<typeof projectOf>) => {
  const port = await freePort();
  const record = await supervisor.start({ project, worktree, port, reserved: [port] });
  await remember(record.process?.pid);
  return { port, record };
};

const until = async (supervisor: Supervisor, id: string, state: ServerRecord["state"], timeoutMs = 10_000) => {
  const record = await supervisor.waitFor(id, (current) => current?.state === state, timeoutMs);
  assert.equal(record?.state, state, `expected ${state}, got ${record?.state} (${record?.lastError ?? "no error"})`);
  return record!;
};

const logOf = (record: ServerRecord) => fs.readFileSync(record.logs.run, "utf8");

const leftoverPid = async (record: ServerRecord) => {
  await waitUntil(() => /leftover helper pid \d+/.test(logOf(record)), 5000);
  const pid = Number(/leftover helper pid (\d+)/.exec(logOf(record))?.[1]);
  await remember(pid);
  return pid;
};

// Renamed into place so the fixture never reads a half-written, empty command.
const control = (command: string) => {
  const file = path.join(worktree, "widgets.control");
  fs.writeFileSync(`${file}.tmp`, command);
  fs.renameSync(`${file}.tmp`, file);
};

test("start, ready, crash, rebuild, ready, then stop leaves no process and frees the port", async () => {
  const { supervisor, project } = await supervise();
  const states: string[] = [];
  const progress = new Set<string>();
  supervisor.subscribe((record) => {
    if (states.at(-1) !== record.state) states.push(record.state);
    if (record.progress) progress.add(record.progress);
  });
  const { port, record } = await startWidgets(supervisor, project);
  assert.equal(record.state, "building");
  assert.equal(record.process?.pgid, record.process?.pid);
  const leftover = await leftoverPid(record);

  const ready = await until(supervisor, record.id, "ready");
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "ok");
  assert.ok(ready.buildSeconds !== undefined && ready.buildSeconds >= 0);
  assert.ok(progress.has("widgets 1/3"));
  assert.equal((await supervisor.start({ project, worktree, port, reserved: [port] })).process?.pid, record.process?.pid);

  control("crash");
  const crashed = await until(supervisor, record.id, "crashed");
  assert.match(crashed.lastError ?? "", /server crashed: TypeError/);
  assert.ok(crashed.process && isAlive(crashed.process.pid));

  control("rebuild");
  await until(supervisor, record.id, "ready");
  assert.deepEqual(states, ["building", "ready", "crashed", "building", "ready"]);

  const result = await supervisor.stop(record.id);
  assert.equal(result.signalled, "group");
  assert.deepEqual(result.swept, [leftover]);
  assert.deepEqual(result.portsBusy, []);
  assert.equal(isAlive(record.process!.pid), false);
  assert.equal(groupAlive(record.process!.pgid), false);
  assert.equal(isAlive(leftover), false);
  const stopped = supervisor.get(record.id);
  assert.equal(stopped?.state, "stopped");
  assert.equal(stopped?.process, null);
  assert.equal(supervisor.watching(record.id), false);
  assert.deepEqual(warnings, []);
});

test("a server that exits is crashed with its exit code and last output", async () => {
  const { supervisor, project } = await supervise(projectOf(rawProject([])));
  const { record } = await startWidgets(supervisor, project);
  await until(supervisor, record.id, "ready");
  control("exit 3");
  const crashed = await until(supervisor, record.id, "crashed");
  assert.match(crashed.lastError ?? "", /exited with code 3; last output: .*fatal: exiting with code 3/);
  assert.equal(crashed.process, null);
  assert.equal(supervisor.watching(record.id), false);
});

test("a build that outlives readiness.timeoutMinutes is crashed, and a stubborn group is killed after the grace period", async () => {
  const project = projectOf(rawProject(["--build-ms", "2000", "--stubborn"], { readiness: { http: { path: "/health" }, timeoutMinutes: 0.005 } }));
  const { supervisor } = await supervise(project);
  const { record } = await startWidgets(supervisor, project);
  const crashed = await until(supervisor, record.id, "crashed");
  assert.match(crashed.lastError ?? "", /not ready after/);
  assert.ok(isAlive(record.process!.pid));

  const startedAt = Date.now();
  const result = await supervisor.stop(record.id, { graceSeconds: 0.5 });
  assert.equal(result.signalled, "group");
  assert.ok(Date.now() - startedAt >= 500);
  assert.match(logOf(record), /ignoring SIGTERM/);
  assert.equal(isAlive(record.process!.pid), false);
});

test("a new worker re-adopts a server started by a worker that died, replaying the log it missed", async () => {
  const raw = rawProject();
  const port = await freePort();
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", START_AND_EXIT, JSON.stringify({ stateDir, worktree, port, project: raw })],
    { encoding: "utf8" },
  );
  const started = JSON.parse(output) as ServerRecord;
  await remember(started.process?.pid);
  assert.equal(started.state, "building");
  const leftover = await leftoverPid(started);
  await waitUntil(() => logOf(started).includes("widgets ready on"), 10_000);

  const { supervisor } = await supervise(projectOf(raw));
  assert.deepEqual(await supervisor.adopt(), [{ id: started.id, outcome: "adopted", detail: `pid ${started.process!.pid}, building` }]);
  await until(supervisor, started.id, "ready");
  const { supervisor: another } = await supervise(projectOf(raw));
  const viaStart = await another.start({ project: projectOf(raw), worktree, port, reserved: [port] });
  assert.equal(viaStart.process?.pid, started.process?.pid);
  another.close();

  control("crash");
  await until(supervisor, started.id, "crashed");
  const result = await supervisor.stop(started.id);
  assert.equal(result.signalled, "group");
  assert.deepEqual(result.swept, [leftover]);
  assert.equal(isAlive(started.process!.pid), false);
  assert.equal(isAlive(leftover), false);
});

test("a recorded pid now held by another process is never adopted nor signalled", async () => {
  const stranger = spawn("sleep", ["60"], { cwd: dir, stdio: "ignore" });
  const info = (await remember(stranger.pid))!;
  const { store, supervisor } = await supervise();
  const now = new Date().toISOString();
  const record = (name: string, proc: ServerRecord["process"]): ServerRecord => {
    const tree = path.join(dir, name);
    fs.mkdirSync(tree);
    return {
      id: serverIdFor(tree),
      project: "widgets",
      worktree: tree,
      port: 1,
      reserved: [],
      state: "ready",
      stateSince: now,
      process: proc,
      pinned: false,
      optIns: { services: [], dedicatedDb: false, reason: null },
      lastUsedAt: now,
      deadlines: {},
      logs: { run: path.join(dir, `${name}.log`) },
    };
  };
  const otherStart = record("widgets-bob", { pid: info.pid, pgid: info.pgid, startedAt: "Mon Jan 1 00:00:00 2001" });
  const otherCwd = record("widgets-carol", { pid: info.pid, pgid: info.pgid, startedAt: info.startedAt });
  const exited = execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim();
  const gone = record("widgets-dave", { pid: Number(exited), pgid: Number(exited), startedAt: info.startedAt });
  const beforeBoot = record("widgets-erin", { pid: Number(exited), pgid: Number(exited), startedAt: "Mon Jan 1 00:00:00 2001" });
  await store.update((draft) => {
    for (const entry of [otherStart, otherCwd, gone, beforeBoot]) draft.servers[entry.id] = entry;
  });

  const refused = await supervisor.stop(otherStart.id);
  assert.equal(refused.signalled, "refused");
  assert.match(refused.note ?? "", /started at/);
  assert.match(warnings.join("\n"), /left alone/);
  assert.ok(isAlive(info.pid));

  await store.update((draft) => void (draft.servers[otherStart.id] = otherStart));
  const outcomes = Object.fromEntries((await supervisor.adopt()).map(({ id, outcome, detail }) => [id, { outcome, detail }]));
  assert.equal(outcomes[otherStart.id].outcome, "rejected");
  assert.equal(outcomes[otherCwd.id].outcome, "rejected");
  assert.match(outcomes[otherCwd.id].detail ?? "", /outside/);
  assert.equal(outcomes[gone.id].outcome, "gone");
  assert.deepEqual(outcomes[beforeBoot.id], { outcome: "gone", detail: "stopped by a machine restart" });
  for (const id of [otherStart.id, otherCwd.id, gone.id, beforeBoot.id]) {
    assert.equal(supervisor.get(id)?.state, id === beforeBoot.id ? "stopped" : "crashed");
    assert.equal(supervisor.get(id)?.process, null);
    assert.equal(supervisor.watching(id), false);
  }
  assert.ok(isAlive(info.pid));
});
