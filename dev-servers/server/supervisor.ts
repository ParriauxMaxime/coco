import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseConfig, renderTemplate, renderValue, type ProjectConfig, type TemplateVars } from "./config.ts";
import {
  bootTime,
  cwdOf,
  groupAlive,
  infoOf,
  isAlive,
  isUnder,
  pidsWithCwdUnder,
  portListening,
  processInfo,
  realPath,
  resolveExecutable,
  signal,
  waitUntil,
} from "./proc.ts";
import { LogTail, compilePatterns, initialPhase, nextPhase, probeHttp, wantsProbe, type LogPatterns, type Phase, type PhaseContext } from "./readiness.ts";
import { serverIdFor, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";

export class StartFailedError extends Error {
  readonly code = "start_failed";
}

type ProcessRecord = NonNullable<ServerRecord["process"]>;

export type OptIns = ServerRecord["optIns"];
export type StartRequest = { project: ProjectConfig; worktree: string; port: number; reserved: number[]; optIns?: OptIns };

export const NO_OPT_INS: OptIns = { services: [], dedicatedDb: false, reason: null };
export type StopResult = { id: string; found: boolean; signalled: "group" | "none" | "refused"; swept: number[]; portsBusy: number[]; note?: string };
export type AdoptOutcome = { id: string; outcome: "adopted" | "gone" | "rejected" | "stopped"; detail?: string };
export type Verdict = { kind: "alive" } | { kind: "gone" } | { kind: "reused"; reason: string };

export type Supervisor = {
  start(request: StartRequest): Promise<ServerRecord>;
  stop(id: string, options?: { graceSeconds?: number }): Promise<StopResult>;
  adopt(): Promise<AdoptOutcome[]>;
  get(id: string): ServerRecord | undefined;
  watching(id: string): boolean;
  waitFor(id: string, until: (record: ServerRecord | undefined) => boolean, timeoutMs: number): Promise<ServerRecord | undefined>;
  subscribe(listener: (record: ServerRecord) => void): () => void;
  close(): void;
};

export type SupervisorOptions = {
  store: JsonStore<DevServersState>;
  stateDir: string;
  project: (id: string) => ProjectConfig | undefined;
  pollMs?: number;
  probeTimeoutMs?: number;
  onWarning?: (message: string) => void;
};

const UNCONFIGURED = parseConfig({ projects: [{ id: "unconfigured", match: { paths: ["/"] }, command: ["true"] }] }).projects[0];

export const logDirFor = (stateDir: string, id: string) => path.join(stateDir, "logs", id);

// The same pid with the same start time and a cwd inside the worktree is our process; anything else is a stranger we must not signal.
export async function verifyProcess(proc: ProcessRecord, worktree: string): Promise<Verdict> {
  const info = await infoOf(proc.pid);
  if (!info) return isAlive(proc.pid) ? { kind: "reused", reason: `pid ${proc.pid} is alive but unreadable` } : { kind: "gone" };
  if (info.startedAt !== proc.startedAt) return { kind: "reused", reason: `pid ${proc.pid} started at ${info.startedAt}, not ${proc.startedAt}` };
  const cwd = await cwdOf(proc.pid);
  if (cwd && !isUnder(realPath(cwd), realPath(worktree))) return { kind: "reused", reason: `pid ${proc.pid} runs in ${cwd}, outside ${worktree}` };
  return { kind: "alive" };
}

type Watch = {
  id: string;
  proc: ProcessRecord;
  worktree: string;
  origin: string;
  project: ProjectConfig;
  patterns: LogPatterns;
  tail: LogTail;
  phase: Phase;
  exit?: string;
  busy: boolean;
  closed: boolean;
};

const buildTimeoutMs = (project: ProjectConfig) => project.readiness.timeoutMinutes * 60_000;

const applyPhase = (record: ServerRecord, phase: Phase) => {
  record.state = phase.state;
  record.stateSince = phase.stateSince;
  record.progress = phase.progress;
  record.lastError = phase.lastError;
  record.buildSeconds = phase.buildSeconds;
  if (phase.readyBy) record.deadlines.ready = phase.readyBy;
  else delete record.deadlines.ready;
};

const storedPhase = (record: ServerRecord): Phase => ({
  state: record.state,
  stateSince: record.stateSince,
  progress: record.progress,
  lastError: record.lastError,
  buildSeconds: record.buildSeconds,
  readyBy: record.deadlines.ready,
  readySeen: false,
});

const phaseKey = (phase: Phase) => JSON.stringify([phase.state, phase.stateSince, phase.progress, phase.lastError, phase.buildSeconds, phase.readyBy]);

const describeExit = (code: number | null, signalName: NodeJS.Signals | null) => (signalName ? `killed by ${signalName}` : `exited with code ${code}`);

export function createSupervisor({
  store,
  stateDir,
  project: projectOf,
  pollMs = 500,
  probeTimeoutMs = 2000,
  onWarning = console.warn,
}: SupervisorOptions): Supervisor {
  const watches = new Map<string, Watch>();
  const listeners = new Set<(record: ServerRecord) => void>();
  const locks = new Map<string, Promise<unknown>>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const exclusive = <R>(id: string, task: () => Promise<R>): Promise<R> => {
    const run = (locks.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => locks.get(id) === settled && locks.delete(id));
    return run;
  };

  const emit = (record: ServerRecord | undefined) => {
    if (record) for (const listener of listeners) listener(record);
  };

  const patch = async (id: string, mutate: (record: ServerRecord) => void) => {
    const record = await store.update((draft) => {
      const current = draft.servers[id];
      if (current) mutate(current);
      return current;
    });
    emit(record && store.snapshot().servers[id]);
    return store.snapshot().servers[id];
  };

  const ctxFor = (watch: Pick<Watch, "patterns" | "project">): PhaseContext => ({
    patterns: watch.patterns,
    now: new Date(),
    buildTimeoutMs: buildTimeoutMs(watch.project),
  });

  const originFor = (project: ProjectConfig, record: Pick<ServerRecord, "port" | "worktree">, logDir: string) =>
    renderTemplate(project.urlTemplate, { port: record.port, worktree: record.worktree, logDir });

  const killGroup = async (proc: ProcessRecord, graceMs: number) => {
    const target = proc.pgid === proc.pid ? -proc.pgid : proc.pid;
    const alive = () => (target < 0 ? groupAlive(proc.pgid) : isAlive(proc.pid));
    signal(target, "SIGTERM");
    if (await waitUntil(() => !alive(), graceMs)) return;
    signal(target, "SIGKILL");
    if (!(await waitUntil(() => !alive(), 3000))) onWarning(`process group ${proc.pgid} survived SIGKILL`);
  };

  const sweep = async (worktree: string, project: ProjectConfig, graceMs: number) => {
    const dirs = project.stop.sweepCwdUnder.map((dir) => path.resolve(worktree, dir));
    const before = await processInfo(await pidsWithCwdUnder(dirs));
    if (!before.size) return [];
    for (const pid of before.keys()) signal(pid, "SIGTERM");
    await waitUntil(() => [...before.keys()].every((pid) => !isAlive(pid)), Math.min(graceMs, 3000));
    const after = await processInfo([...before.keys()]);
    for (const [pid, info] of after) if (info.startedAt === before.get(pid)?.startedAt) signal(pid, "SIGKILL");
    await waitUntil(() => [...before.keys()].every((pid) => !isAlive(pid)), 2000);
    return [...before.keys()];
  };

  const unwatch = (id: string, only?: Watch) => {
    const watch = watches.get(id);
    if (only) only.closed = true;
    if (!watch || (only && watch !== only)) return;
    watch.closed = true;
    watches.delete(id);
    if (!watches.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const persistPhase = async (watch: Watch, gone: boolean) => {
    const record = await patch(watch.id, (record) => {
      if (record.process?.pid !== watch.proc.pid) return;
      applyPhase(record, watch.phase);
      if (gone) record.process = null;
    });
    if (record?.process?.pid !== watch.proc.pid) unwatch(watch.id, watch);
  };

  const tick = async (watch: Watch) => {
    if (watch.busy || watch.closed) return;
    watch.busy = true;
    try {
      const before = phaseKey(watch.phase);
      const feed = (lines: string[]) => {
        for (const line of lines) watch.phase = nextPhase(watch.phase, { kind: "line", line }, ctxFor(watch));
      };
      feed(await watch.tail.read());
      const gone = watch.exit !== undefined || !isAlive(watch.proc.pid);
      if (gone) {
        feed(await watch.tail.readAll());
        const last = watch.tail.lastLines(1)[0];
        watch.phase = nextPhase(watch.phase, { kind: "exit", detail: `${watch.exit ?? "exited"}${last ? `; last output: ${last}` : ""}` }, ctxFor(watch));
        if (watch.proc.pgid === watch.proc.pid && groupAlive(watch.proc.pgid)) await killGroup(watch.proc, watch.project.stop.graceSeconds * 1000);
      } else {
        watch.phase = nextPhase(watch.phase, { kind: "tick" }, ctxFor(watch));
        if (wantsProbe(watch.phase, watch.patterns) && (await probeHttp(watch.origin, watch.project.readiness.http, probeTimeoutMs))) {
          watch.phase = nextPhase(watch.phase, { kind: "probe-ok" }, ctxFor(watch));
        }
      }
      if (watch.closed) return;
      if (gone || phaseKey(watch.phase) !== before) await persistPhase(watch, gone);
      if (gone) unwatch(watch.id, watch);
    } catch (error) {
      onWarning(`watching ${watch.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      watch.busy = false;
    }
  };

  const watch = (entry: Watch) => {
    watches.set(entry.id, entry);
    if (!timer && !closed) {
      timer = setInterval(() => {
        for (const current of watches.values()) void tick(current);
      }, pollMs);
      timer.unref();
    }
    void tick(entry);
  };

  const spawnServer = async ({ project, worktree, port, reserved, optIns = NO_OPT_INS }: StartRequest) => {
    const id = serverIdFor(worktree);
    const cwd = path.join(worktree, project.appDir);
    if (!fs.existsSync(cwd)) throw new StartFailedError(`${cwd} does not exist`);
    const logDir = logDirFor(stateDir, id);
    fs.mkdirSync(logDir, { recursive: true });
    const runLog = path.join(logDir, "run.log");
    const vars: TemplateVars = { port, logDir, worktree, services: optIns.services };
    const dedicatedDb = optIns.dedicatedDb ? project.optIns.dedicatedDb : undefined;
    const argv = (renderValue([...project.command, ...(dedicatedDb?.args ?? [])], vars) as unknown[]).map(String);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(Object.entries(renderValue({ ...project.env, ...dedicatedDb?.env }, vars) as object).map(([k, v]) => [k, String(v)])),
    };
    env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
    const executable = resolveExecutable(argv[0], cwd, env.PATH);
    if (!executable) throw new StartFailedError(`${argv[0]} was not found on PATH`);

    fs.appendFileSync(runLog, `\n--- dev-servers ${new Date().toISOString()}: ${argv.join(" ")} (in ${cwd}, port ${port})\n`);
    const logOffset = fs.statSync(runLog).size;
    const fd = fs.openSync(runLog, "a");
    let child: ChildProcess;
    try {
      child = spawn(executable, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error) => reject(new StartFailedError(`${argv[0]}: ${error.message}`)));
    });
    child.unref();
    const pid = child.pid!;
    let exit: string | undefined;
    child.once("exit", (code, signalName) => {
      exit = describeExit(code, signalName);
      const current = watches.get(id);
      if (current?.proc.pid === pid) current.exit = exit;
    });
    const info = await infoOf(pid);
    const proc: ProcessRecord = { pid, pgid: info?.pgid ?? pid, startedAt: info?.startedAt ?? "", cwd: realPath(cwd), logOffset };
    const patterns = compilePatterns(project.logPatterns);
    const phase = initialPhase({ patterns, now: new Date(), buildTimeoutMs: buildTimeoutMs(project) });
    const now = new Date().toISOString();
    await store.update((draft) => {
      const previous = draft.servers[id];
      const record: ServerRecord = {
        ...previous,
        id,
        project: project.id,
        worktree: path.resolve(worktree),
        port,
        reserved,
        state: "building",
        stateSince: phase.stateSince,
        process: proc,
        pinned: previous?.pinned ?? false,
        optIns,
        lastUsedAt: now,
        deadlines: { ...previous?.deadlines },
        logs: { ...previous?.logs, run: runLog },
      };
      applyPhase(record, phase);
      draft.servers[id] = record;
    });
    const tail = new LogTail(runLog, logOffset);
    watch({
      id,
      proc,
      worktree: path.resolve(worktree),
      origin: originFor(project, { port, worktree }, logDir),
      project,
      patterns,
      tail,
      phase,
      exit,
      busy: false,
      closed: false,
    });
    const record = store.snapshot().servers[id];
    emit(record);
    return record;
  };

  const stopNow = async (id: string, graceSeconds?: number): Promise<StopResult> => {
    unwatch(id);
    const record = await patch(id, (record) => {
      record.state = "stopping";
      record.stateSince = new Date().toISOString();
    });
    if (!record) return { id, found: false, signalled: "none", swept: [], portsBusy: [] };
    const project = projectOf(record.project) ?? UNCONFIGURED;
    const graceMs = (graceSeconds ?? project.stop.graceSeconds) * 1000;
    let signalled: StopResult["signalled"] = "none";
    let note: string | undefined;
    if (record.process) {
      const verdict = await verifyProcess(record.process, record.worktree);
      if (verdict.kind === "alive") {
        await killGroup(record.process, graceMs);
        signalled = "group";
      } else if (verdict.kind === "reused") {
        signalled = "refused";
        note = `${verdict.reason}; it was left alone`;
        onWarning(`${id}: ${note}`);
      }
    }
    const swept = await sweep(record.worktree, project, graceMs);
    await waitUntil(async () => !(await Promise.all(record.reserved.map((port) => portListening(port)))).some(Boolean), 3000, 200);
    const busy = await Promise.all(record.reserved.map(async (port) => ((await portListening(port)) ? port : 0)));
    const portsBusy = busy.filter(Boolean);
    await patch(id, (current) => {
      current.state = "stopped";
      current.stateSince = new Date().toISOString();
      current.process = null;
      current.progress = undefined;
      current.lastError = portsBusy.length ? `still listening after stop: ${portsBusy.join(", ")}` : undefined;
      delete current.deadlines.ready;
    });
    return { id, found: true, signalled, swept, portsBusy, ...(note && { note }) };
  };

  const replayPhase = async (record: ServerRecord, proc: ProcessRecord, project: ProjectConfig, patterns: LogPatterns, origin: string) => {
    const tail = new LogTail(record.logs.run, proc.logOffset ?? 0);
    const ctx = (): PhaseContext => ({ patterns, now: new Date(), buildTimeoutMs: buildTimeoutMs(project) });
    let phase = initialPhase(ctx());
    for (const line of await tail.readAll()) phase = nextPhase(phase, { kind: "line", line }, ctx());
    const stored = { ...storedPhase(record), readySeen: phase.readySeen };
    const serving = record.state === "ready" || record.state === "idle";
    if (serving && wantsProbe(phase, patterns)) {
      if (await probeHttp(origin, project.readiness.http, probeTimeoutMs)) phase = stored;
    } else if (phase.state === record.state) {
      phase = { ...stored, progress: phase.progress ?? stored.progress, lastError: phase.lastError ?? stored.lastError };
    }
    return { tail, phase };
  };

  const adoptOne = async (record: ServerRecord): Promise<AdoptOutcome | null> => {
    const proc = record.process;
    if (!proc || watches.has(record.id)) return null;
    const verdict = await verifyProcess(proc, record.worktree);
    if (verdict.kind !== "alive") {
      const boot = verdict.kind === "gone" ? await bootTime() : null;
      const started = Date.parse(proc.startedAt);
      const rebooted = boot !== null && Number.isFinite(started) && started < boot;
      const tail = new LogTail(record.logs.run, proc.logOffset ?? 0);
      await tail.readAll();
      const last = tail.lastLines(1)[0];
      const detail =
        verdict.kind === "reused"
          ? `${verdict.reason}; not adopted`
          : rebooted
            ? "stopped by a machine restart"
            : `exited while the plugin was not running${last ? `; last output: ${last}` : ""}`;
      await patch(record.id, (current) => {
        const wasStopping = current.state === "stopping" || current.state === "stopped";
        current.state = rebooted || wasStopping ? "stopped" : "crashed";
        current.stateSince = new Date().toISOString();
        current.process = null;
        current.progress = undefined;
        current.lastError = wasStopping ? undefined : detail;
        delete current.deadlines.ready;
      });
      return { id: record.id, outcome: verdict.kind === "reused" ? "rejected" : "gone", detail };
    }
    if (record.state === "stopping" || record.state === "stopped") {
      await stopNow(record.id);
      return { id: record.id, outcome: "stopped", detail: `resumed an unfinished stop` };
    }
    const project = projectOf(record.project) ?? UNCONFIGURED;
    const patterns = compilePatterns(project.logPatterns);
    const origin = originFor(project, record, logDirFor(stateDir, record.id));
    const { tail, phase } = await replayPhase(record, proc, project, patterns, origin);
    const entry: Watch = { id: record.id, proc, worktree: record.worktree, origin, project, patterns, tail, phase, busy: false, closed: false };
    if (phaseKey(phase) !== phaseKey(storedPhase(record))) await persistPhase(entry, false);
    watch(entry);
    return { id: record.id, outcome: "adopted", detail: `pid ${proc.pid}, ${phase.state}` };
  };

  return {
    start: (request) =>
      exclusive(serverIdFor(request.worktree), async () => {
        const id = serverIdFor(request.worktree);
        const current = watches.get(id);
        if (current && !current.exit && isAlive(current.proc.pid)) return store.snapshot().servers[id];
        const recorded = (await store.load()).servers[id];
        if (!current && recorded && (await adoptOne(recorded))?.outcome === "adopted") return store.snapshot().servers[id];
        unwatch(id);
        return spawnServer(request);
      }),
    stop: (id, { graceSeconds } = {}) => exclusive(id, () => stopNow(id, graceSeconds)),
    adopt: async () => {
      const state = await store.load();
      const outcomes = await Promise.all(Object.values(state.servers).map((record) => exclusive(record.id, () => adoptOne(record))));
      return outcomes.filter((outcome): outcome is AdoptOutcome => outcome !== null);
    },
    get: (id) => store.snapshot().servers[id],
    watching: (id) => watches.has(id),
    waitFor: (id, until, timeoutMs) =>
      new Promise((resolve) => {
        const finish = (record: ServerRecord | undefined) => {
          clearTimeout(timeout);
          unsubscribe();
          resolve(record);
        };
        const listener = (record: ServerRecord) => record.id === id && until(record) && finish(record);
        listeners.add(listener);
        const unsubscribe = () => listeners.delete(listener);
        const timeout = setTimeout(() => finish(store.snapshot().servers[id]), timeoutMs);
        const current = store.snapshot().servers[id];
        if (until(current)) finish(current);
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => {
      closed = true;
      for (const id of [...watches.keys()]) unwatch(id);
    },
  };
}
