import type { PluginRpcContract, RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { ZodType } from "zod";
import { createPresenter } from "./server/board.ts";
import { loadConfig, resolveApi, type ConfigLoad } from "./server/config.ts";
import { createExternalScanner } from "./server/external.ts";
import { createHttpApi, type HttpApi } from "./server/http.ts";
import { createLeaseManager, openLeaseStore, type LeaseManager } from "./server/leases.ts";
import { MCP_PATH, createMcpHandler } from "./server/mcp.ts";
import { createPaseoHooks, registerPaseoHooks, type HookRuntime, type WorkspaceHandlers } from "./server/paseo-hooks.ts";
import { openPortRegistry, type PortRegistry } from "./server/ports.ts";
import { createPrebuildQueue } from "./server/prebuild.ts";
import { createRpcHandlers, type RpcRuntime } from "./server/rpc.ts";
import { createScheduler } from "./server/scheduler.ts";
import { createService, serverUrl, type DevServersService } from "./server/service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./server/store.ts";
import { createSupervisor, type Supervisor } from "./server/supervisor.ts";
import { createTimelineNotifier, type AppendRow } from "./server/timeline.ts";
import { boardRpc, configStatusRpc, loginRpc, logsRpc, pinRpc, placementRpc, pluginSettings, startRpc, stopRpc, type Holder } from "./shared/contracts.ts";

type Runtime = {
  load: ConfigLoad;
  apiPort: number | null;
  stores: { state: JsonStore<DevServersState>; ports: PortRegistry } | null;
  supervisor: Supervisor | null;
  leases: LeaseManager | null;
  service: DevServersService | null;
  http: HttpApi | null;
  mcpUrl: string | null;
  workspaces: WorkspaceHandlers | null;
  error: string | null;
  close: () => void;
};

const IDLE_TIMER: Holder = { kind: "user", id: "idle-timer" };

const warn = (message: string) => console.warn(`coco-dev-servers: ${message}`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const urlHost = (bind: string) => (bind.includes(":") ? `[${bind}]` : bind);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(pluginSettings);
  // Daemon-side code gets Paseo only through a handler or hook context; the session lives as long as this worker.
  let paseo: PluginHandlerContext["paseo"] | null = null;
  const remember = (context: PluginHandlerContext) => void (paseo = context.paseo);
  const appendRow = (): AppendRow | null => {
    const api = paseo;
    return api && ((agentId, item) => api.agents.ref(agentId).timeline.append(item));
  };

  const start = async (): Promise<Runtime> => {
    const current = await settings.read();
    const values = current.status === "ready" ? current.values : pluginSettings.schema.parse({});
    if (current.status === "invalid") warn(`invalid plugin settings, using defaults: ${current.error}`);
    const load = await loadConfig(values.configPath);
    const down = {
      load,
      apiPort: values.apiPort,
      stores: null,
      supervisor: null,
      leases: null,
      service: null,
      http: null,
      mcpUrl: null,
      workspaces: null,
      close: () => {},
    };
    if (!load.config) return { ...down, error: load.error };
    const config = load.config;
    const { stateDir, projects } = config;
    const stores = { state: openStateStore(stateDir, warn), ports: openPortRegistry(stateDir, warn) };
    const leaseStore = openLeaseStore(stateDir, warn);
    let supervisor: Supervisor;
    try {
      await stores.state.load();
      await stores.ports.load();
      await leaseStore.load();
      const released = await stores.ports.sweep();
      if (released.length) console.log(`coco-dev-servers: released the ports of removed worktrees ${released.join(", ")}`);
      supervisor = createSupervisor({ store: stores.state, stateDir, project: (id) => projects.find((project) => project.id === id), onWarning: warn });
      for (const { id, outcome, detail } of await supervisor.adopt()) console.log(`coco-dev-servers: ${id} ${outcome}${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      return { ...down, error: messageOf(error) };
    }
    let service: DevServersService | null = null;
    const timeline = createTimelineNotifier({
      holders: (id) => leases.book.holders(id),
      agentOf: (holder) => leases.agentOf(holder),
      urlOf: (record) => serverUrl(config, record),
      append: appendRow,
      onWarning: warn,
    });
    const leases = createLeaseManager({
      store: leaseStore,
      servers: stores.state,
      idleStopMinutes: config.idleStopMinutes,
      leaseTtlMinutes: config.leaseTtlMinutes,
      stopIdle: async (id) => {
        const result = await service?.stop(id, {}, { holder: IDLE_TIMER });
        if (result?.stopped) console.log(`coco-dev-servers: ${id} stopped after ${config.idleStopMinutes} min with nobody holding it`);
      },
      onLost: timeline.lost,
      onWarning: warn,
    });
    const externals = createExternalScanner({ store: stores.state, projects, leases: leases.book, onWarning: warn });
    const capacity = createScheduler({ store: stores.state, cap: config.cap, stop: (id) => supervisor.stop(id), leases: leases.book, onWarning: warn });
    const prebuilds = createPrebuildQueue({
      store: stores.state,
      projects,
      service: { prewarm: (target, options) => service!.prewarm(target, options), finishPrewarm: (id) => service!.finishPrewarm(id) },
      subscribe: supervisor.subscribe,
      onWarning: warn,
    });
    service = createService({
      config,
      store: stores.state,
      ports: stores.ports,
      supervisor,
      leases: leases.book,
      capacity,
      externals,
      prebuilds,
      onWarning: warn,
    });
    const workspaces: WorkspaceHandlers = { created: (cwd) => prebuilds.enqueue(cwd), archived: (cwd) => service!.archive(cwd) };
    const unsubscribe = supervisor.subscribe((record) => {
      timeline.serverChanged(record);
      void leases.settle(record.id).catch((error) => warn(`lease check of ${record.id} failed: ${messageOf(error)}`));
    });
    const close = () => {
      unsubscribe();
      prebuilds.close();
      externals.close();
      leases.close();
    };
    await leases.settleAll().catch((error) => warn(`lease check failed: ${messageOf(error)}`));
    externals.start();
    prebuilds.start();
    const api = resolveApi(config.api, values.apiPort);
    const present = createPresenter({ leases, store: stores.state, config });
    const http = createHttpApi({ service, present, ...api, mounts: { [MCP_PATH]: createMcpHandler({ service, leases, present }) } });
    const up = { load, apiPort: values.apiPort, stores, supervisor, leases, service, workspaces, close };
    try {
      const { bind, port } = await http.listen();
      return { ...up, http, mcpUrl: `http://${urlHost(bind)}:${port}${MCP_PATH}`, error: null };
    } catch (error) {
      const message = `HTTP API on ${api.bind}:${api.port} is down: ${messageOf(error)}`;
      warn(message);
      return { ...up, http: null, mcpUrl: null, error: message };
    }
  };

  let runtime = start();
  const closeRuntime = (current: Promise<Runtime>) =>
    current.then(
      async ({ http, supervisor, close }) => {
        close();
        await http?.close();
        supervisor?.close();
      },
      () => undefined,
    );
  const reload = () => {
    const previous = runtime;
    runtime = closeRuntime(previous).then(start);
  };
  runtime.catch((error) => warn(`start failed: ${messageOf(error)}`));
  const unsubscribe = settings.subscribe(reload);

  const hooks = createPaseoHooks({
    runtime: async (): Promise<HookRuntime | null> => {
      const { leases, load, mcpUrl, workspaces } = await runtime;
      return leases && load.config ? { leases, config: load.config, mcpUrl, ...(workspaces && { workspaces }) } : null;
    },
    onWarning: warn,
  });
  const unregister = registerPaseoHooks(server, hooks);
  const unwatch = [server.on("agent.created", (_, context) => remember(context)), server.on("agent.turn_started", (_, context) => remember(context))];

  const rpc = createRpcHandlers(async (): Promise<RpcRuntime> => {
    const { service, leases, stores, load, error } = await runtime;
    return service && leases && stores && load.config
      ? { deps: { service, leases, store: stores.state, config: load.config }, error: null }
      : { deps: null, error };
  });
  const handle = <I extends ZodType, O extends ZodType>(
    contract: PluginRpcContract<I, O>,
    run: (input: RpcInput<PluginRpcContract<I, O>>) => Promise<RpcOutput<PluginRpcContract<I, O>>>,
  ) =>
    server.handle(contract, (input, context) => {
      remember(context);
      return run(input);
    });
  handle(boardRpc, rpc.board);
  handle(placementRpc, rpc.placement);
  handle(startRpc, rpc.start);
  handle(stopRpc, rpc.stop);
  handle(pinRpc, rpc.pin);
  handle(logsRpc, rpc.logs);
  handle(loginRpc, rpc.login);

  server.handle(configStatusRpc, async (): Promise<RpcOutput<typeof configStatusRpc>> => {
    const { load, apiPort, error } = await runtime;
    return {
      configPath: load.file,
      found: load.found,
      error,
      projects: load.config?.projects.map(({ id }) => id) ?? [],
      stateDir: load.config?.stateDir ?? null,
      api: load.config ? resolveApi(load.config.api, apiPort) : null,
    };
  });

  // Servers outlive the worker on purpose: cleanup never stops them.
  return async () => {
    unregister();
    for (const off of unwatch) off();
    unsubscribe();
    await closeRuntime(runtime);
  };
}
