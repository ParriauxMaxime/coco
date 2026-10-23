import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig, resolveApi, type ConfigLoad } from "./server/config.ts";
import { createHttpApi, type HttpApi } from "./server/http.ts";
import { openPortRegistry, type PortRegistry } from "./server/ports.ts";
import { createService, type DevServersService } from "./server/service.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./server/store.ts";
import { createSupervisor, type Supervisor } from "./server/supervisor.ts";
import { configStatusRpc, pluginSettings } from "./shared/contracts.ts";

type Runtime = {
  load: ConfigLoad;
  apiPort: number | null;
  stores: { state: JsonStore<DevServersState>; ports: PortRegistry } | null;
  supervisor: Supervisor | null;
  service: DevServersService | null;
  http: HttpApi | null;
  error: string | null;
};

const warn = (message: string) => console.warn(`coco-dev-servers: ${message}`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(pluginSettings);

  const start = async (): Promise<Runtime> => {
    const current = await settings.read();
    const values = current.status === "ready" ? current.values : pluginSettings.schema.parse({});
    if (current.status === "invalid") warn(`invalid plugin settings, using defaults: ${current.error}`);
    const load = await loadConfig(values.configPath);
    const down = { load, apiPort: values.apiPort, stores: null, supervisor: null, service: null, http: null };
    if (!load.config) return { ...down, error: load.error };
    const { stateDir, projects } = load.config;
    const stores = { state: openStateStore(stateDir, warn), ports: openPortRegistry(stateDir, warn) };
    let supervisor: Supervisor;
    try {
      await stores.state.load();
      await stores.ports.load();
      const released = await stores.ports.sweep();
      if (released.length) console.log(`coco-dev-servers: released the ports of removed worktrees ${released.join(", ")}`);
      supervisor = createSupervisor({ store: stores.state, stateDir, project: (id) => projects.find((project) => project.id === id), onWarning: warn });
      for (const { id, outcome, detail } of await supervisor.adopt()) console.log(`coco-dev-servers: ${id} ${outcome}${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      return { ...down, error: messageOf(error) };
    }
    const service = createService({ config: load.config, store: stores.state, ports: stores.ports, supervisor });
    const api = resolveApi(load.config.api, values.apiPort);
    const http = createHttpApi({ service, ...api });
    try {
      await http.listen();
      return { load, apiPort: values.apiPort, stores, supervisor, service, http, error: null };
    } catch (error) {
      const message = `HTTP API on ${api.bind}:${api.port} is down: ${messageOf(error)}`;
      warn(message);
      return { load, apiPort: values.apiPort, stores, supervisor, service, http: null, error: message };
    }
  };

  let runtime = start();
  const closeRuntime = (current: Promise<Runtime>) =>
    current.then(
      async ({ http, supervisor }) => {
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
    unsubscribe();
    await closeRuntime(runtime);
  };
}
