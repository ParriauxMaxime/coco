import fs from "node:fs/promises";
import { z } from "zod";
import {
  logsInputSchema,
  pinInputSchema,
  placementInputSchema,
  startInputSchema,
  stopInputSchema,
  type Holder,
  type LeaseView,
  type LogsInput,
  type LogsResult,
  type PinInput,
  type PinResult,
  type PlacementInput,
  type PlacementResult,
  type ServerView,
  type StartInput,
  type StartResult,
  type StopInput,
  type StopResult,
} from "../shared/contracts.ts";
import { renderTemplate, type DevServersConfig } from "./config.ts";
import { ServiceError } from "./errors.ts";
import { cocoStackOrder } from "./coco.ts";
import { createGitCache } from "./git.ts";
import { createStackPlacement, resolveTarget, type Place, type Target } from "./placement.ts";
import { PortUnavailableError, listenerProbe, type PortProbe, type PortRegistry } from "./ports.ts";
import { errnoOf } from "./proc.ts";
import { plainLine } from "./readiness.ts";
import { serverIdFor, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";
import { StartFailedError, logDirFor, type OptIns, type Supervisor } from "./supervisor.ts";

export type Caller = { holder: Holder; cwd?: string };

export type LeaseBook = {
  take(serverId: string, holder: Holder): Promise<{ id: string } | null>;
  release(serverId: string, holder: Holder): Promise<void>;
  holders(serverId: string): LeaseView[];
  lose(serverId: string, why: string): Promise<void>;
  settle(serverId: string): Promise<void>;
};

export const noLeases: LeaseBook = { take: async () => null, release: async () => {}, holders: () => [], lose: async () => {}, settle: async () => {} };

export type Evicted = { id: string; worktree: string; why: string };

export type Capacity = {
  admit<T>(target: { id: string; worktree: string }, launch: () => Promise<T>, options?: { evict?: boolean }): Promise<{ evicted: Evicted[]; result: T }>;
};

export const unlimited: Capacity = { admit: async (_, launch) => ({ evicted: [], result: await launch() }) };

export type Externals = { scan(options?: { maxAgeMs?: number }): Promise<unknown> };

export type ServiceOptions = {
  config: DevServersConfig;
  store: JsonStore<DevServersState>;
  ports: PortRegistry;
  supervisor: Supervisor;
  place?: Place;
  leases?: LeaseBook;
  capacity?: Capacity;
  externals?: Externals;
  probe?: PortProbe;
  gitCacheMs?: number;
  logReadBytes?: number;
  onWarning?: (message: string) => void;
};

export type DevServersService = {
  start(input: StartInput, caller: Caller): Promise<StartResult>;
  placement(input: PlacementInput, caller: Caller): Promise<PlacementResult>;
  list(): Promise<ServerView[]>;
  get(id: string): Promise<ServerView>;
  stop(id: string, input: StopInput, caller: Caller): Promise<StopResult>;
  pin(id: string, input: PinInput, caller: Caller): Promise<PinResult>;
  logs(id: string, input: LogsInput): Promise<LogsResult>;
};

const BUILDING: ServerRecord["state"][] = ["building", "prewarming"];
const EXTERNAL_SCAN_MAX_AGE_MS = 5000;

const parse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new ServiceError("bad_request", z.prettifyError(result.error));
  return result.data;
};

const hasOptIns = (optIns: OptIns) => optIns.services.length > 0 || optIns.dedicatedDb;
const satisfies = (running: OptIns, wanted: OptIns) =>
  wanted.services.every((name) => running.services.includes(name)) && (!wanted.dedicatedDb || running.dedicatedDb);
const describeOptIns = ({ services, dedicatedDb }: OptIns) =>
  [services.length && `services ${services.join(", ")}`, dedicatedDb && "a dedicated database"].filter(Boolean).join(" and ");
const sameHolder = (a: Pick<Holder, "kind" | "id">, b: Pick<Holder, "kind" | "id">) => a.kind === b.kind && a.id === b.id;
const describeHolder = (holder: Pick<Holder, "kind" | "id" | "title">) =>
  holder.title ?? (holder.kind === "agent" ? "an agent" : `${holder.kind} ${holder.id}`);
const describeHolders = (leases: LeaseView[]) => leases.map(({ holder }) => holder.title ?? `${holder.kind} ${holder.id}`).join(", ");

const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));

