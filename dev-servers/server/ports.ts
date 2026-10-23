import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { renderTemplate, type PortsConfig } from "./config.ts";
import { createJsonStore, type JsonStore } from "./store.ts";

export type PortHolder = "free" | "ours" | "foreign";
export type PortProbe = (port: number) => Promise<PortHolder>;

export class PortUnavailableError extends Error {
  readonly code = "port_unavailable";
  readonly reasons: string[];
  constructor(message: string, reasons: string[]) {
    super(message);
    this.reasons = reasons;
  }
}

const REGISTRY_VERSION = 1;

const entrySchema = z.object({
  project: z.string(),
  base: z.number().int(),
  reserved: z.array(z.number().int()),
  assignedAt: z.iso.datetime({ offset: true }),
});

const registrySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  worktrees: z.record(z.string(), entrySchema).default({}),
});

export type PortEntry = z.output<typeof entrySchema>;
type Registry = z.output<typeof registrySchema>;

export type PortAssignment = {
  base: number;
  reserved: number[];
  reassigned: { from: number; because: string[] } | null;
};

export const reservedPorts = (base: number, ports: PortsConfig) => [
  ...new Set(ports.reserve.map((template) => Number(renderTemplate(template, { port: base })))),
];

function* candidates({ range: [first, last], step }: PortsConfig) {
  for (let base = first; base <= last; base += step) yield base;
}

const takenBy = (registry: Registry, except: string) => {
  const taken = new Map<number, string>();
  for (const [worktree, entry] of Object.entries(registry.worktrees)) {
    if (worktree !== except) for (const port of entry.reserved) taken.set(port, worktree);
  }
  return taken;
};

const configConflicts = (base: number, ports: PortsConfig, taken: Map<number, string>) => {
  const [first, last] = ports.range;
  const reasons: string[] = [];
  if (base < first || base > last || (base - first) % ports.step !== 0) reasons.push(`port ${base} is outside the range ${first}-${last} (step ${ports.step})`);
  for (const port of reservedPorts(base, ports)) {
    if (port > 65535) reasons.push(`port ${port} is above 65535`);
    else if (ports.exclude.includes(port)) reasons.push(`port ${port} is excluded by the config`);
    else if (taken.has(port)) reasons.push(`port ${port} belongs to ${taken.get(port)}`);
  }
  return reasons;
};

const busyPorts = async (base: number, ports: PortsConfig, probe: PortProbe) => {
  const reserved = reservedPorts(base, ports);
  const holders = await Promise.all(reserved.map(probe));
  return reserved.map((port, index) => ({ port, holder: holders[index] })).filter(({ holder }) => holder !== "free");
};

export type PortRegistry = {
  get(worktree: string): PortEntry | undefined;
  load(): Promise<void>;
  ensure(input: { worktree: string; project: string; ports: PortsConfig; probe: PortProbe }): Promise<PortAssignment>;
  release(worktree: string): Promise<void>;
  sweep(isGone?: (worktree: string) => boolean): Promise<string[]>;
};

export function openPortRegistry(stateDir: string, onWarning?: (message: string) => void): PortRegistry {
  const store: JsonStore<Registry> = createJsonStore<Registry>({
    file: path.join(stateDir, "ports.json"),
    schema: registrySchema,
    empty: () => ({ version: REGISTRY_VERSION, worktrees: {} }),
    onWarning,
  });

  return {
    get: (worktree) => store.snapshot().worktrees[path.resolve(worktree)],
    load: async () => void (await store.load()),

    ensure: ({ worktree, project, ports, probe }) =>
      store.update(async (registry) => {
        const key = path.resolve(worktree);
        const taken = takenBy(registry, key);
        const current = registry.worktrees[key];
        let because: string[] = [];
        if (current) {
          because =
            current.project === project ? configConflicts(current.base, ports, taken) : [`the worktree moved from project ${current.project} to ${project}`];
          if (!because.length) {
            because = (await busyPorts(current.base, ports, probe))
              .filter(({ holder }) => holder === "foreign")
              .map(({ port }) => `port ${port} is held by another process`);
          }
          if (!because.length) {
            current.reserved = reservedPorts(current.base, ports);
            return { base: current.base, reserved: current.reserved, reassigned: null };
          }
        }
        for (const base of candidates(ports)) {
          if (base === current?.base || configConflicts(base, ports, taken).length) continue;
          if ((await busyPorts(base, ports, probe)).length) continue;
          const reserved = reservedPorts(base, ports);
          registry.worktrees[key] = { project, base, reserved, assignedAt: new Date().toISOString() };
          return { base, reserved, reassigned: current ? { from: current.base, because } : null };
        }
        const [first, last] = ports.range;
        throw new PortUnavailableError(`no free port set in ${first}-${last} (step ${ports.step}, reserving ${ports.reserve.join(" ")}) for ${key}`, because);
      }),

    release: (worktree) =>
      store.update((registry) => {
        delete registry.worktrees[path.resolve(worktree)];
      }),

    sweep: (isGone = (worktree) => !fs.existsSync(worktree)) =>
      store.update((registry) => {
        const gone = Object.keys(registry.worktrees).filter(isGone);
        for (const worktree of gone) delete registry.worktrees[worktree];
        return gone;
      }),
  };
}

const accepts = (port: number, host: string, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

// A port counts as held when anything accepts a connection on it over IPv4 or IPv6 loopback.
export const listenerProbe =
  ({ isOurs = () => false, timeoutMs = 500 }: { isOurs?: (port: number) => boolean; timeoutMs?: number } = {}): PortProbe =>
  async (port) => {
    if (isOurs(port)) return "ours";
    const listening = await Promise.all(["127.0.0.1", "::1"].map((host) => accepts(port, host, timeoutMs)));
    return listening.some(Boolean) ? "foreign" : "free";
  };
