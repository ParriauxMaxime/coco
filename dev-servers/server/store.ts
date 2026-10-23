import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { holderSchema } from "../shared/contracts.ts";
import { SERVER_STATES } from "../shared/states.ts";

export class StoreVersionError extends Error {}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const errorMessage = (error: unknown) => (error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error));

export async function writeJsonAtomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export type JsonStore<T> = {
  file: string;
  snapshot(): T;
  load(): Promise<T>;
  update<R>(mutate: (draft: T) => R | Promise<R>): Promise<R>;
};

type JsonStoreOptions<T extends { version: number }> = {
  file: string;
  schema: z.ZodType<T, unknown>;
  empty: () => T;
  migrate?: (raw: unknown, fromVersion: number) => unknown;
  onWarning?: (message: string) => void;
};

// Every update re-reads the file, so a write never rests on a stale copy; updates run one at a time.
export function createJsonStore<T extends { version: number }>({ file, schema, empty, migrate, onWarning = console.warn }: JsonStoreOptions<T>): JsonStore<T> {
  const currentVersion = empty().version;
  let snapshot = empty();
  let queue: Promise<unknown> = Promise.resolve();

  const parse = (raw: unknown) => {
    const version = (raw as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > currentVersion) {
      throw new StoreVersionError(`${file} is version ${version}, newer than this plugin (${currentVersion}); update the plugin`);
    }
    return schema.parse(typeof version === "number" && version < currentVersion && migrate ? migrate(raw, version) : raw);
  };

  const read = async (): Promise<T> => {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return empty();
      throw error;
    }
    try {
      return parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof StoreVersionError) throw error;
      const aside = `${file}.unreadable-${new Date().toISOString().replaceAll(":", "-")}`;
      await fs.rename(file, aside);
      onWarning(`${file} could not be read (${errorMessage(error)}); kept as ${aside}, starting empty`);
      return empty();
    }
  };

  const serialize = <R>(task: () => Promise<R>): Promise<R> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    file,
    snapshot: () => snapshot,
    load: () => serialize(async () => (snapshot = await read())),
    update: (mutate) =>
      serialize(async () => {
        const before = await read();
        const draft = structuredClone(before);
        const result = await mutate(draft);
        const next = schema.parse(draft);
        if (JSON.stringify(next) !== JSON.stringify(before)) await writeJsonAtomic(file, next);
        snapshot = next;
        return result;
      }),
  };
}

export const STATE_VERSION = 1;

const timestamp = z.iso.datetime({ offset: true });

const serverRecordSchema = z.object({
  id: z.string(),
  project: z.string(),
  worktree: z.string(),
  port: z.number().int(),
  reserved: z.array(z.number().int()),
  state: z.enum(SERVER_STATES),
  stateSince: timestamp,
  process: z
    .object({
      pid: z.number().int(),
      pgid: z.number().int(),
      startedAt: z.string(),
      cwd: z.string().optional(),
      logOffset: z.number().int().min(0).optional(),
    })
    .nullable()
    .default(null),
  progress: z.string().optional(),
  buildSeconds: z.number().optional(),
  pinned: z.boolean().default(false),
  pinnedBy: holderSchema.omit({ title: true }).optional(),
  external: z.object({ pid: z.number().int(), startedAt: z.string(), cwd: z.string() }).optional(),
  optIns: z
    .object({ services: z.array(z.string()).default([]), dedicatedDb: z.boolean().default(false), reason: z.string().nullable().default(null) })
    .prefault({}),
  lastUsedAt: timestamp,
  deadlines: z.record(z.string(), timestamp).default({}),
  logs: z.object({ run: z.string(), app: z.string().optional() }),
  lastError: z.string().optional(),
});

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  servers: z.record(z.string(), serverRecordSchema).default({}),
});

export type ServerRecord = z.output<typeof serverRecordSchema>;
export type DevServersState = z.output<typeof stateSchema>;

export const serverIdFor = (worktree: string) => `wt_${createHash("sha256").update(path.resolve(worktree)).digest("hex").slice(0, 12)}`;

export const openStateStore = (stateDir: string, onWarning?: (message: string) => void) =>
  createJsonStore<DevServersState>({
    file: path.join(stateDir, "state.json"),
    schema: stateSchema,
    empty: () => ({ version: STATE_VERSION, servers: {} }),
    onWarning,
  });

export type Deadline = { serverId: string; name: string; at: number };

export function nextDeadline(state: DevServersState): Deadline | null {
  let next: Deadline | null = null;
  for (const [serverId, server] of Object.entries(state.servers)) {
    for (const [name, iso] of Object.entries(server.deadlines)) {
      const at = Date.parse(iso);
      if (!next || at < next.at) next = { serverId, name, at };
    }
  }
  return next;
}
