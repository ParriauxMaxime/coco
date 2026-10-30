import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { PluginBeforeRequests, PluginHookAgent, PluginHookWorkspace, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import { gitRepo, widgets } from "../test/helpers.ts";
import { parseConfig } from "./config.ts";
import { KEY_PATTERN, createLeaseManager, openLeaseStore, type LeaseManager } from "./leases.ts";
import { MCP_TOOL_NAMES } from "./mcp.ts";
import { createPaseoHooks, registerPaseoHooks, type HookRuntime, type WorkspaceHandlers } from "./paseo-hooks.ts";
import { openStateStore } from "./store.ts";

const MCP_URL = "http://127.0.0.1:8779/mcp";

let dir = "";
let worktree = "";
let plain = "";
let managers: LeaseManager[] = [];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-servers-hooks-")));
  worktree = gitRepo(path.join(dir, "widgets-alice"), "https://git.example/acme/widgets.git");
  plain = path.join(dir, "notes");
  fs.mkdirSync(plain);
  managers = [];
});

afterEach(() => {
  for (const manager of managers) manager.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup = async ({ injectMcp = "matching-projects" } = {}) => {
  const stateDir = path.join(dir, "state");
  const config = parseConfig({ stateDir, injectMcp, projects: [widgets(8100)] });
  const servers = openStateStore(stateDir);
  const store = openLeaseStore(stateDir);
  const leases = createLeaseManager({ store, servers, idleStopMinutes: 30, leaseTtlMinutes: 240, stopIdle: async () => {}, onWarning: () => {} });
  managers.push(leases);
  const warnings: string[] = [];
  const live: HookRuntime = { leases, config, mcpUrl: MCP_URL };
  const hooks = createPaseoHooks({ runtime: async () => live, onWarning: (message) => warnings.push(message) });
  return { hooks, leases, store, servers, warnings };
};

const createRequest = (cwd: string, extra: Partial<PluginBeforeRequests["agent.create"]["config"]> = {}): PluginBeforeRequests["agent.create"] => ({
  config: { provider: "claude", cwd, title: "Fix the widget", ...extra },
  env: { WIDGETS_MODE: "test" },
});

const sessionOpen = (agentId: string, cwd: string, reason: "create" | "resume" = "create"): PluginBeforeRequests["agent.session_open"] => ({
  agentId,
  workspaceId: "wks_1",
  provider: "claude",
  cwd,
  reason,
  purpose: "interactive",
  env: {},
});

const hookAgent = (id: string, cwd: string): PluginHookAgent => ({
  id,
  workspaceId: "wks_1",
  parentAgentId: null,
  provider: "claude",
  cwd,
  title: `Agent ${id}`,
});

test("agent.create gives a project agent the MCP with its own key, loaded up front and preapproved, on a provider that can carry a tool policy", async () => {
  const { hooks, store } = await setup();
  const request = createRequest(path.join(worktree, "src"), {
    provider: "codex",
    mcpServers: { notes: { type: "stdio", command: "notes-mcp" }, "dev-servers": { type: "http", url: "http://127.0.0.1:1/mcp" } },
    toolPolicy: {
      preapproved: [
        { kind: "mcp", server: "notes", tool: "read" },
        { kind: "mcp", server: "dev-servers", tool: "dev_server_retired" },
      ],
    },
  });
  const result = await hooks.beforeAgentCreate({ request });
  assert.ok(result);
  assert.deepEqual(result.env, request.env);
  assert.deepEqual({ ...result.config, mcpServers: undefined, toolPolicy: undefined }, { ...request.config, mcpServers: undefined, toolPolicy: undefined });
  const injected = result.config.mcpServers?.["dev-servers"];
  assert.ok(injected?.type === "http");
  const key = injected.headers?.["x-dev-servers-key"] ?? "";
  assert.match(key, KEY_PATTERN);
  assert.deepEqual(injected, {
    type: "http",
    url: MCP_URL,
    headers: { "x-dev-servers-key": key, "x-dev-servers-cwd": encodeURIComponent(path.join(worktree, "src")) },
    alwaysLoad: true,
  });
  assert.deepEqual(result.config.mcpServers?.notes, { type: "stdio", command: "notes-mcp" });
  assert.deepEqual(result.config.toolPolicy?.preapproved, [
    { kind: "mcp", server: "notes", tool: "read" },
    ...MCP_TOOL_NAMES.map((tool) => ({ kind: "mcp", server: "dev-servers", tool })),
  ]);
  assert.deepEqual(store.snapshot().keys[key].cwd, path.join(worktree, "src"));
  assert.equal(store.snapshot().keys[key].title, "Fix the widget");

  const again = (await hooks.beforeAgentCreate({ request: createRequest(worktree) }))?.config.mcpServers?.["dev-servers"];
  const otherKey = again?.type === "http" ? again.headers?.["x-dev-servers-key"] : undefined;
  assert.match(otherKey ?? "", KEY_PATTERN);
  assert.notEqual(otherKey, key);
});

test("agent.create mounts the MCP without a tool policy on a provider Paseo cannot preapprove, dropping a stale one", async () => {
  const { hooks, store } = await setup();
  const request = createRequest(path.join(worktree, "src"), {
    provider: "omp/openrouter-deepseek/@preset/dev-deepseek-v4-1-flash-1017",
    toolPolicy: { preapproved: [{ kind: "mcp", server: "dev-servers", tool: "dev_servers" }] },
  });
  const result = await hooks.beforeAgentCreate({ request });
  assert.ok(result);
  const injected = result.config.mcpServers?.["dev-servers"];
  assert.ok(injected?.type === "http");
  assert.equal(injected.alwaysLoad, true);
  assert.equal("toolPolicy" in result.config ? result.config.toolPolicy : undefined, undefined);
  assert.match(injected.headers?.["x-dev-servers-key"] ?? "", KEY_PATTERN);
  assert.ok(store.snapshot().keys[injected.headers?.["x-dev-servers-key"] ?? ""]);
});

test("agent.create leaves the config alone for internal agents, other directories, injection off, or no runtime", async () => {
  const { hooks, store } = await setup();
  assert.equal(await hooks.beforeAgentCreate({ request: createRequest(worktree, { internal: true }) }), undefined);
  assert.equal(await hooks.beforeAgentCreate({ request: createRequest(plain) }), undefined);
  assert.equal(await hooks.beforeAgentCreate({ request: createRequest(path.join(dir, "missing")) }), undefined);

  const off = await setup({ injectMcp: "off" });
  assert.equal(await off.hooks.beforeAgentCreate({ request: createRequest(worktree) }), undefined);
  const all = await setup({ injectMcp: "all" });
  assert.ok((await all.hooks.beforeAgentCreate({ request: createRequest(plain) }))?.config.mcpServers?.["dev-servers"]);

  const down = createPaseoHooks({ runtime: async () => null });
  assert.equal(await down.beforeAgentCreate({ request: createRequest(worktree) }), undefined);
  const stuck = createPaseoHooks({ runtime: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(await stuck.beforeAgentCreate({ request: createRequest(worktree) }), undefined);
  assert.deepEqual(Object.keys(store.snapshot().keys), []);
});

test("session_open binds a new agent to its key, agent.created is the fallback, and archiving releases only that agent's leases", async () => {
  const { hooks, leases, servers } = await setup();
  const keyOf = async () => {
    const result = await hooks.beforeAgentCreate({ request: createRequest(worktree) });
    const server = result?.config.mcpServers?.["dev-servers"];
    return server?.type === "http" ? (server.headers?.["x-dev-servers-key"] ?? "") : "";
  };
  const alice = await keyOf();
  const bruno = await keyOf();

  assert.equal(await hooks.beforeSessionOpen({ request: sessionOpen("agent-old", worktree, "resume") }), undefined);
  await hooks.agentCreated({ agent: hookAgent("agent-alice", worktree) });
  assert.equal(await hooks.beforeSessionOpen({ request: sessionOpen("agent-bruno", worktree) }), undefined);
  await hooks.agentCreated({ agent: hookAgent("agent-bruno", worktree) });

  await servers.update((draft) => {
    draft.servers.wt_a = {
      id: "wt_a",
      project: "widgets",
      worktree,
      port: 8100,
      reserved: [8100],
      state: "ready",
      stateSince: new Date().toISOString(),
      process: { pid: 4242, pgid: 4242, startedAt: "Mon Mar  2 09:00:00 2026" },
      pinned: false,
      optIns: { services: [], dedicatedDb: false, reason: null },
      lastUsedAt: new Date().toISOString(),
      deadlines: {},
      logs: { run: "/dev/null" },
    };
  });
  await leases.book.take("wt_a", { kind: "agent", id: alice });
  await leases.book.take("wt_a", { kind: "agent", id: bruno });
  assert.deepEqual(
    leases.book.holders("wt_a").map(({ holder }) => holder.title),
    ["Agent agent-alice", "Agent agent-bruno"],
  );

  await hooks.agentArchived({ agent: hookAgent("agent-old", worktree), archivedAt: new Date().toISOString() });
  await hooks.agentArchived({ agent: hookAgent("agent-alice", worktree), archivedAt: new Date().toISOString() });
  assert.deepEqual(
    leases.book.holders("wt_a").map(({ holder }) => holder.id),
    [bruno],
  );
});

test("a failing hook logs and lets the operation go on", async () => {
  const warnings: string[] = [];
  const config = parseConfig({ injectMcp: "all", projects: [] });
  const broken = { issueKey: async () => Promise.reject(new Error("disk full")) } as unknown as LeaseManager;
  const hooks = createPaseoHooks({ runtime: async () => ({ leases: broken, config, mcpUrl: MCP_URL }), onWarning: (message) => warnings.push(message) });
  assert.equal(await hooks.beforeAgentCreate({ request: createRequest(worktree) }), undefined);
  const crashed = createPaseoHooks({ runtime: () => Promise.reject(new Error("config unreadable")), onWarning: (message) => warnings.push(message) });
  assert.equal(await crashed.agentArchived({ agent: hookAgent("agent-1", worktree), archivedAt: new Date().toISOString() }), undefined);
  assert.equal(await crashed.beforeSessionOpen({ request: sessionOpen("agent-1", worktree) }), undefined);
  assert.deepEqual(warnings, ["agent.create: disk full", "agent.archived: config unreadable", "agent.session_open: config unreadable"]);
});

const hookWorkspace = (cwd: string, archivedAt: string | null = null): PluginHookWorkspace => ({
  id: "wks_widgets",
  projectId: "prj_widgets",
  cwd,
  name: "widgets-alice",
  archivedAt,
});

test("workspace.created queues a prebuild of its directory and workspace.archived cleans it up, and a failure only logs", async () => {
  const { leases, warnings } = await setup();
  const config = parseConfig({ projects: [widgets(8100)] });
  const calls: string[] = [];
  const workspaces: WorkspaceHandlers = {
    created: async (cwd) => {
      calls.push(`created ${cwd}`);
      return { queued: true, worktree: cwd, why: "queued behind 0 other prebuild(s)" };
    },
    archived: async (cwd) => {
      calls.push(`archived ${cwd}`);
      if (cwd === plain) throw new Error("state file locked");
      return { worktree: cwd, id: "wt_a", stopped: true, holders: [], droppedLeases: [], portReleased: true, forgotten: true };
    },
  };
  const hooks = createPaseoHooks({ runtime: async () => ({ leases, config, mcpUrl: null, workspaces }), onWarning: (message) => warnings.push(message) });
  await hooks.workspaceCreated({ workspace: hookWorkspace(worktree) });
  await hooks.workspaceArchived({ workspace: hookWorkspace(worktree, new Date().toISOString()) });
  await hooks.workspaceArchived({ workspace: hookWorkspace(plain, new Date().toISOString()) });
  assert.deepEqual(calls, [`created ${worktree}`, `archived ${worktree}`, `archived ${plain}`]);
  assert.deepEqual(warnings, ["workspace.archived: state file locked"]);
  assert.equal(await hooks.beforeAgentCreate({ request: createRequest(worktree) }), undefined);

  const down = createPaseoHooks({ runtime: async () => null });
  assert.equal(await down.workspaceCreated({ workspace: hookWorkspace(worktree) }), undefined);
});

test("the hooks register on the six Paseo names and unregister together", () => {
  const registered: string[] = [];
  const removed: string[] = [];
  const track = (kind: string) => (name: string) => {
    registered.push(`${kind} ${name}`);
    return () => void removed.push(`${kind} ${name}`);
  };
  const fake = { on: track("on"), before: track("before") } as unknown as PluginLifecycleRegistration;
  const unregister = registerPaseoHooks(fake, createPaseoHooks({ runtime: async () => null }));
  assert.deepEqual(registered, [
    "before agent.create",
    "before agent.session_open",
    "on agent.created",
    "on agent.archived",
    "on workspace.created",
    "on workspace.archived",
  ]);
  unregister();
  assert.deepEqual(removed, registered);
});
