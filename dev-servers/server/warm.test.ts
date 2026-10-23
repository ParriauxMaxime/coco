import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig } from "./config.ts";
import { warmWorktree, type WarmStep } from "./warm.ts";

let dir = "";
let main = "";
let worktree = "";

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-warm-")));
  main = path.join(dir, "widgets-main");
  worktree = path.join(dir, "widgets-alice");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), text);
  };
  write("app/node_modules/left-pad/index.js", "module.exports = 1;\n");
  write("app/.cache/bundle/widgets.js", "compiled widgets\n");
  write("app/.cache/manifest.json", '{"files":1}\n');
  fs.symlinkSync("bundle/widgets.js", path.join(main, "app/.cache/latest.js"));
  write("app/.env.local", "WIDGETS_MODE=dev\n");
  fs.mkdirSync(path.join(worktree, "app"), { recursive: true });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const projectWith = (warm: object, mainCheckout = main) =>
  parseConfig({ projects: [{ id: "widgets", match: { paths: [dir] }, command: ["true"], mainCheckout, warm }] }).projects[0];

const WARM = { symlink: ["app/node_modules", "app/vendor"], clone: ["app/.cache"], copyIfMissing: ["app/.env.local"] };
const CLONE_METHOD = process.platform === "darwin" ? "cp -cR" : process.platform === "linux" ? "cp -R --reflink=auto" : "copy";

const outcomes = (steps: WarmStep[]) => steps.map(({ kind, path: rel, outcome, method }) => [kind, rel, outcome, method ?? null]);
const read = (rel: string) => fs.readFileSync(path.join(worktree, rel), "utf8");

test("warming links the deps, clones the build cache copy-on-write, copies a missing file, and a second run touches nothing", async () => {
  fs.mkdirSync(path.join(worktree, "app/.cache.warming-123-abcdef"), { recursive: true });
  const steps = await warmWorktree({ project: projectWith(WARM), worktree });
  assert.deepEqual(outcomes(steps), [
    ["symlink", "app/node_modules", "done", "symlink"],
    ["symlink", "app/vendor", "no-source", null],
    ["clone", "app/.cache", "done", CLONE_METHOD],
    ["copyIfMissing", "app/.env.local", "done", "copy"],
  ]);
  assert.equal(fs.readlinkSync(path.join(worktree, "app/node_modules")), path.join(main, "app/node_modules"));
  assert.equal(read("app/node_modules/left-pad/index.js"), "module.exports = 1;\n");
  assert.equal(read("app/.cache/bundle/widgets.js"), "compiled widgets\n");
  assert.equal(fs.readlinkSync(path.join(worktree, "app/.cache/latest.js")), "bundle/widgets.js");
  assert.ok(!fs.lstatSync(path.join(worktree, "app/.cache")).isSymbolicLink());
  assert.equal(read("app/.env.local"), "WIDGETS_MODE=dev\n");
  assert.deepEqual(
    fs.readdirSync(path.join(worktree, "app")).filter((name) => name.includes(".warming-")),
    [],
  );

  fs.writeFileSync(path.join(worktree, "app/.cache/manifest.json"), '{"files":2}\n');
  fs.writeFileSync(path.join(worktree, "app/.env.local"), "WIDGETS_MODE=mine\n");
  const again = await warmWorktree({ project: projectWith(WARM), worktree });
  assert.deepEqual(
    again.map(({ outcome }) => outcome),
    ["exists", "no-source", "exists", "exists"],
  );
  assert.equal(read("app/.cache/manifest.json"), '{"files":2}\n');
  assert.equal(read("app/.env.local"), "WIDGETS_MODE=mine\n");
});

test("without copy-on-write the clone falls back to a plain copy that keeps inner links as links", async () => {
  const steps = await warmWorktree({ project: projectWith({ clone: ["app/.cache"] }), worktree, platform: "freebsd" });
  assert.deepEqual(outcomes(steps), [["clone", "app/.cache", "done", "copy"]]);
  assert.equal(read("app/.cache/manifest.json"), '{"files":1}\n');
  assert.equal(fs.readlinkSync(path.join(worktree, "app/.cache/latest.js")), "bundle/widgets.js");
  fs.rmSync(path.join(main, "app/.cache/manifest.json"));
  assert.equal(read("app/.cache/manifest.json"), '{"files":1}\n');
});

test("a building source is not cloned, paths outside the worktree are refused, and the main checkout itself is never warmed", async () => {
  const busy = await warmWorktree({ project: projectWith(WARM), worktree, sourceBusy: (source) => source === main });
  assert.deepEqual(
    busy.map(({ kind, outcome }) => [kind, outcome]),
    [
      ["symlink", "done"],
      ["symlink", "no-source"],
      ["clone", "busy"],
      ["copyIfMissing", "done"],
    ],
  );
  assert.ok(!fs.existsSync(path.join(worktree, "app/.cache")));

  const escaping = await warmWorktree({ project: projectWith({ symlink: ["../outside", "."] }), worktree });
  assert.deepEqual(
    escaping.map(({ outcome, detail }) => [outcome, detail]),
    [
      ["failed", "points outside the worktree"],
      ["failed", "points outside the worktree"],
    ],
  );
  assert.ok(!fs.existsSync(path.join(dir, "outside")));

  assert.deepEqual(await warmWorktree({ project: projectWith(WARM), worktree: main }), []);
  const unsourced = await warmWorktree({ project: projectWith({ symlink: ["app/node_modules"] }, ""), worktree });
  assert.deepEqual(outcomes(unsourced), [["symlink", "app/node_modules", "no-source", null]]);
});
