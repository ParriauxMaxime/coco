import type { PluginBeforeRequests, PluginLifecycleEvents, PluginLifecycleRegistration } from "@getpaseo/plugin/server";
import type { DevServersConfig } from "./config.ts";
import type { LeaseManager } from "./leases.ts";
import { CWD_HEADER, KEY_HEADER, MCP_SERVER_NAME, MCP_TOOL_NAMES } from "./mcp.ts";
import { resolveTarget } from "./placement.ts";
import type { EnqueueResult } from "./prebuild.ts";
import type { ArchiveResult } from "./service.ts";

type CreateRequest = PluginBeforeRequests["agent.create"];
type SessionConfig = CreateRequest["config"];

export type WorkspaceHandlers = { created(cwd: string): Promise<EnqueueResult>; archived(cwd: string): Promise<ArchiveResult> };

export type HookRuntime = { leases: LeaseManager; config: DevServersConfig; mcpUrl: string | null; workspaces?: WorkspaceHandlers };

export type HookOptions = {
  runtime: () => Promise<HookRuntime | null>;
  onWarning?: (message: string) => void;
  timeoutMs?: number;
};

const TIMED_OUT = Symbol("timed out");

const within = <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// Paseo only accepts exact MCP preapproval from the providers whose contract has it; the others (Oh My Pi) refuse the agent outright
const PREAPPROVES = /^(claude[\w-]*|codex|opencode)(\/|$)/;

export function withDevServersMcp(config: SessionConfig, { url, key }: { url: string; key: string }): SessionConfig {
  const mcpServers = {
    ...config.mcpServers,
    [MCP_SERVER_NAME]: { type: "http" as const, url, headers: { [KEY_HEADER]: key, [CWD_HEADER]: encodeURIComponent(config.cwd) }, alwaysLoad: true },
  };
  // such a provider cannot carry any toolPolicy: they run these tools under their own approval mode
  if (!PREAPPROVES.test(String(config.provider ?? ""))) {
    const { toolPolicy: _policy, ...rest } = config;
    return { ...rest, mcpServers };
  }
  const preapproved = (config.toolPolicy?.preapproved ?? []).filter((ref) => ref.server !== MCP_SERVER_NAME);
  return {
    ...config,
    mcpServers,
    toolPolicy: {
      ...config.toolPolicy,
      preapproved: [...preapproved, ...MCP_TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER_NAME, tool }))],
    },
  };
}

// Hooks never throw: a failing before hook would fail the agent's creation.
export function createPaseoHooks({ runtime, onWarning = console.warn, timeoutMs = 10_000 }: HookOptions) {
  const current = async () => {
    const value = await within(runtime(), timeoutMs);
    return value === TIMED_OUT ? null : value;
  };
  const guarded =
    <A extends unknown[], R>(name: string, run: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R | undefined> => {
      try {
        return await run(...args);
      } catch (error) {
        onWarning(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

  const matches = async (cwd: string, config: DevServersConfig) => {
    if (config.injectMcp === "off") return false;
    if (config.injectMcp === "all") return true;
    const target = await within(
      resolveTarget(cwd, config.projects).catch(() => null),
      timeoutMs,
    );
    return target !== null && target !== TIMED_OUT;
  };

  return {
    beforeAgentCreate: guarded("agent.create", async ({ request }: { request: CreateRequest }): Promise<CreateRequest | undefined> => {
      const { config } = request;
      if (config.internal) return undefined;
      const live = await current();
      if (!live?.mcpUrl || !(await matches(config.cwd, live.config))) return undefined;
      const key = await live.leases.issueKey(config.cwd, config.title);
      return { ...request, config: withDevServersMcp(config, { url: live.mcpUrl, key }) };
    }),

    beforeSessionOpen: guarded("agent.session_open", async ({ request }: { request: PluginBeforeRequests["agent.session_open"] }): Promise<undefined> => {
      if (request.reason !== "create") return undefined;
      await (await current())?.leases.bindAgent({ agentId: request.agentId, cwd: request.cwd });
      return undefined;
    }),

    agentCreated: guarded("agent.created", async ({ agent }: PluginLifecycleEvents["agent.created"]) => {
      await (await current())?.leases.bindAgent({ agentId: agent.id, cwd: agent.cwd, title: agent.title });
    }),

    agentArchived: guarded("agent.archived", async ({ agent }: PluginLifecycleEvents["agent.archived"]) => {
      const released = (await (await current())?.leases.releaseAgent(agent.id)) ?? [];
      if (released.length) console.log(`coco-dev-servers: agent ${agent.id} archived, released its lease on ${released.join(", ")}`);
    }),

    workspaceCreated: guarded("workspace.created", async ({ workspace }: PluginLifecycleEvents["workspace.created"]) => {
      const result = await (await current())?.workspaces?.created(workspace.cwd);
      if (result?.queued) console.log(`coco-dev-servers: workspace ${workspace.id} created, prebuild of ${result.worktree} ${result.why}`);
    }),

    workspaceArchived: guarded("workspace.archived", async ({ workspace }: PluginLifecycleEvents["workspace.archived"]) => {
      const result = await (await current())?.workspaces?.archived(workspace.cwd);
      if (!result) return;
      const done = [
        result.stopped && "stopped its server",
        result.portReleased && "released its ports",
        result.droppedLeases.length && "dropped its agents' leases",
      ];
      const kept = result.kept && `kept its server running (${result.kept}${result.holders.length ? `: ${result.holders.join(", ")}` : ""})`;
      const summary = [...done, kept].filter(Boolean).join(", ");
      if (summary) console.log(`coco-dev-servers: workspace ${workspace.id} archived, ${summary}`);
    }),
  };
}

export function registerPaseoHooks(server: PluginLifecycleRegistration, hooks: ReturnType<typeof createPaseoHooks>) {
  const off = [
    server.before("agent.create", hooks.beforeAgentCreate),
    server.before("agent.session_open", hooks.beforeSessionOpen),
    server.on("agent.created", hooks.agentCreated),
    server.on("agent.archived", hooks.agentArchived),
    server.on("workspace.created", hooks.workspaceCreated),
    server.on("workspace.archived", hooks.workspaceArchived),
  ];
  return () => off.forEach((unsubscribe) => unsubscribe());
}
