import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LogTail, classifyLine, compilePatterns, initialPhase, nextPhase, probeHttp, wantsProbe, type Phase, type PhaseContext } from "./readiness.ts";

const patterns = compilePatterns({ progress: "building (\\S+)", ready: "widgets ready", crash: "server crashed", rebuild: "file change seen" });
const at = (seconds: number, overrides: Partial<PhaseContext> = {}): PhaseContext => ({
  patterns,
  now: new Date(Date.UTC(2026, 9, 23, 12, 0, seconds)),
  buildTimeoutMs: 60_000,
  ...overrides,
});
const line = (phase: Phase, text: string, seconds: number, ctx?: Partial<PhaseContext>) => nextPhase(phase, { kind: "line", line: text }, at(seconds, ctx));

test("a line matching several patterns counts as a crash first, and progress keeps its capture", () => {
  assert.deepEqual(classifyLine("building widgets/2 then server crashed", patterns), { kind: "crash", detail: "building widgets/2 then server crashed" });
  assert.deepEqual(classifyLine("building widgets/2", patterns), { kind: "progress", detail: "widgets/2" });
  assert.equal(classifyLine("nothing to see", patterns), null);
});

test("ready needs the ready line and then a passing probe, and records the build time", () => {
  let phase = initialPhase(at(0));
  assert.equal(phase.readyBy, "2026-10-23T12:01:00.000Z");
  phase = line(phase, "\u001b[32mbuilding widgets/1\u001b[0m", 1);
  assert.equal(phase.progress, "widgets/1");
  assert.equal(wantsProbe(phase, patterns), false);
  assert.equal(nextPhase(phase, { kind: "probe-ok" }, at(2)).state, "building");
  phase = line(phase, "widgets ready on :8100", 3);
  phase = nextPhase(phase, { kind: "probe-ok" }, at(4));
  assert.deepEqual([phase.state, phase.buildSeconds, phase.progress, phase.readyBy], ["ready", 4, undefined, undefined]);
});

test("without a ready pattern, the probe alone makes the server ready", () => {
  const bare = compilePatterns({});
  const phase = nextPhase(initialPhase(at(0, { patterns: bare })), { kind: "probe-ok" }, at(5, { patterns: bare }));
  assert.equal(phase.state, "ready");
});

test("crash, then a rebuild starts a new build with a new deadline, and a stale ready line does not count", () => {
  let phase = nextPhase(line(initialPhase(at(0)), "widgets ready", 1), { kind: "probe-ok" }, at(2));
  phase = line(phase, "server crashed: TypeError", 10);
  assert.deepEqual([phase.state, phase.lastError, phase.readyBy], ["crashed", "server crashed: TypeError", undefined]);
  phase = line(phase, "file change seen", 20);
  assert.deepEqual(
    [phase.state, phase.stateSince, phase.readyBy, phase.readySeen],
    ["building", "2026-10-23T12:00:20.000Z", "2026-10-23T12:01:20.000Z", false],
  );
  assert.equal(wantsProbe(phase, patterns), false);
});

test("a progress line after a crash means the tool is building again", () => {
  const crashed = line(initialPhase(at(0)), "server crashed", 1);
  assert.deepEqual([line(crashed, "building widgets/1", 2).state, line(crashed, "building widgets/1", 2).progress], ["building", "widgets/1"]);
});

test("a build past its deadline is crashed; an exit is crashed with its detail; stopped servers ignore events", () => {
  const phase = initialPhase(at(0));
  assert.equal(nextPhase(phase, { kind: "tick" }, at(59)).state, "building");
  assert.deepEqual(
    [nextPhase(phase, { kind: "tick" }, at(60)).state, nextPhase(phase, { kind: "tick" }, at(60)).lastError],
    ["crashed", "not ready after 1 min"],
  );
  assert.equal(nextPhase(phase, { kind: "exit", detail: "exited with code 1" }, at(3)).lastError, "exited with code 1");
  const stopped: Phase = { ...phase, state: "stopped" };
  assert.equal(line(stopped, "server crashed", 4), stopped);
});

test("the log tail returns whole lines only and starts over when the file is truncated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-tail-"));
  try {
    const file = path.join(dir, "run.log");
    fs.writeFileSync(file, "old run\n");
    const tail = new LogTail(file, fs.statSync(file).size);
    fs.appendFileSync(file, "building widgets/1\nbuild");
    assert.deepEqual(await tail.read(), ["building widgets/1"]);
    fs.appendFileSync(file, "ing widgets/2\n");
    assert.deepEqual(await tail.read(), ["building widgets/2"]);
    fs.writeFileSync(file, "fresh\n");
    assert.deepEqual(await tail.read(), ["fresh"]);
    assert.deepEqual(tail.lastLines(2), ["building widgets/2", "fresh"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the HTTP probe checks the status and the body", async () => {
  const server = http.createServer((request, response) => {
    response.statusCode = request.url === "/down" ? 503 : 200;
    response.end(request.url === "/health" ? "ok" : "starting");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(await probeHttp(origin, { path: "/health", bodyIncludes: "ok" }), true);
    assert.equal(await probeHttp(origin, { path: "/", bodyIncludes: "ok" }), false);
    assert.equal(await probeHttp(origin, { path: "/down" }), false);
  } finally {
    server.close();
  }
  assert.equal(await probeHttp(origin, { path: "/health" }, 300), false);
});
