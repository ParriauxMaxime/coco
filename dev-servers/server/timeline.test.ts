import assert from "node:assert/strict";
import { test } from "node:test";
import { TIMELINE_KIND, timelineRowSchema, type Holder, type LeaseView } from "../shared/contracts.ts";
import type { ServerRecord } from "./store.ts";
import { createTimelineNotifier, type TimelineItem } from "./timeline.ts";

const record = (state: ServerRecord["state"], extra: Partial<ServerRecord> = {}): ServerRecord => ({
  id: "wt_alice",
  project: "widgets",
  worktree: "/work/widgets-alice",
  port: 8110,
  reserved: [8110],
  state,
  stateSince: "2026-10-23T10:00:00.000Z",
  process: { pid: 4242, pgid: 4242, startedAt: "Fri Oct 23 10:00:00 2026" },
  pinned: false,
  optIns: { services: [], dedicatedDb: false, reason: null },
  lastUsedAt: "2026-10-23T10:00:00.000Z",
  deadlines: {},
  logs: { run: "/state/logs/wt_alice/run.log" },
  ...extra,
});

const lease = (holder: Holder): LeaseView => ({ id: `ls_${holder.id}`, holder, since: "x", lastUsedAt: "x" });
const AGENTS: Record<string, string> = { dk_alice: "agent-alice", dk_bruno: "agent-bruno" };

const setup = ({ sink = true, failing = false } = {}) => {
  const rows: { agentId: string; item: TimelineItem }[] = [];
  const warnings: string[] = [];
  const notifier = createTimelineNotifier({
    holders: () => [lease({ kind: "agent", id: "dk_alice" }), lease({ kind: "user", id: "paseo" }), lease({ kind: "agent", id: "dk_unbound" })],
    agentOf: (holder) => (holder.kind === "agent" ? (AGENTS[holder.id] ?? null) : null),
    urlOf: (current) => `http://127.0.0.1:${current.port}`,
    append: () =>
      sink
        ? async (agentId, item) => {
            if (failing) throw new Error("daemon went away");
            rows.push({ agentId, item });
          }
        : null,
    onWarning: (message) => warnings.push(message),
  });
  return { notifier, rows, warnings };
};

test("a build turning ready tells each agent holding the server, once per server, and a rebuild replaces that row", () => {
  const { notifier, rows } = setup();
  notifier.serverChanged(record("building"));
  notifier.serverChanged(record("building", { progress: "widgets 2/3" }));
  notifier.serverChanged(record("ready", { buildSeconds: 7 }));
  assert.equal(rows.length, 1);
  const [{ agentId, item }] = rows;
  assert.equal(agentId, "agent-alice");
  assert.deepEqual(
    { ...item, data: { ...item.data, at: "" } },
    {
      type: "plugin",
      id: "dev-server-ready-wt_alice",
      kind: TIMELINE_KIND,
      version: 1,
      data: { event: "ready", serverId: "wt_alice", worktree: "/work/widgets-alice", url: "http://127.0.0.1:8110", port: 8110, buildSeconds: 7, at: "" },
    },
  );
  assert.ok(timelineRowSchema.safeParse(item.data).success);

  notifier.serverChanged(record("building"));
  notifier.serverChanged(record("ready"));
  assert.deepEqual(
    rows.map(({ item }) => item.id),
    ["dev-server-ready-wt_alice", "dev-server-ready-wt_alice"],
  );
});

test("no ready row for a server first seen ready, back from idle, or finishing a prebuild", () => {
  const { notifier, rows } = setup();
  notifier.serverChanged(record("ready"));
  notifier.serverChanged(record("idle"));
  notifier.serverChanged(record("ready"));
  notifier.serverChanged(record("prewarming", { id: "wt_bruno", prebuild: true }));
  notifier.serverChanged(record("building", { id: "wt_bruno", prebuild: true }));
  notifier.serverChanged(record("ready", { id: "wt_bruno", prebuild: true }));
  assert.deepEqual(rows, []);
});

test("each lost lease of a bound agent becomes its own row with the notice the agent also gets from its tools", () => {
  const { notifier, rows } = setup();
  const at = "2026-10-23T11:00:00.000Z";
  const why = "stopped to make room for /work/widgets-carol: it was the least recently used of the 3 running servers";
  notifier.lost([
    { id: "lo_1", serverId: "wt_alice", worktree: "/work/widgets-alice", holder: { kind: "agent", id: "dk_alice" }, why, at },
    { id: "lo_2", serverId: "wt_alice", worktree: "/work/widgets-alice", holder: { kind: "agent", id: "dk_bruno" }, why, at },
    { id: "lo_3", serverId: "wt_alice", worktree: "/work/widgets-alice", holder: { kind: "user", id: "paseo" }, why, at },
  ]);
  assert.deepEqual(
    rows.map(({ agentId, item }) => [agentId, item.id]),
    [
      ["agent-alice", "dev-server-lost-lo_1"],
      ["agent-bruno", "dev-server-lost-lo_2"],
    ],
  );
  assert.deepEqual(rows[0].item.data, {
    event: "lost",
    serverId: "wt_alice",
    worktree: "/work/widgets-alice",
    why,
    at,
    message: `The dev server for /work/widgets-alice that you held is gone (${why}). Call dev_server_start again if you still need one.`,
  });
});

test("without a Paseo session rows are dropped, and a failing append only warns", async () => {
  const quiet = setup({ sink: false });
  quiet.notifier.serverChanged(record("building"));
  quiet.notifier.serverChanged(record("ready"));
  assert.deepEqual(quiet.rows, []);

  const failing = setup({ failing: true });
  failing.notifier.serverChanged(record("building"));
  failing.notifier.serverChanged(record("ready"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failing.warnings, ["timeline row for agent agent-alice failed: daemon went away"]);
});
