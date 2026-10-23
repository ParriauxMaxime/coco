import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfig, renderTemplate, renderValue, resolveApi } from "./config.ts";

const home = "/home/alice";
const widgets = { id: "widgets", match: { remote: "acme/widgets" }, command: ["npm", "run", "dev", "--", "--port", "{port}"] };

test("an empty config gets every default, with ~ expanded", () => {
  const config = parseConfig({}, { home });
  assert.deepEqual(config.api, { port: 8779, bind: "127.0.0.1" });
  assert.equal(config.stateDir, "/home/alice/.cocopilot/dev-servers");
  assert.deepEqual(config.worktreeRoots, ["/home/alice/.paseo/worktrees"]);
  assert.deepEqual([config.cap, config.idleStopMinutes, config.leaseTtlMinutes, config.injectMcp], [3, 30, 240, "matching-projects"]);
  assert.deepEqual(config.projects, []);
});

test("a partial project is merged over the nested defaults without losing the keys it sets", () => {
  const [project] = parseConfig(
    {
      cap: 2,
      projects: [
        {
          ...widgets,
          mainCheckout: "~/code/widgets",
          match: { paths: ["~/code/widgets"] },
          ports: { range: [9000, 9100] },
          readiness: { http: { bodyIncludes: "ok" } },
          warm: { symlink: ["app/node_modules"] },
          provider: "~/providers/widgets.mjs",
        },
      ],
    },
    { home },
  ).projects;
  assert.equal(project.mainCheckout, "/home/alice/code/widgets");
  assert.deepEqual(project.match, { paths: ["/home/alice/code/widgets"] });
  assert.equal(project.provider, "/home/alice/providers/widgets.mjs");
  assert.deepEqual(project.ports, { range: [9000, 9100], step: 10, reserve: ["{port}"], exclude: [] });
  assert.deepEqual(project.readiness, { http: { path: "/", bodyIncludes: "ok" }, timeoutMinutes: 15 });
  assert.deepEqual(project.warm, { symlink: ["app/node_modules"], clone: [], copyIfMissing: [], prebuild: false });
  assert.deepEqual(project.stop, { graceSeconds: 10, sweepCwdUnder: [] });
  assert.deepEqual([project.appDir, project.urlTemplate, project.env], [".", "http://localhost:{port}", {}]);
});

test("config mistakes are refused with the offending path", () => {
  const refused = (raw: unknown, pattern: RegExp) => assert.throws(() => parseConfig(raw, { home }), pattern);
  refused({ projects: [{ ...widgets, command: ["serve", "--port", "{prot}"] }] }, /unknown placeholder \{prot\}/);
  refused({ projects: [{ ...widgets, env: { LOG: "{logdir}" } }] }, /unknown placeholder \{logdir\}/);
  refused({ projects: [{ ...widgets, settings: { file: "app/local.json", overlay: { nested: ["{home}"] } } }] }, /unknown placeholder \{home\}/);
  refused({ projects: [{ ...widgets, logPatterns: { crash: "([" } }] }, /not a valid regular expression/);
  refused({ projects: [{ ...widgets, ports: { reserve: ["{port}", "{port-1}"] } }] }, /\{port\+N\}/);
  refused({ projects: [{ ...widgets, ports: { reserve: ["{port+1}"] } }] }, /reserve must include/);
  refused({ projects: [{ ...widgets, ports: { range: [9000, 8000] } }] }, /range starts above its end/);
  refused({ projects: [{ ...widgets, match: {} }] }, /match\.remote or match\.paths/);
  refused({ projects: [widgets, widgets] }, /duplicate project id \\"widgets\\"/);
  refused({ idleStopMinute: 5 }, /idleStopMinute/);
  refused({ projects: [{ ...widgets, command: [] }] }, /command/);
});

test("templates fill {port}, {port+N}, {logDir}, {worktree} and {services}; a lone placeholder keeps its type", () => {
  const vars = { port: 8110, logDir: "/logs/widgets", worktree: "/work/widgets", services: ["mailer", "billing"] };
  assert.deepEqual(
    ["--port", "{port}", "--inspect={port+1229}", "--log={logDir}/run.log", "{worktree}/app", "--services={services}"].map((arg) => renderTemplate(arg, vars)),
    ["--port", "8110", "--inspect=9339", "--log=/logs/widgets/run.log", "/work/widgets/app", "--services=mailer,billing"],
  );
  assert.deepEqual(
    renderValue({ port: "{port}", debug: "{port+1}", url: "http://localhost:{port}", enabled: "{services}", keep: [true, 3, null, "x{2}"] }, vars),
    {
      port: 8110,
      debug: 8111,
      url: "http://localhost:8110",
      enabled: ["mailer", "billing"],
      keep: [true, 3, null, "x{2}"],
    },
  );
  assert.throws(() => renderTemplate("{logDir}/run.log", { port: 8110 }), /no value for \{logDir\}/);
});

test("the plugin's API port setting wins over the config, which applies when the setting is empty", () => {
  const { api } = parseConfig({ api: { port: 9779 } }, { home });
  assert.deepEqual(resolveApi(api, null), { bind: "127.0.0.1", port: 9779 });
  assert.deepEqual(resolveApi(api, 8800), { bind: "127.0.0.1", port: 8800 });
});

test("loadConfig reads the devServers key and reports a missing file, bad JSON or a bad block without throwing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-config-"));
  const write = (name: string, text: string) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  try {
    const missing = await loadConfig(path.join(dir, "absent.json"), { home });
    assert.deepEqual([missing.found, missing.error, missing.config?.projects], [false, null, []]);

    const other = await loadConfig(write("other.json", JSON.stringify({ owner: { login: "alice" } })), { home });
    assert.deepEqual([other.found, other.error, other.config?.cap], [true, null, 3]);

    const good = await loadConfig(write("good.json", JSON.stringify({ owner: { login: "alice" }, devServers: { cap: 2, projects: [widgets] } })), { home });
    assert.deepEqual([good.error, good.config?.cap, good.config?.projects.map(({ id }) => id)], [null, 2, ["widgets"]]);

    const broken = await loadConfig(write("broken.json", "{ devServers: "), { home });
    assert.equal(broken.config, null);
    assert.match(broken.error ?? "", /broken\.json/);

    const invalid = await loadConfig(write("invalid.json", JSON.stringify({ devServers: { projects: [{ ...widgets, command: "npm run dev" }] } })), { home });
    assert.equal(invalid.config, null);
    assert.match(invalid.error ?? "", /projects\[0\]\.command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
