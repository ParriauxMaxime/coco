import path from "node:path";
import { renderTemplate, type ProjectConfig } from "./config.ts";
import { toplevel } from "./git.ts";
import { projectOf } from "./placement.ts";
import { cwdsOf, listeners as listListeners, processInfo, realPath, type Listener } from "./proc.ts";
import { probeHttp } from "./readiness.ts";
import type { LeaseBook } from "./service.ts";
import { serverIdFor, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";

export const SCAN_INTERVAL_MS = 30_000;

export type ExternalChange = { id: string; worktree: string; port: number; change: "adopted" | "gone" };

export type ExternalScanner = {
  scan(options?: { maxAgeMs?: number }): Promise<ExternalChange[]>;
  start(intervalMs?: number): void;
  close(): void;
};

export type ExternalScannerOptions = {
  store: JsonStore<DevServersState>;
  projects: ProjectConfig[];
  leases?: Pick<LeaseBook, "lose">;
  listeners?: () => Promise<Listener[]>;
  probeTimeoutMs?: number;
  onWarning?: (message: string) => void;
};

type Found = { id: string; worktree: string; project: ProjectConfig; pid: number; startedAt: string; cwd: string; port: number; ports: number[] };

// Exactly `<worktree>/<appDir>`, never deeper: a dev tool's inner server runs further down and answers the same probe.
const worktreeFor = (cwd: string, appDir: string) => {
  const dir = path.normalize(appDir).replace(/\/+$/, "");
  if (dir === "." || dir === "") return cwd;
  return cwd.endsWith(`${path.sep}${dir}`) ? cwd.slice(0, -dir.length - 1) : null;
};

export function createExternalScanner({
  store,
  projects,
  leases,
  listeners = listListeners,
  probeTimeoutMs = 1000,
  onWarning = console.warn,
}: ExternalScannerOptions): ExternalScanner {
  const adopters = projects.filter((project) => project.adopt);
  const patterns = new Map(adopters.map((project) => [project.id, project.adopt?.cwdPattern ? new RegExp(project.adopt.cwdPattern) : null]));
  let inflight: Promise<ExternalChange[]> | null = null;
  let lastAt = 0;
  let timer: NodeJS.Timeout | null = null;

  const resolveWorktree = async (dir: string, project: ProjectConfig) => {
    const top = await toplevel(dir);
    if (!top || realPath(top) !== dir) return false;
    return (await projectOf(dir, [project])) === project;
  };

  const find = async (live: Listener[]): Promise<Found[]> => {
    const servers = Object.values(store.snapshot().servers);
    const ourGroups = new Set(servers.flatMap((record) => (record.process ? [record.process.pgid] : [])));
    const ourWorktrees = new Set(servers.flatMap((record) => (record.process ? [realPath(record.worktree)] : [])));
    const infos = await processInfo([...new Set(live.map(({ pid }) => pid))].filter((pid) => pid !== process.pid));
    const strangers = [...infos.values()].filter(({ pgid }) => !ourGroups.has(pgid));
    const cwds = await cwdsOf(strangers.map(({ pid }) => pid));
    const checked = new Map<string, Promise<boolean>>();
    const found: Found[] = [];
    for (const { pid, startedAt } of strangers) {
      const raw = cwds.get(pid);
      if (!raw) continue;
      const cwd = realPath(raw);
      for (const project of adopters) {
        if (patterns.get(project.id)?.test(cwd) === false) continue;
        const worktree = worktreeFor(cwd, project.appDir);
        if (!worktree || ourWorktrees.has(worktree)) continue;
        const key = `${project.id} ${worktree}`;
        if (!checked.has(key)) checked.set(key, resolveWorktree(worktree, project));
        if (!(await checked.get(key))) continue;
        const ports = live.filter((entry) => entry.pid === pid).map(({ port }) => port);
        found.push({ id: serverIdFor(worktree), worktree, project, pid, startedAt, cwd, port: ports[0], ports });
        break;
      }
    }
    return found;
  };

  const answers = async ({ project, worktree }: Found, port: number) => {
    const origin = renderTemplate(project.urlTemplate, { port, worktree, logDir: "" });
    return probeHttp(origin, project.adopt!.probe, probeTimeoutMs);
  };

  // A server already adopted keeps its port while its process lives and listens; a new one needs a port that answers the probe.
  const pickPort = async (entry: Found, known: ServerRecord | undefined) => {
    const same = known?.state === "external" && known.external?.pid === entry.pid && known.external.startedAt === entry.startedAt;
    if (same && entry.ports.includes(known.port)) return known.port;
    for (const port of entry.ports) if (await answers(entry, port)) return port;
    return null;
  };

  const adopt = (entry: Found, port: number) =>
    store.update((draft) => {
      const previous = draft.servers[entry.id];
      if (previous?.process) return false;
      const now = new Date().toISOString();
      const same = previous?.state === "external" && previous.external?.pid === entry.pid;
      draft.servers[entry.id] = {
        ...previous,
        id: entry.id,
        project: entry.project.id,
        worktree: entry.worktree,
        port,
        reserved: entry.ports,
        state: "external",
        stateSince: same ? previous.stateSince : now,
        process: null,
        external: { pid: entry.pid, startedAt: entry.startedAt, cwd: entry.cwd },
        pinned: previous?.pinned ?? false,
        optIns: { services: [], dedicatedDb: false, reason: null },
        lastUsedAt: previous?.lastUsedAt ?? now,
        deadlines: {},
        logs: previous?.logs ?? { run: "" },
        progress: undefined,
        lastError: undefined,
        buildSeconds: undefined,
      };
      return !same;
    });

  const forget = async (record: ServerRecord) => {
    await leases?.lose(record.id, "the server started outside the plugin is no longer running");
    await store.update((draft) => {
      const current = draft.servers[record.id];
      if (current?.state !== "external") return;
      if (!current.logs.run) {
        delete draft.servers[record.id];
        return;
      }
      current.state = "stopped";
      current.stateSince = new Date().toISOString();
      delete current.external;
    });
  };

  const scanOnce = async (): Promise<ExternalChange[]> => {
    const known = Object.values(store.snapshot().servers).filter((record) => record.state === "external");
    if (!adopters.length && !known.length) return [];
    const live = adopters.length ? await listeners() : [];
    const changes: ExternalChange[] = [];
    const kept = new Set<string>();
    const byId = new Map<string, Found[]>();
    for (const entry of await find(live)) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    for (const [id, entries] of byId) {
      const current = store.snapshot().servers[id];
      for (const entry of entries) {
        const port = await pickPort(entry, current);
        if (port === null) continue;
        kept.add(id);
        if (await adopt(entry, port)) changes.push({ id, worktree: entry.worktree, port, change: "adopted" });
        break;
      }
    }
    for (const record of known) {
      if (kept.has(record.id)) continue;
      await forget(record);
      changes.push({ id: record.id, worktree: record.worktree, port: record.port, change: "gone" });
    }
    return changes;
  };

  const scan: ExternalScanner["scan"] = ({ maxAgeMs = 0 } = {}) => {
    if (inflight) return inflight;
    if (maxAgeMs && Date.now() - lastAt < maxAgeMs) return Promise.resolve([]);
    inflight = scanOnce().finally(() => {
      lastAt = Date.now();
      inflight = null;
    });
    return inflight;
  };

  const report = () =>
    void scan().then(
      (changes) => {
        for (const { id, worktree, port, change } of changes) console.log(`coco-dev-servers: ${id} ${change} as external (${worktree}, port ${port})`);
      },
      (error) => onWarning(`external scan failed: ${error instanceof Error ? error.message : String(error)}`),
    );

  return {
    scan,
    start: (intervalMs = SCAN_INTERVAL_MS) => {
      if (timer || (!adopters.length && !Object.values(store.snapshot().servers).some((record) => record.state === "external"))) return;
      report();
      timer = setInterval(report, intervalMs);
      timer.unref();
    },
    close: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
