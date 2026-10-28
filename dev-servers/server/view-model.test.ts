import assert from "node:assert/strict";
import { test } from "node:test";
import type { Board, BoardLease, BoardServer, LoginResult, Placement } from "../shared/contracts.ts";
import { SERVER_STATES } from "../shared/states.ts";
import {
  clockTime,
  holdersText,
  idleText,
  loginSteps,
  lostText,
  optInsText,
  orphanLost,
  panelActions,
  pillFor,
  placementText,
  serverActions,
  serversOfAgent,
  stateLabel,
  statusText,
  summarize,
  timelineText,
} from "../shared/view-model.ts";

const lease = (title: string, extra: Partial<BoardLease> = {}): BoardLease => ({
  id: `ls_${title}`,
  kind: "agent",
  holderId: null,
  title,
  agentId: null,
  mine: false,
  since: "2026-10-23T10:00:00.000Z",
  lastUsedAt: "2026-10-23T10:00:00.000Z",
  ...extra,
});

const you = lease("you, in Paseo", { kind: "user", mine: true });

const server = (extra: Partial<BoardServer> = {}): BoardServer => ({
  id: "wt_alice",
  project: "widgets",
  worktree: { path: "/work/widgets-alice", branch: "feat/alice", head: "abc1234", dirty: false },
  port: 8110,
  url: "http://127.0.0.1:8110",
  reserved: [8110],
  state: "ready",
  stateSince: "2026-10-23T10:00:00.000Z",
  pinned: false,
  pinnedBy: null,
  optIns: { services: [], dedicatedDb: false, reason: null },
  leases: [],
  lastUsedAt: "2026-10-23T10:00:00.000Z",
  logs: { run: "/state/logs/wt_alice/run.log" },
  running: true,
  canLogin: true,
  ...extra,
});

const board = (servers: BoardServer[], extra: Partial<Board> = {}): Board => ({ error: null, cap: 3, servers, lost: [], prebuilds: [], ...extra });

const placement = (mode: Placement["mode"], servedFrom = "/work/widgets-alice"): Placement => ({ mode, servedFrom, because: [] });

test("the footer summary counts running servers against the cap, then the building and crashed ones", () => {
  assert.equal(summarize(undefined), "Dev servers");
  assert.equal(summarize(board([], { error: "no config", cap: null })), "Dev servers · off");
  assert.equal(summarize(board([])), "Dev servers 0/3");
  const servers = [
    server({ id: "a", state: "ready" }),
    server({ id: "b", state: "building" }),
    server({ id: "c", state: "prewarming" }),
    server({ id: "d", state: "crashed" }),
    server({ id: "e", state: "crashed", running: false }),
    server({ id: "f", state: "stopped", running: false }),
  ];
  assert.equal(summarize(board(servers, { cap: 5 })), "Dev servers 4/5 · 2 building · 1 crashed");
});

test("every state has a label, and a server started by hand reads as such", () => {
  for (const state of SERVER_STATES) assert.ok(stateLabel(state));
  assert.equal(stateLabel("external"), "started by hand");
  assert.equal(stateLabel("prewarming"), "prebuilding");
});

test("open and open logged in wait for a serving state; logged in is hidden without a login provider", () => {
  for (const state of ["ready", "idle", "external"] as const) {
    const actions = serverActions(server({ state }));
    assert.deepEqual([actions.open.enabled, actions.login.enabled], [true, true], state);
  }
  for (const state of ["building", "prewarming", "crashed", "stopping", "stopped"] as const) {
    const actions = serverActions(server({ state, running: state !== "stopped" }));
    assert.deepEqual([actions.open.enabled, actions.login.visible, actions.login.enabled], [false, true, false], state);
    assert.equal(actions.login.hint, `Waits until it is ready (now ${stateLabel(state)})`);
  }
  assert.equal(serverActions(server({ canLogin: false })).login.visible, false);
});

