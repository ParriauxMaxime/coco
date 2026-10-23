import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { PATIENCE_MS, freePort, killTestProcesses, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { isAlive } from "./proc.ts";
import { createSettingsFiles, foldEdit } from "./settings-overlay.ts";
import { openStateStore, serverIdFor, type DevServersState, type JsonStore } from "./store.ts";
import { createSupervisor, type Supervisor } from "./supervisor.ts";

const PROVIDER = fileURLToPath(new URL("../test/fixtures/widgets-provider.mjs", import.meta.url));

let dir = "";
let stateDir = "";
let worktree = "";
let settingsFile = "";
const warnings: string[] = [];
const stores: JsonStore<DevServersState>[] = [];
const supervisors: Supervisor[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-settings-")));
  stateDir = path.join(dir, "state");
  worktree = path.join(dir, "widgets-alice");
  fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
  settingsFile = path.join(worktree, "app", "local.json");
  warnings.length = 0;
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) supervisor.close();
  await killTestProcesses(stores.splice(0), stateDir, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

const projectWith = (settings: object, extra: object = {}) =>
  parseConfig({ projects: [{ id: "widgets", match: { remote: "acme/widgets" }, command: ["true"], settings, ...extra }] }).projects[0];

const overlaid = { file: "app/local.json", overlay: { logDir: "{logDir}", cache: { port: "{port+1}" } } };
const files = () => createSettingsFiles({ stateDir, onWarning: (message) => warnings.push(message) });
const request = (project = projectWith(overlaid), more: object = {}) => ({
  id: serverIdFor(worktree),
  project,
  worktree,
  port: 8100,
  logDir: "/logs/alice",
  services: [],
  dedicatedDb: false,
  ...more,
});
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));

test("with no settings file, start writes the overlay alone and stop removes the file again", async () => {
  const settings = files();
  assert.equal((await settings.apply(request()))?.file, settingsFile);
  assert.deepEqual(readSettings(), { logDir: "/logs/alice", cache: { port: 8101 } });
  await settings.restore(serverIdFor(worktree));
  assert.equal(fs.existsSync(settingsFile), false);
  assert.equal(await settings.restore(serverIdFor(worktree)), null);
});

test("the user's own settings stay underneath the overlay, the provider sees them, and stop puts back the exact original text", async () => {
  const original = '{"workers": {"mailer": {"every": 5}, "billing": {"every": 60}},\n  "theme": "dark", "cache": {"size": 10}}\n';
  fs.writeFileSync(settingsFile, original);
  const settings = files();
  await settings.apply(request(projectWith(overlaid, { provider: PROVIDER }), { services: ["billing"], dedicatedDb: true }));
  assert.deepEqual(readSettings(), {
    workers: { mailer: null, billing: { every: 60 } },
    theme: "dark",
    cache: { size: 10, port: 8101 },
    logDir: "/logs/alice",
    servedOn: 8100,
    freshDb: true,
  });
  await settings.restore(serverIdFor(worktree));
  assert.equal(fs.readFileSync(settingsFile, "utf8"), original);
  assert.deepEqual(warnings, []);
});

test("a hand edit to the generated file is backed up and folded into the user's settings", async () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: "dark", locale: "fr", workers: { mailer: { every: 5 } } }));
  const settings = files();
  const project = projectWith(overlaid, { provider: PROVIDER });
  await settings.apply(request(project));
  const edited = { ...readSettings(), theme: "light", beta: true, workers: { mailer: { every: 1 } } };
  delete edited.locale;
  fs.writeFileSync(settingsFile, JSON.stringify(edited));

  const outcome = await settings.restore(serverIdFor(worktree));
  assert.deepEqual(readSettings(), { theme: "light", workers: { mailer: { every: 1 } }, beta: true });
  assert.ok(outcome?.folded && fs.existsSync(outcome.folded.backup));
  assert.deepEqual(JSON.parse(fs.readFileSync(outcome.folded.backup, "utf8")), edited);
  assert.match(warnings.join("\n"), /edited by hand/);

  fs.writeFileSync(settingsFile, JSON.stringify({ theme: "blue" }));
  warnings.length = 0;
  assert.equal((await settings.apply(request(project)))?.folded, undefined);
  assert.deepEqual(readSettings(), { theme: "blue", workers: {}, logDir: "/logs/alice", cache: { port: 8101 }, servedOn: 8100, freshDb: false });
  assert.deepEqual(warnings, []);
});

test("a hand edit seen at the next start is folded the same way before the overlay is written again", async () => {
  const settings = files();
  await settings.apply(request());
  fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), workers: { search: { enabled: true } } }));
  const outcome = await settings.apply(request(projectWith(overlaid), { port: 8200 }));
  assert.ok(outcome?.folded);
  assert.deepEqual(readSettings(), { logDir: "/logs/alice", cache: { port: 8201 }, workers: { search: { enabled: true } } });
  await settings.restore(serverIdFor(worktree));
  assert.deepEqual(readSettings(), { workers: { search: { enabled: true } } });
});

test("settings that are not a plain JSON object, or a file outside the worktree, are refused without touching anything", async () => {
  fs.writeFileSync(settingsFile, '{ "theme": "dark", // mine\n}');
  await assert.rejects(files().apply(request()), /local\.json is not plain JSON/);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), '{ "theme": "dark", // mine\n}');
  await assert.rejects(files().apply(request(projectWith({ file: "../elsewhere.json" }))), /outside the worktree/);
});

test("foldEdit keeps base keys the edit did not touch and drops nested keys it removed", () => {
  const base = { a: 1, nested: { keep: 1, drop: 2 } };
  const generated = { a: 1, nested: { keep: 1, drop: 2, extra: null }, overlay: "x" };
  const edited = { a: 2, nested: { keep: 1, extra: null, added: true }, overlay: "x" };
  assert.deepEqual(foldEdit(base, generated, edited), { a: 2, nested: { keep: 1, added: true } });
});

test("the supervisor writes the settings before the server starts and restores them when it stops", async () => {
  fs.writeFileSync(settingsFile, '{"theme":"dark"}\n');
  const base = await freePort();
  const project = parseConfig({ projects: [widgets(base, { settings: overlaid, provider: PROVIDER })] }).projects[0];
  const store = openStateStore(stateDir);
  stores.push(store);
  await store.load();
  const supervisor = createSupervisor({ store, stateDir, project: () => project, pollMs: 100, onWarning: (message) => warnings.push(message) });
  supervisors.push(supervisor);
  const record = await supervisor.start({ project, worktree, port: base, reserved: [base] });
  assert.deepEqual(readSettings(), {
    theme: "dark",
    logDir: path.join(stateDir, "logs", record.id),
    cache: { port: base + 1 },
    workers: {},
    servedOn: base,
    freshDb: false,
  });
  assert.match(fs.readFileSync(record.logs.run, "utf8"), /settings in .*local\.json/);
  assert.equal((await supervisor.waitFor(record.id, (current) => current?.state === "ready", PATIENCE_MS))?.state, "ready");
  await supervisor.stop(record.id);
  assert.equal(isAlive(record.process!.pid), false);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), '{"theme":"dark"}\n');
  assert.deepEqual(warnings, []);
});
