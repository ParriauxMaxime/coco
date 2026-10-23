import fs from "node:fs/promises";
import type { ServerState } from "../shared/states.ts";
import type { ProjectConfig } from "./config.ts";

export type LogPatterns = { progress?: RegExp; ready?: RegExp; crash?: RegExp; rebuild?: RegExp };
export type LineKind = "crash" | "rebuild" | "ready" | "progress";

export const compilePatterns = (patterns: ProjectConfig["logPatterns"]): LogPatterns =>
  Object.fromEntries(Object.entries(patterns).flatMap(([kind, source]) => (source ? [[kind, new RegExp(source)]] : [])));

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
export const plainLine = (line: string) => line.replace(ANSI, "").replace(/\r$/, "");

// A line matching several patterns counts as the first of crash, rebuild, ready, progress.
export function classifyLine(line: string, patterns: LogPatterns): { kind: LineKind; detail: string } | null {
  for (const kind of ["crash", "rebuild", "ready", "progress"] as const) {
    const match = patterns[kind]?.exec(line);
    if (match) return { kind, detail: (kind === "progress" && match[1]) || line.trim() };
  }
  return null;
}

export type Phase = {
  state: ServerState;
  stateSince: string;
  progress?: string;
  lastError?: string;
  buildSeconds?: number;
  readyBy?: string;
  readySeen: boolean;
};

export type PhaseEvent = { kind: "line"; line: string } | { kind: "probe-ok" } | { kind: "exit"; detail: string } | { kind: "tick" };

export type PhaseContext = { patterns: LogPatterns; now: Date; buildTimeoutMs: number };

const enter = (phase: Phase, state: ServerState, now: Date, patch: Partial<Phase> = {}): Phase => ({
  ...phase,
  state,
  stateSince: now.toISOString(),
  ...patch,
});

const startBuild = (phase: Phase, { now, buildTimeoutMs }: PhaseContext): Phase =>
  enter(phase, "building", now, {
    progress: undefined,
    buildSeconds: undefined,
    readySeen: false,
    readyBy: new Date(now.getTime() + buildTimeoutMs).toISOString(),
  });

export const initialPhase = (ctx: PhaseContext): Phase => startBuild({ state: "building", stateSince: ctx.now.toISOString(), readySeen: false }, ctx);

const isBuilding = (state: ServerState) => state === "building" || state === "prewarming";

// The ready transition needs a passing HTTP probe; when a ready pattern is configured, it must also have been logged since the build began.
export const wantsProbe = (phase: Phase, patterns: LogPatterns) => isBuilding(phase.state) && (phase.readySeen || !patterns.ready);

const WATCHED: ServerState[] = ["prewarming", "building", "ready", "idle", "crashed"];

export function nextPhase(phase: Phase, event: PhaseEvent, ctx: PhaseContext): Phase {
  const { now } = ctx;
  if (!WATCHED.includes(phase.state)) return phase;
  switch (event.kind) {
    case "exit":
      if (phase.state === "crashed") return phase;
      return enter(phase, "crashed", now, { lastError: event.detail, progress: undefined, readyBy: undefined, readySeen: false });
    case "tick":
      if (isBuilding(phase.state) && phase.readyBy && now.getTime() >= Date.parse(phase.readyBy)) {
        const minutes = Math.round((ctx.buildTimeoutMs / 60_000) * 10) / 10;
        return enter(phase, "crashed", now, { lastError: `not ready after ${minutes} min`, readyBy: undefined, readySeen: false });
      }
      return phase;
    case "probe-ok":
      if (!wantsProbe(phase, ctx.patterns)) return phase;
      return enter(phase, "ready", now, {
        progress: undefined,
        readyBy: undefined,
        lastError: undefined,
        buildSeconds: Math.round((now.getTime() - Date.parse(phase.stateSince)) / 1000),
      });
    case "line": {
      const seen = classifyLine(plainLine(event.line), ctx.patterns);
      if (!seen) return phase;
      if (seen.kind === "crash") {
        return phase.state === "crashed"
          ? { ...phase, lastError: seen.detail }
          : enter(phase, "crashed", now, { lastError: seen.detail, progress: undefined, readyBy: undefined, readySeen: false });
      }
      if (seen.kind === "rebuild") return isBuilding(phase.state) ? { ...phase, readySeen: false } : startBuild(phase, ctx);
      if (seen.kind === "ready") return isBuilding(phase.state) ? { ...phase, readySeen: true } : phase;
      if (phase.state === "crashed") return { ...startBuild(phase, ctx), progress: seen.detail };
      return isBuilding(phase.state) ? { ...phase, progress: seen.detail } : phase;
    }
  }
}

export class LogTail {
  readonly file: string;
  offset: number;
  private partial = "";
  private readonly recent: string[] = [];

  constructor(file: string, offset: number) {
    this.file = file;
    this.offset = offset;
  }

  lastLines(count = 5) {
    return this.recent.slice(-count);
  }

  // Returns the complete lines appended since the last read; a file shorter than the offset was truncated, so reading restarts at 0.
  async read(maxBytes = 4 * 1024 * 1024): Promise<string[]> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.file, "r");
    } catch {
      return [];
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
      }
      const length = Math.min(size - this.offset, maxBytes);
      if (length <= 0) return [];
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      const lines = (this.partial + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      this.partial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.recent.push(plainLine(line));
      }
      this.recent.splice(0, Math.max(0, this.recent.length - 50));
      return lines;
    } finally {
      await handle.close();
    }
  }

  async readAll(): Promise<string[]> {
    const all: string[] = [];
    for (let before = -1; before !== this.offset;) {
      before = this.offset;
      all.push(...(await this.read()));
    }
    return all;
  }
}

export type HttpProbe = { path: string; bodyIncludes?: string };

export async function probeHttp(origin: string, { path, bodyIncludes }: HttpProbe, timeoutMs = 2000): Promise<boolean> {
  try {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const body = await response.text();
    return response.status < 400 && (bodyIncludes === undefined || body.includes(bodyIncludes));
  } catch {
    return false;
  }
}