test("a server started by hand offers no logs, pin nor stop; a stopped one offers logs only", () => {
  const external = serverActions(server({ state: "external" }));
  assert.deepEqual([external.logs.visible, external.pin.visible, external.stop], [false, false, null]);
  const stopped = serverActions(server({ state: "stopped", running: false }));
  assert.deepEqual([stopped.logs.visible, stopped.pin.visible, stopped.stop], [true, false, null]);
  assert.equal(serverActions(server({ state: "stopping" })).stop, null);
  assert.equal(serverActions(server({ pinned: true })).pin.label, "Unpin");
});

test("stop is plain when only the UI holds the server, and forced with who loses it when others hold it or it is pinned", () => {
  assert.deepEqual(serverActions(server({ leases: [you] })).stop, {
    visible: true,
    enabled: true,
    force: false,
    label: "Stop",
    confirm: "Stop widgets-alice on port 8110?",
  });
  const held = serverActions(server({ leases: [you, lease("Alice"), lease("coco demo/1", { kind: "coco" })], pinned: true })).stop;
  assert.equal(held?.force, true);
  assert.equal(held?.label, "Force stop");
  assert.equal(held?.confirm, "Force stop widgets-alice on port 8110? Alice, coco demo/1 will lose it, and it is pinned.");
  assert.equal(serverActions(server({ pinned: true })).stop?.confirm, "Force stop widgets-alice on port 8110? It is pinned.");
});

test("holders, pin, opt-ins, status and idle stop read as sentences", () => {
  assert.equal(holdersText(server()), "Nobody holds it");
  assert.equal(holdersText(server({ leases: [lease("Alice"), you] })), "Held by Alice, you, in Paseo");
  assert.equal(optInsText(server()), null);
  assert.equal(
    optInsText(server({ optIns: { services: ["mailer", "search"], dedicatedDb: true, reason: "check the welcome mail" } })),
    "With services mailer, search and a dedicated database: check the welcome mail",
  );
  assert.equal(statusText(server({ state: "building", progress: "widgets 2/3" })), "Building: widgets 2/3");
  assert.equal(statusText(server({ state: "crashed", lastError: "TypeError: widget is undefined" })), "TypeError: widget is undefined");
  assert.equal(statusText(server({ buildSeconds: 42 })), "Built in 42 s");

  const now = new Date(2026, 9, 23, 9, 0);
  const at = new Date(2026, 9, 23, 15, 42).toISOString();
  assert.equal(idleText(server({ state: "idle", idleStopAt: at }), now), "Stops at 15:42 unless someone uses it");
  assert.equal(idleText(server({ state: "idle", idleStopAt: at, pinned: true }), now), null);
  assert.equal(idleText(server()), null);
  assert.equal(clockTime(new Date(2026, 9, 24, 8, 5).toISOString(), now), "2026-10-24 08:05");
});

test("lost notices name who lost the server and whether they were told; those of a forgotten server stand apart", () => {
  const notice = { id: "lo_1", serverId: "wt_gone", worktree: "/work/widgets-bruno", why: "stopped to make room", holder: "Bruno", agentId: null, seen: false };
  const at = new Date(2026, 9, 23, 14, 3).toISOString();
  assert.equal(lostText({ ...notice, at }, new Date(2026, 9, 23, 15, 0)), "Bruno lost it at 14:03: stopped to make room (not told yet)");
  assert.equal(lostText({ ...notice, at, seen: true }, new Date(2026, 9, 23, 15, 0)), "Bruno lost it at 14:03: stopped to make room");
  const withLost = board([server()], {
    lost: [
      { ...notice, at },
      { ...notice, id: "lo_2", serverId: "wt_alice", at },
    ],
  });
  assert.deepEqual(
    orphanLost(withLost).map(({ id }) => id),
    ["lo_1"],
  );
});

