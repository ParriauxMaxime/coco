import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { parseConfig } from "./config.ts";
import { PortUnavailableError, listenerProbe, openPortRegistry, type PortHolder, type PortProbe } from "./ports.ts";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-ports-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const portsOf = (ports: object) =>
  parseConfig({ projects: [{ id: "widgets", match: { remote: "acme/widgets" }, command: ["npm", "run", "dev"], ports }] }).projects[0].ports;

const probeWith =
  (held: Record<number, PortHolder> = {}): PortProbe =>
  async (port) =>
    held[port] ?? "free";

const free = probeWith();

test("worktrees get the range start, then one step up, and keep their port across a restart", async () => {
  const ports = portsOf({ range: [8100, 8990], step: 10 });
  const registry = openPortRegistry(dir);
  const alice = await registry.ensure({ worktree: "/work/widgets-alice", project: "widgets", ports, probe: free });
  const bob = await registry.ensure({ worktree: "/work/widgets-bob", project: "widgets", ports, probe: free });
  assert.deepEqual([alice.base, bob.base], [8100, 8110]);
  assert.equal(alice.reassigned, null);

  const reopened = openPortRegistry(dir);
  await reopened.load();
  assert.equal(reopened.get("/work/widgets-bob/")?.base, 8110);
  assert.deepEqual(await reopened.ensure({ worktree: "/work/widgets-bob", project: "widgets", ports, probe: free }), {
    base: 8110,
    reserved: [8110],
    reassigned: null,
  });
});

test("excluded ports are never handed out, whether a base or a reserved companion", async () => {
  const registry = openPortRegistry(dir);
  const base = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports: portsOf({ exclude: [8100] }), probe: free });
  assert.equal(base.base, 8110);
  const companion = await registry.ensure({
    worktree: "/work/widgets-b",
    project: "widgets",
    ports: portsOf({ reserve: ["{port}", "{port+1}"], exclude: [8101, 8121] }),
    probe: free,
  });
  assert.deepEqual(companion, { base: 8130, reserved: [8130, 8131], reassigned: null });
});

test("a port held by a foreign process is skipped, and a kept port taken over later gets a new allocation", async () => {
  const ports = portsOf({ reserve: ["{port}", "{port+1}"] });
  const registry = openPortRegistry(dir);
  const first = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports, probe: probeWith({ 8101: "foreign" }) });
  assert.equal(first.base, 8110);

  const ours = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports, probe: probeWith({ 8110: "ours", 8111: "ours" }) });
  assert.equal(ours.reassigned, null);

  const moved = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports, probe: probeWith({ 8111: "foreign" }) });
  assert.deepEqual(moved, { base: 8100, reserved: [8100, 8101], reassigned: { from: 8110, because: ["port 8111 is held by another process"] } });
  assert.equal(registry.get("/work/widgets-a")?.base, 8100);
});

test("extra offsets keep every worktree's reserved set disjoint, across projects too", async () => {
  const debug = portsOf({ range: [8100, 8990], step: 10, reserve: ["{port}", "{port+1}", "{port+1229}"] });
  const narrow = portsOf({ range: [9329, 9400], step: 1 });
  const registry = openPortRegistry(dir);
  const app = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports: debug, probe: free });
  assert.deepEqual(app.reserved, [8100, 8101, 9329]);
  const other = await registry.ensure({ worktree: "/work/gadgets-a", project: "gadgets", ports: narrow, probe: free });
  assert.equal(other.base, 9330);

  const reversed = openPortRegistry(path.join(dir, "reversed"));
  await reversed.ensure({ worktree: "/work/gadgets-a", project: "gadgets", ports: narrow, probe: free });
  const shifted = await reversed.ensure({ worktree: "/work/widgets-a", project: "widgets", ports: debug, probe: free });
  assert.deepEqual(shifted.reserved, [8110, 8111, 9339]);

  const overlapping = portsOf({ range: [8100, 8140], step: 10, reserve: ["{port}", "{port+20}"] });
  const tight = openPortRegistry(path.join(dir, "tight"));
  const bases = [];
  for (const name of ["a", "b", "c"])
    bases.push((await tight.ensure({ worktree: `/work/widgets-${name}`, project: "widgets", ports: overlapping, probe: free })).base);
  assert.deepEqual(bases, [8100, 8110, 8140]);
  await assert.rejects(tight.ensure({ worktree: "/work/widgets-d", project: "widgets", ports: overlapping, probe: free }), PortUnavailableError);
});

test("a port the config no longer allows is reallocated with the reason", async () => {
  const registry = openPortRegistry(dir);
  await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports: portsOf({}), probe: free });
  const moved = await registry.ensure({ worktree: "/work/widgets-a", project: "widgets", ports: portsOf({ range: [8500, 8600] }), probe: free });
  assert.deepEqual(moved.reassigned, { from: 8100, because: ["port 8100 is outside the range 8500-8600 (step 10)"] });
  assert.equal(moved.base, 8500);
});

test("release frees a worktree's ports and the sweep drops worktrees whose directory is gone", async () => {
  const kept = fs.mkdtempSync(path.join(dir, "widgets-kept-"));
  const registry = openPortRegistry(path.join(dir, "state"));
  for (const worktree of [kept, path.join(dir, "widgets-removed"), "/work/widgets-released"]) {
    await registry.ensure({ worktree, project: "widgets", ports: portsOf({}), probe: free });
  }
  await registry.release("/work/widgets-released");
  assert.deepEqual(await registry.sweep(), [path.join(dir, "widgets-removed")]);
  assert.equal(registry.get(kept)?.base, 8100);
  const next = await registry.ensure({ worktree: "/work/widgets-new", project: "widgets", ports: portsOf({}), probe: free });
  assert.equal(next.base, 8110);
});

test("the listener probe tells a real listener from a free port and defers to the owner check", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    assert.equal(await listenerProbe()(port), "foreign");
    assert.equal(await listenerProbe({ isOurs: (candidate) => candidate === port })(port), "ours");
    const registry = openPortRegistry(dir);
    const assigned = await registry.ensure({
      worktree: "/work/widgets-a",
      project: "widgets",
      ports: portsOf({ range: [port, port + 1], step: 1 }),
      probe: listenerProbe(),
    });
    assert.equal(assigned.base, port + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await listenerProbe()(port), "free");
});
