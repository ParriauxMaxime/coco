import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadConfig, resolveApi, type ConfigLoad } from "./server/config.ts";
import { openPortRegistry, type PortRegistry } from "./server/ports.ts";
import { openStateStore, type DevServersState, type JsonStore } from "./server/store.ts";
import { createSupervisor, type Supervisor } from "./server/supervisor.ts";
import { configStatusRpc, pluginSettings } from "./shared/contracts.ts";

type Runtime = {
  load: ConfigLoad;
  apiPort: number | null;
  stores: { state: JsonStore<DevServersState>; ports: PortRegistry } | null;
  supervisor: Supervisor | null;
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
    if (!load.config) return { load, apiPort: values.apiPort, stores: null, supervisor: null, error: load.error };
    const { stateDir, projects } = load.config;
    const stores = { state: openStateStore(stateDir, warn), ports: openPortRegistry(stateDir, warn) };
    try {
      await stores.state.load();
      await stores.ports.load();
      const released = await stores.ports.sweep();
      if (released.length) console.log(`coco-dev-servers: released the ports of removed worktrees ${released.join(", ")}`);
      const supervisor = createSupervisor({ store: stores.state, stateDir, project: (id) => projects.find((project) => project.id === id), onWarning: warn });
      for (const { id, outcome, detail } of await supervisor.adopt()) console.log(`coco-dev-servers: ${id} ${outcome}${detail ? ` (${detail})` : ""}`);
      return { load, apiPort: values.apiPort, stores, supervisor, error: null };
    } catch (error) {
      return { load, apiPort: values.apiPort, stores: null, supervisor: null, error: messageOf(error) };
    }
  };

  let runtime = start();
  const closeSupervisor = (current: Promise<Runtime>) =>
    current.then(
      ({ supervisor }) => supervisor?.close(),
      () => undefined,
    );
  const reload = () => {
    const previous = runtime;
    runtime = closeSupervisor(previous).then(start);
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
    await closeSupervisor(runtime);
  };
}
