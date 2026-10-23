import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { StoreVersionError, createJsonStore, nextDeadline, openStateStore, serverIdFor, type ServerRecord } from "./store.ts";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-store-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const counterSchema = z.object({ version: z.literal(2), count: z.number().int().min(0), items: z.array(z.string()).default([]) });
type Counter = z.output<typeof counterSchema>;
const counterStore = (warnings: string[] = []) =>
  createJsonStore<Counter>({
    file: path.join(dir, "counter.json"),
    schema: counterSchema,
    empty: () => ({ version: 2, count: 0, items: [] }),
    migrate: (raw) => ({ version: 2, count: (raw as { total: number }).total }),
    onWarning: (message) => warnings.push(message),
  });
const onDisk = () => fs.readFileSync(path.join(dir, "counter.json"), "utf8");
const leftovers = () => fs.readdirSync(dir).filter((name) => name !== "counter.json");

test("updates run one at a time, so concurrent callers never lose a write", async () => {
  const store = counterStore();
  await Promise.all(Array.from({ length: 40 }, () => store.update((draft) => void (draft.count += 1))));
  assert.equal(store.snapshot().count, 40);
  assert.equal(JSON.parse(onDisk()).count, 40);
  assert.deepEqual(leftovers(), []);
});

test("a reader never sees a half-written file while large writes land", async () => {
  const store = counterStore();
  const big = Array.from({ length: 20_000 }, (_, index) => `widget-${index}`);
  let writing = true;
  let reads = 0;
  const reader = (async () => {
    while (writing) {
      if (fs.existsSync(path.join(dir, "counter.json"))) {
        JSON.parse(onDisk());
        reads += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  for (let round = 1; round <= 15; round += 1) {
    await store.update((draft) => {
      draft.count = round;
      draft.items = round % 2 ? big : [];
    });
  }
  writing = false;
  await reader;
  assert.ok(reads > 0);
  assert.equal(JSON.parse(onDisk()).count, 15);
  assert.deepEqual(leftovers(), []);
});

test("a throwing or schema-breaking update leaves the file as it was", async () => {
  const store = counterStore();
  await store.update((draft) => void (draft.count = 7));
  const before = onDisk();
  await assert.rejects(
    store.update(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await assert.rejects(store.update((draft) => void (draft.count = -1)));
  assert.equal(onDisk(), before);
  assert.equal(store.snapshot().count, 7);
  await store.update((draft) => void (draft.count += 1));
  assert.equal(JSON.parse(onDisk()).count, 8);
});

test("an unreadable file is kept aside with a warning and the store starts empty", async () => {
  fs.writeFileSync(path.join(dir, "counter.json"), '{"version": 2, "count": ');
  const warnings: string[] = [];
  assert.equal((await counterStore(warnings).load()).count, 0);
  assert.equal(warnings.length, 1);
  assert.match(leftovers()[0], /^counter\.json\.unreadable-/);
});

test("a file from a newer plugin is refused and left untouched; an older one is migrated", async () => {
  fs.writeFileSync(path.join(dir, "counter.json"), JSON.stringify({ version: 3, count: 1 }));
  await assert.rejects(counterStore().load(), StoreVersionError);
  await assert.rejects(
    counterStore().update((draft) => void (draft.count = 2)),
    StoreVersionError,
  );
  assert.equal(JSON.parse(onDisk()).version, 3);

  fs.writeFileSync(path.join(dir, "counter.json"), JSON.stringify({ version: 1, total: 5 }));
  const store = counterStore();
  assert.equal((await store.load()).count, 5);
  await store.update((draft) => void (draft.count += 1));
  assert.deepEqual(JSON.parse(onDisk()), { version: 2, count: 6, items: [] });
});

test("state.json survives a worker restart and its deadlines re-arm from absolute times", async () => {
  const worktree = "/work/acme/widgets-checkout";
  const id = serverIdFor(worktree);
  assert.equal(id, serverIdFor(`${worktree}/`));
  assert.match(id, /^wt_[0-9a-f]{12}$/);
  const server = (deadlines: Record<string, string>): ServerRecord => ({
    id,
    project: "widgets",
    worktree,
    port: 8110,
    reserved: [8110, 8111],
    state: "ready",
    stateSince: "2026-01-05T10:00:00.000Z",
    process: { pid: 4242, pgid: 4242, startedAt: "Mon Jan  5 10:00:00 2026" },
    pinned: false,
    optIns: { services: [], dedicatedDb: false, reason: null },
    lastUsedAt: "2026-01-05T10:05:00.000Z",
    deadlines,
    logs: { run: "/logs/widgets/run.log" },
  });

  const first = openStateStore(dir);
  await first.load();
  await first.update((state) => {
    state.servers[id] = server({ idleStopAt: "2026-01-05T10:35:00.000Z", buildTimeoutAt: "2026-01-05T10:20:00.000Z" });
  });

  const second = openStateStore(dir);
  const state = await second.load();
  assert.deepEqual(state.servers[id], first.snapshot().servers[id]);
  assert.deepEqual(nextDeadline(state), { serverId: id, name: "buildTimeoutAt", at: Date.parse("2026-01-05T10:20:00.000Z") });
  assert.equal(nextDeadline({ version: 1, servers: {}, prebuilds: [] }), null);
});