test("the panel offers start while nothing runs, use when another holder runs it, and dedicated only when served from elsewhere", () => {
  assert.equal(panelActions(null, null, false).start.visible, false);
  assert.deepEqual(panelActions(placement("own"), null, false), {
    start: { visible: true, enabled: true, label: "Start" },
    dedicated: { visible: false, enabled: false, label: "" },
  });
  assert.equal(panelActions(placement("own"), server({ leases: [lease("Alice")] }), false).start.label, "Use this server");
  assert.equal(panelActions(placement("own"), server({ leases: [you] }), false).start.visible, false);
  assert.equal(panelActions(placement("own"), server({ state: "stopped", running: false, leases: [] }), false).start.label, "Start");
  for (const mode of ["stack-top", "stack-running"] as const)
    assert.equal(panelActions(placement(mode, "/work/widgets-top"), null, false).dedicated.visible, true);
  const pending = panelActions(placement("stack-top", "/work/widgets-top"), null, true);
  assert.deepEqual([pending.start.enabled, pending.start.label, pending.dedicated.enabled], [false, "Starting…", false]);
  assert.match(pending.start.hint ?? "", /waits for a slot/);
});

test("placement reads as who serves this worktree", () => {
  assert.equal(placementText(placement("own"), "/work/widgets-alice"), "Runs its own server");
  assert.equal(placementText(placement("stack-top", "/work/widgets-top"), "/work/widgets-alice"), "Served by the top of its stack: widgets-top");
});

test("a composer pill shows the state and port of the agent's server, or a count when it holds several", () => {
  const mine = server({ leases: [lease("Alice", { agentId: "agent-1" })], state: "building" });
  const other = server({
    id: "wt_bruno",
    worktree: { ...server().worktree, path: "/work/widgets-bruno" },
    port: 8120,
    leases: [lease("Alice", { agentId: "agent-1" })],
  });
  assert.deepEqual(serversOfAgent(board([mine, server({ id: "x" })]), "agent-1"), [mine]);
  assert.equal(pillFor([]), null);
  assert.deepEqual(pillFor([mine]), { label: "building :8110", title: "Dev server: widgets-alice building on port 8110", tone: "warning" });
  const several = pillFor([other, mine]);
  assert.equal(several?.label, "2 dev servers");
  assert.equal(several?.tone, "warning");
});

test("logging in is one link without a seed, else open the origin and paste one snippet that seeds and navigates", () => {
  const direct: LoginResult = { id: "wt_alice", url: "http://127.0.0.1:8110/", next: "open http://127.0.0.1:8110/ to be logged in" };
  assert.deepEqual(loginSteps(direct), { kind: "direct", url: direct.url, next: direct.next });
  const seeded: LoginResult = {
    ...direct,
    url: "http://127.0.0.1:8110/widgets/42",
    apply: {
      open: "http://127.0.0.1:8110/",
      function: '() => { localStorage.setItem("widgets.session", "tok"); return location.origin; }',
      script: 'localStorage.setItem("widgets.session", "tok");',
      then: "http://127.0.0.1:8110/widgets/42",
    },
  };
  assert.deepEqual(loginSteps(seeded), {
    kind: "seed",
    open: "http://127.0.0.1:8110/",
    snippet: 'localStorage.setItem("widgets.session", "tok"); location.assign("http://127.0.0.1:8110/widgets/42");',
    then: "http://127.0.0.1:8110/widgets/42",
    next: direct.next,
  });
});

test("timeline rows say ready with the url, or stopped with what to do", () => {
  const ready = timelineText({
    event: "ready",
    serverId: "wt_alice",
    worktree: "/work/widgets-alice",
    url: "http://127.0.0.1:8110",
    port: 8110,
    buildSeconds: 7,
    at: "x",
  });
  assert.deepEqual(ready, { title: "Dev server ready on :8110", detail: "widgets-alice at http://127.0.0.1:8110, built in 7 s", tone: "success" });
  const at = new Date(2026, 9, 23, 14, 3);
  const lost = timelineText(
    {
      event: "lost",
      serverId: "wt_alice",
      worktree: "/work/widgets-alice",
      why: "stopped to make room",
      at: at.toISOString(),
      message: "Call dev_server_start again.",
    },
    at,
  );
  assert.deepEqual(lost, { title: "Dev server for widgets-alice stopped at 14:03", detail: "Call dev_server_start again.", tone: "warning" });
});
