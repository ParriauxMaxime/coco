import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig, resolveApi, type ConfigLoad } from "./server/config.ts";
import { createHttpApi, type HttpApi } from "./server/http.ts";
import { createLeaseManager, openLeaseStore, type LeaseManager } from "./server/leases.ts";
import { MCP_PATH, createMcpHandler } from "./server/mcp.ts";
import { createPaseoHooks, registerPaseoHooks, type HookRuntime } from "./server/paseo-hooks.ts";
import { openPortRegistry, type PortRegistry } from "./server/ports.ts";
import { createService, type DevServersService } from "./server/service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./server/store.ts";
import { createSupervisor, type Supervisor } from "./server/supervisor.ts";
import { configStatusRpc, pluginSettings, type Holder } from "./shared/contracts.ts";

type Runtime = {
  load: ConfigLoad;
  apiPort: number | null;
  stores: { state: JsonStore<DevServersState>; ports: PortRegistry } | null;
  supervisor: Supervisor | null;
  leases: LeaseManager | null;
  service: DevServersService | null;
  http: HttpApi | null;
  mcpUrl: string | null;
  error: string | null;
  close: () => void;
};

const IDLE_TIMER: Holder = { kind: "user", id: "idle-timer" };

const warn = (message: string) => console.warn(`coco-dev-servers: ${message}`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const urlHost = (bind: string) => (bind.includes(":") ? `[${bind}]` : bind);

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(pluginSettings);

  const start = async (): Promise<Runtime> => {
    const current = await settings.read();
    const values = current.status === "ready" ? current.values : pluginSettings.schema.parse({});
    if (current.status === "invalid") warn(`invalid plugin settings, using defaults: ${current.error}`);
    const load = await loadConfig(values.configPath);
    const down = { load, apiPort: values.apiPort, stores: null, supervisor: null, leases: null, service: null, http: null, mcpUrl: null, close: () => {} };
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
    const leases = createLeaseManager({
      store: leaseStore,
      servers: stores.state,
      idleStopMinutes: config.idleStopMinutes,
      leaseTtlMinutes: config.leaseTtlMinutes,
      stopIdle: async (id) => {
        const result = await service?.stop(id, {}, { holder: IDLE_TIMER });
        if (result?.stopped) console.log(`coco-dev-servers: ${id} stopped after ${config.idleStopMinutes} min with nobody holding it`);
      },
      onWarning: warn,
    });
    service = createService({ config, store: stores.state, ports: stores.ports, supervisor, leases: leases.book });
    const unsubscribe = supervisor.subscribe(
      (record) => void leases.settle(record.id).catch((error) => warn(`lease check of ${record.id} failed: ${messageOf(error)}`)),
    );
    const close = () => {
      unsubscribe();
      leases.close();
    };
    await leases.settleAll().catch((error) => warn(`lease check failed: ${messageOf(error)}`));
    const api = resolveApi(config.api, values.apiPort);
    const http = createHttpApi({ service, ...api, mounts: { [MCP_PATH]: createMcpHandler({ service, leases }) } });
    const up = { load, apiPort: values.apiPort, stores, supervisor, leases, service, close };
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
      const { leases, load, mcpUrl } = await runtime;
      return leases && load.config && mcpUrl ? { leases, config: load.config, mcpUrl } : null;
    },
    onWarning: warn,
  });
  const unregister = registerPaseoHooks(server, hooks);

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
    unsubscribe();
    await closeRuntime(runtime);
  };
}