export function nextStep(server: ServerView): string {
  switch (server.state) {
    case "ready":
      return `ready at ${server.url}`;
    case "idle":
      return `ready at ${server.url}; nobody holds it${server.idleStopAt ? `, so it stops at ${server.idleStopAt} unless someone starts it again` : ""}`;
    case "building":
    case "prewarming": {
      const minutes = minutesSince(server.stateSince);
      return `building${server.progress ? ` (${server.progress})` : ""} for ${minutes ? `${minutes} min` : "less than a minute"}; check its status again in a minute`;
    }
    case "crashed":
      return `crashed: ${server.lastError ?? "see the logs"}. Read the logs; the dev tool usually rebuilds on the next file change, or stop and start it again`;
    case "external":
      return `started outside the plugin, at ${server.url}; the plugin never stops it and cannot read its output`;
    default:
      return `${server.state}; start it again to use it`;
  }
}

async function readTail(file: string, maxBytes: number) {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { lines: [], cut: false };
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return { lines: lines.map(plainLine), cut: start > 0 };
  } finally {
    await handle.close();
  }
}

export function createService({
  config,
  store,
  ports,
  supervisor,
  place,
  leases = noLeases,
  capacity = unlimited,
  externals,
  probe,
  gitCacheMs = 5000,
  logReadBytes = 8 * 1024 * 1024,
  onWarning = console.warn,
}: ServiceOptions): DevServersService {
  const locks = new Map<string, Promise<unknown>>();
  const gitCache = createGitCache(gitCacheMs);
  const placeFor =
    place ??
    createStackPlacement({
      worktreeRoots: config.worktreeRoots,
      servers: () => Object.values(store.snapshot().servers),
      dirtyFiles: gitCache.dirtyFiles,
      stackOrder: cocoStackOrder(config.coco),
    });

  const exclusive = <R>(id: string, task: () => Promise<R>): Promise<R> => {
    const run = (locks.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => locks.get(id) === settled && locks.delete(id));
    return run;
  };

  const refreshExternals = () =>
    externals
      ?.scan({ maxAgeMs: EXTERNAL_SCAN_MAX_AGE_MS })
      .catch((error) => onWarning(`external scan failed: ${error instanceof Error ? error.message : String(error)}`));

  const projectOf = (id: string) => config.projects.find((project) => project.id === id);
  const idleStopAt = (deadline: string, lastUsedAt: string) =>
    new Date(Math.max(Date.parse(deadline), Date.parse(lastUsedAt) + config.idleStopMinutes * 60_000)).toISOString();

  const view = async (record: ServerRecord): Promise<ServerView> => {
    const urlTemplate = projectOf(record.project)?.urlTemplate ?? "http://localhost:{port}";
    return {
      id: record.id,
      project: record.project,
      worktree: { path: record.worktree, ...(await gitCache.info(record.worktree)) },
      port: record.port,
      url: renderTemplate(urlTemplate, { port: record.port, worktree: record.worktree, logDir: logDirFor(config.stateDir, record.id) }),
      reserved: record.reserved,
      state: record.state,
      stateSince: record.stateSince,
      ...(record.progress !== undefined && { progress: record.progress }),
      ...(record.lastError !== undefined && { lastError: record.lastError }),
      ...(record.buildSeconds !== undefined && { buildSeconds: record.buildSeconds }),
      pinned: record.pinned,
      ...(record.pinned && record.pinnedBy && { pinnedBy: record.pinnedBy }),
      optIns: record.optIns,
      leases: leases.holders(record.id),
      lastUsedAt: record.lastUsedAt,
      ...(record.deadlines.idle && { idleStopAt: idleStopAt(record.deadlines.idle, record.lastUsedAt) }),
      logs: record.logs,
    };
  };

  const recordOf = (id: string) => {
    const record = store.snapshot().servers[id];
    if (!record) throw new ServiceError("not_found", `no server ${id}`, { id });
    return record;
  };

  const update = (id: string, mutate: (record: ServerRecord) => void) =>
    store.update((draft) => {
      const record = draft.servers[id];
      if (record) mutate(record);
    });

  const touch = (id: string) => update(id, (record) => void (record.lastUsedAt = new Date().toISOString()));

  const isOurs = (port: number) => Object.values(store.snapshot().servers).some((record) => record.process && record.reserved.includes(port));

  const assignPorts = async ({ worktree, project }: Target, because: string[]) => {
    try {
      const assigned = await ports.ensure({ worktree, project: project.id, ports: project.ports, probe: probe ?? listenerProbe({ isOurs }) });
      if (assigned.reassigned) because.push(`moved from port ${assigned.reassigned.from} to ${assigned.base}: ${assigned.reassigned.because.join("; ")}`);
      return assigned;
    } catch (error) {
      if (error instanceof PortUnavailableError) throw new ServiceError("port_unavailable", error.message, { reasons: error.reasons });
      throw error;
    }
  };

  const plan = async (raw: unknown, caller: Caller) => {
    const input = parse(startInputSchema, raw);
    const services = [...new Set(input.services ?? [])].sort();
    const dedicatedDb = input.dedicatedDb ?? false;
    const reason = input.reason?.trim() || null;
    if ((services.length || dedicatedDb) && !reason)
      throw new ServiceError("reason_required", "say why in reason when asking for services or a dedicated database");
    const cwd = input.cwd ?? caller.cwd;
    if (!cwd) throw new ServiceError("bad_request", "cwd is required: the absolute path of the worktree to serve");
    const target = await resolveTarget(cwd, config.projects);
    if (services.length && !target.project.optIns.services) throw new ServiceError("bad_request", `project ${target.project.id} has no opt-in services`);
    if (dedicatedDb && !target.project.optIns.dedicatedDb)
      throw new ServiceError("bad_request", `project ${target.project.id} has no dedicated database option`);
    const placement = await placeFor(target, { ...input, services, dedicatedDb, reason: reason ?? undefined });
    const wanted: OptIns = { services, dedicatedDb, reason: services.length || dedicatedDb ? reason : null };
    const because = [...placement.because];
    const served = placement.servedFrom === target.worktree ? target : { ...target, worktree: placement.servedFrom };
    const outside = store.snapshot().servers[serverIdFor(served.worktree)];
    let mode = placement.mode;
    if (outside?.state === "external") {
      if (hasOptIns(wanted)) {
        throw new ServiceError(
          "external_readonly",
          `${served.worktree} runs a server started outside the plugin, on port ${outside.port}, which the plugin cannot restart with ${describeOptIns(wanted)}; stop it yourself, then start again`,
          { id: outside.id, port: outside.port },
        );
      }
      if (mode !== "external")
        because.push(`its server on port ${outside.port} was started outside the plugin: it runs with its own settings and the plugin never stops it`);
      mode = "external";
    } else if (services.length) {
      for (const record of Object.values(store.snapshot().servers)) {
        if (record.state !== "external" || record.project !== target.project.id) continue;
        because.push(
          `a server started outside the plugin runs ${record.worktree} on port ${record.port} with its own settings, which may turn on every service: ${services.join(", ")} may run twice`,
        );
      }
    }
    return { input, wanted, served, placement: { ...placement, mode, because } };
  };

  const launch = async (target: Target, wanted: OptIns, caller: Caller, because: string[]) => {
    const id = serverIdFor(target.worktree);
    let running = store.snapshot().servers[id]?.process ? store.snapshot().servers[id] : undefined;
    if (running && !satisfies(running.optIns, wanted)) {
      const others = leases.holders(id).filter(({ holder }) => !sameHolder(holder, caller.holder));
      if (others.length) {
        throw new ServiceError("held_by_others", `the server runs without ${describeOptIns(wanted)} and is also used by ${describeHolders(others)}`, {
          holders: others.map(({ holder }) => holder),
        });
      }
      await supervisor.stop(id);
      because.push(`restarted to add ${describeOptIns(wanted)}`);
      running = undefined;
    } else if (running && hasOptIns(running.optIns) && !hasOptIns(wanted)) {
      because.push(`already running with ${describeOptIns(running.optIns)}: ${running.optIns.reason}`);
    }
    const spawn = async (port: number, reserved: number[], optIns: OptIns) => {
      try {
        await supervisor.start({ project: target.project, worktree: target.worktree, port, reserved, optIns });
      } catch (error) {
        if (error instanceof StartFailedError) throw new ServiceError("start_failed", error.message);
        throw error;
      }
    };
    if (running) {
      await spawn(running.port, running.reserved, running.optIns);
      return { id, evicted: [] };
    }
    const { evicted } = await capacity.admit({ id, worktree: target.worktree }, async () => {
      const { base, reserved } = await assignPorts(target, because);
      await spawn(base, reserved, wanted);
    });
    return { id, evicted };
  };

  return {
    start: async (raw, caller) => {
      await refreshExternals();
      const { input, wanted, served, placement } = await plan(raw, caller);
      const because = placement.because;
      const { id, evicted, lease } = await exclusive(serverIdFor(served.worktree), async () => {
        const servedId = serverIdFor(served.worktree);
        const launched =
          store.snapshot().servers[servedId]?.state === "external" ? { id: servedId, evicted: [] } : await launch(served, wanted, caller, because);
        await update(launched.id, (record) => {
          record.lastUsedAt = new Date().toISOString();
          if (input.pin && record.state !== "external" && !record.pinned) {
            record.pinned = true;
            record.pinnedBy = { kind: caller.holder.kind, id: caller.holder.id };
          }
        });
        return { ...launched, lease: await leases.take(launched.id, caller.holder) };
      });
      for (const { worktree, why } of evicted) because.push(`stopped the server of ${worktree} to make room: ${why}`);
      if (input.waitSeconds > 0) await supervisor.waitFor(id, (record) => !record || !BUILDING.includes(record.state), input.waitSeconds * 1000);
      gitCache.forget(served.worktree);
      const server = await view(recordOf(id));
      const next = placement.ambiguous ? `${nextStep(server)}. ${placement.ambiguous.question}` : nextStep(server);
      return { server, placement, lease, ...(evicted.length && { evicted }), next };
    },

    placement: async (raw, caller) => {
      const input = parse(placementInputSchema, raw);
      await refreshExternals();
      const { served, placement } = await plan(input, caller);
      const record = store.snapshot().servers[serverIdFor(served.worktree)];
      return { placement, server: record ? await view(record) : null };
    },

    list: async () => {
      const records = Object.values(store.snapshot().servers).sort((a, b) => a.worktree.localeCompare(b.worktree));
      return Promise.all(records.map(view));
    },

    get: async (id) => {
      recordOf(id);
      await touch(id);
      return view(recordOf(id));
    },

    stop: async (id, raw, caller) => {
      const { force } = parse(stopInputSchema, raw);
      return exclusive(id, async () => {
        const record = recordOf(id);
        await leases.release(id, caller.holder);
        const kept = (reason: NonNullable<StopResult["kept"]>, next: string): Promise<StopResult> =>
          view(recordOf(id)).then((server) => ({ server, stopped: false, kept: reason, swept: [], portsBusy: [], next }));
        if (record.state === "external") {
          if (force) throw new ServiceError("external_readonly", `${id} was started outside the plugin, which never stops it`, { id });
          return kept("external", "your lease is released; the server was started outside the plugin, which never stops it");
        }
        if (!force) {
          const others = leases.holders(id);
          if (others.length) return kept("leased", `kept running for ${describeHolders(others)}; your lease is released`);
          if (record.pinned) return kept("pinned", "kept running because it is pinned; stop it with force to override");
        }
        if (leases.holders(id).length) await leases.lose(id, `stopped by ${describeHolder(caller.holder)}`);
        const result = await supervisor.stop(id);
        const server = await view(recordOf(id));
        return {
          server,
          stopped: true,
          swept: result.swept,
          portsBusy: result.portsBusy,
          ...(result.note && { note: result.note }),
          next: result.portsBusy.length ? `stopped, but ports ${result.portsBusy.join(", ")} still accept connections` : "stopped",
        };
      });
    },

    pin: async (id, raw, caller) => {
      const { pinned } = parse(pinInputSchema, raw);
      return exclusive(id, async () => {
        const record = recordOf(id);
        if (record.state === "external")
          throw new ServiceError("external_readonly", `${id} was started outside the plugin, which never stops it, so a pin changes nothing`, { id });
        const owner = record.pinnedBy;
        if (!pinned && record.pinned && caller.holder.kind === "agent" && !(owner && sameHolder(owner, caller.holder))) {
          const by = owner ? describeHolder(leases.holders(id).find(({ holder }) => sameHolder(holder, owner))?.holder ?? owner) : "someone else";
          throw new ServiceError("held_by_others", `${id} was pinned by ${by}; an agent can only undo its own pin`, { id, pinnedBy: owner ?? null });
        }
        await update(id, (current) => {
          if (pinned && !current.pinned) current.pinnedBy = { kind: caller.holder.kind, id: caller.holder.id };
          if (!pinned) delete current.pinnedBy;
          current.pinned = pinned;
          current.lastUsedAt = new Date().toISOString();
        });
        await leases.settle(id);
        const server = await view(recordOf(id));
        return {
          server,
          next: pinned
            ? "pinned: it keeps running when nobody holds it and is never stopped to make room; unpin it when you no longer need it"
            : `unpinned; ${nextStep(server)}`,
        };
      });
    },

    logs: async (id, raw) => {
      const { lines, grep, source } = parse(logsInputSchema, raw);
      const record = recordOf(id);
      if (record.state === "external")
        throw new ServiceError("not_found", `${id} was started outside the plugin, which cannot read its output`, { id, source });
      const file = source === "app" ? record.logs.app : record.logs.run;
      if (!file) throw new ServiceError("not_found", `${id} has no ${source} log`, { id, source });
      let pattern: RegExp | null = null;
      try {
        pattern = grep ? new RegExp(grep, "i") : null;
      } catch (error) {
        throw new ServiceError("bad_request", `grep is not a valid regular expression: ${(error as Error).message}`);
      }
      const { lines: all, cut } = await readTail(file, logReadBytes);
      const matched = pattern ? all.filter((line) => pattern.test(line)) : all;
      await touch(id);
      return { id, source, file, lines: matched.slice(-lines), truncated: cut || matched.length > lines };
    },
  };
}
