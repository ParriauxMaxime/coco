import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { holderSchema, type Holder, type LeaseView } from "../shared/contracts.ts";
import type { LeaseBook } from "./service.ts";
import { createJsonStore, type DevServersState, type JsonStore, type ServerRecord } from "./store.ts";

export type Clock = { now(): number; setTimeout(run: () => void, ms: number): { cancel(): void } };

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

const timestamp = z.iso.datetime({ offset: true });

const keyRecordSchema = z.object({
  cwd: z.string().nullable(),
  agentId: z.string().optional(),
  title: z.string().optional(),
  issuedAt: timestamp,
  lastUsedAt: timestamp,
});

const leaseRecordSchema = z.object({ serverId: z.string(), holder: holderSchema, since: timestamp, lastUsedAt: timestamp });

const leaseStateSchema = z.object({
  version: z.literal(1),
  keys: z.record(z.string(), keyRecordSchema).default({}),
  leases: z.record(z.string(), leaseRecordSchema).default({}),
});

export type KeyRecord = z.output<typeof keyRecordSchema>;
export type LeaseState = z.output<typeof leaseStateSchema>;

export const openLeaseStore = (stateDir: string, onWarning?: (message: string) => void) =>
  createJsonStore<LeaseState>({
    file: path.join(stateDir, "leases.json"),
    schema: leaseStateSchema,
    empty: () => ({ version: 1, keys: {}, leases: {} }),
    onWarning,
  });

export const KEY_PATTERN = /^dk_[A-Za-z0-9_-]{8,64}$/;
const PENDING_MS = 60_000;
const UNUSED_KEY_MS = 30 * 24 * 60 * 60_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const RUNNING: ServerRecord["state"][] = ["building", "ready", "idle", "crashed"];

export type LeaseManagerOptions = {
  store: JsonStore<LeaseState>;
  servers: JsonStore<DevServersState>;
  idleStopMinutes: number;
  leaseTtlMinutes: number;
  stopIdle: (serverId: string) => Promise<unknown>;
  clock?: Clock;
  onWarning?: (message: string) => void;
};

export type LeaseManager = {
  book: LeaseBook;
  issueKey(cwd: string, title?: string | null): Promise<string>;
  bindAgent(agent: { agentId: string; cwd: string; title?: string | null }): Promise<string | null>;
  key(key: string, cwdHint?: string | null): Promise<KeyRecord>;
  releaseAgent(agentId: string): Promise<string[]>;
  touch(holder: Holder): Promise<void>;
  heldBy(holder: Holder): string[];
  settle(serverId: string): Promise<void>;
  settleAll(): Promise<void>;
  flush(): Promise<void>;
  close(): void;
};

const sameHolder = (a: Holder, b: Holder) => a.kind === b.kind && a.id === b.id;
const newId = (prefix: string, bytes: number) => `${prefix}_${randomBytes(bytes).toString("base64url")}`;
const hasProcess = (record: ServerRecord | undefined) => Boolean(record?.process && RUNNING.includes(record.state));

export function createLeaseManager({
  store,
  servers,
  idleStopMinutes,
  leaseTtlMinutes,
  stopIdle,
  clock = systemClock,
  onWarning = console.warn,
}: LeaseManagerOptions): LeaseManager {
  const idleMs = idleStopMinutes * 60_000;
  const ttlMs = leaseTtlMinutes * 60_000;
  const pending: { key: string; cwd: string; at: number }[] = [];
  let timer: { cancel(): void } | null = null;
  let sweeping: Promise<void> | null = null;
  let again = false;
  let closed = false;

  const iso = (ms = clock.now()) => new Date(ms).toISOString();
  const normalize = (cwd: string) => path.resolve(cwd);
  const leasesOf = (state: LeaseState, serverId: string) => Object.entries(state.leases).filter(([, lease]) => lease.serverId === serverId);

  const titleOf = (holder: Holder) => {
    if (holder.kind !== "agent") return holder.title;
    const key = store.snapshot().keys[holder.id];
    return key?.title ?? (key?.agentId ? `agent ${key.agentId.slice(0, 8)}` : holder.title);
  };

  const idleDueAt = (record: ServerRecord) => Math.max(Date.parse(record.deadlines.idle ?? iso(0)), Date.parse(record.lastUsedAt) + idleMs);

  const reschedule = () => {
    timer?.cancel();
    timer = null;
    if (closed) return;
    let due = Infinity;
    for (const record of Object.values(servers.snapshot().servers)) if (record.deadlines.idle) due = Math.min(due, idleDueAt(record));
    for (const lease of Object.values(store.snapshot().leases)) due = Math.min(due, Date.parse(lease.lastUsedAt) + ttlMs);
    if (due === Infinity) return;
    timer = clock.setTimeout(() => void sweep(), Math.min(MAX_TIMER_MS, Math.max(0, due - clock.now())));
  };

  const settle = async (serverId: string) => {
    const record = servers.snapshot().servers[serverId];
    if (!hasProcess(record)) {
      await store.update((draft) => {
        for (const [id] of leasesOf(draft, serverId)) delete draft.leases[id];
      });
    }
    const leased = leasesOf(store.snapshot(), serverId).length > 0;
    await servers.update((draft) => {
      const current = draft.servers[serverId];
      if (!current) return;
      if (!hasProcess(current) || leased || current.pinned) delete current.deadlines.idle;
      if (!hasProcess(current)) return;
      const label = leased ? "ready" : "idle";
      if ((current.state === "ready" || current.state === "idle") && current.state !== label) {
        current.state = label;
        current.stateSince = iso();
      }
      if (!leased && !current.pinned && !current.deadlines.idle) current.deadlines.idle = iso(Math.max(clock.now(), Date.parse(current.lastUsedAt)) + idleMs);
    });
    reschedule();
  };

  const settleMany = async (ids: Iterable<string>) => {
    for (const id of new Set(ids)) await settle(id);
  };

  const sweepOnce = async () => {
    const now = clock.now();
    const expired = await store.update((draft) => {
      const ids: string[] = [];
      for (const [id, lease] of Object.entries(draft.leases)) {
        if (Date.parse(lease.lastUsedAt) + ttlMs <= now) {
          ids.push(lease.serverId);
          delete draft.leases[id];
        }
      }
      return ids;
    });
    await settleMany(expired);
    for (const record of Object.values(servers.snapshot().servers)) {
      if (!record.deadlines.idle || idleDueAt(record) > now) continue;
      try {
        await stopIdle(record.id);
      } catch (error) {
        onWarning(`idle stop of ${record.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        await servers.update((draft) => {
          const current = draft.servers[record.id];
          if (current?.deadlines.idle) current.deadlines.idle = iso(now + idleMs);
        });
      }
      await settle(record.id);
    }
    reschedule();
  };

  const sweep = (): Promise<void> => {
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      do {
        again = false;
        await sweepOnce().catch((error) => onWarning(`lease sweep failed: ${error instanceof Error ? error.message : String(error)}`));
      } while (again && !closed);
    })().finally(() => (sweeping = null));
    return sweeping;
  };

  const book: LeaseBook = {
    take: async (serverId, holder) => {
      const now = iso();
      const id = await store.update((draft) => {
        const found = leasesOf(draft, serverId).find(([, lease]) => sameHolder(lease.holder, holder));
        if (found) {
          found[1].lastUsedAt = now;
          return found[0];
        }
        const created = newId("ls", 6);
        draft.leases[created] = { serverId, holder, since: now, lastUsedAt: now };
        return created;
      });
      await settle(serverId);
      return { id };
    },
    release: async (serverId, holder) => {
      await store.update((draft) => {
        for (const [id, lease] of leasesOf(draft, serverId)) if (sameHolder(lease.holder, holder)) delete draft.leases[id];
      });
      await settle(serverId);
    },
    holders: (serverId): LeaseView[] =>
      leasesOf(store.snapshot(), serverId).map(([id, { holder, since, lastUsedAt }]) => {
        const title = titleOf(holder);
        return { id, holder: { kind: holder.kind, id: holder.id, ...(title && { title }) }, since, lastUsedAt };
      }),
  };

  return {
    book,

    issueKey: async (cwd, title) => {
      const key = newId("dk", 12);
      const now = iso();
      await store.update((draft) => {
        draft.keys[key] = { cwd: normalize(cwd), ...(title && { title }), issuedAt: now, lastUsedAt: now };
        for (const [id, record] of Object.entries(draft.keys)) {
          const used = Object.values(draft.leases).some((lease) => lease.holder.kind === "agent" && lease.holder.id === id);
          if (!used && Date.parse(record.lastUsedAt) + UNUSED_KEY_MS < clock.now()) delete draft.keys[id];
        }
      });
      pending.push({ key, cwd: normalize(cwd), at: clock.now() });
      return key;
    },

    bindAgent: async ({ agentId, cwd, title }) => {
      const bound = Object.entries(store.snapshot().keys).find(([, record]) => record.agentId === agentId)?.[0];
      let key = bound;
      if (!key) {
        while (pending.length && pending[0].at + PENDING_MS < clock.now()) pending.shift();
        const index = pending.findIndex((entry) => entry.cwd === normalize(cwd));
        if (index < 0) return null;
        key = pending.splice(index, 1)[0].key;
      }
      const chosen = key;
      await store.update((draft) => {
        const record = draft.keys[chosen];
        if (!record) return;
        record.agentId = agentId;
        if (title) record.title = title;
      });
      return chosen;
    },

    key: async (key, cwdHint) => {
      const now = iso();
      return store.update((draft) => {
        const record = draft.keys[key] ?? { cwd: cwdHint ? normalize(cwdHint) : null, issuedAt: now, lastUsedAt: now };
        if (!record.cwd && cwdHint) record.cwd = normalize(cwdHint);
        if (Date.parse(record.lastUsedAt) + 60_000 < clock.now()) record.lastUsedAt = now;
        draft.keys[key] = record;
        return record;
      });
    },

    releaseAgent: async (agentId) => {
      const affected = await store.update((draft) => {
        const keys = new Set(Object.entries(draft.keys).flatMap(([key, record]) => (record.agentId === agentId ? [key] : [])));
        const ids: string[] = [];
        for (const [id, lease] of Object.entries(draft.leases)) {
          if (lease.holder.kind === "agent" && keys.has(lease.holder.id)) {
            ids.push(lease.serverId);
            delete draft.leases[id];
          }
        }
        for (const key of keys) delete draft.keys[key];
        return ids;
      });
      await settleMany(affected);
      return [...new Set(affected)];
    },

    touch: async (holder) => {
      const now = iso();
      const touched = await store.update((draft) => {
        const ids: string[] = [];
        for (const lease of Object.values(draft.leases)) {
          if (!sameHolder(lease.holder, holder)) continue;
          lease.lastUsedAt = now;
          ids.push(lease.serverId);
        }
        return ids;
      });
      if (!touched.length) return;
      await servers.update((draft) => {
        for (const id of touched) if (draft.servers[id]) draft.servers[id].lastUsedAt = now;
      });
      reschedule();
    },

    heldBy: (holder) => [...new Set(Object.values(store.snapshot().leases).flatMap((lease) => (sameHolder(lease.holder, holder) ? [lease.serverId] : [])))],

    settle,

    settleAll: async () => {
      const known = new Set(Object.keys(servers.snapshot().servers));
      const orphans = await store.update((draft) => {
        let count = 0;
        for (const [id, lease] of Object.entries(draft.leases)) {
          if (known.has(lease.serverId)) continue;
          delete draft.leases[id];
          count += 1;
        }
        return count;
      });
      if (orphans) onWarning(`dropped ${orphans} lease(s) on servers that no longer exist`);
      await settleMany(known);
      await sweep();
    },

    flush: async () => {
      while (sweeping) await sweeping;
    },

    close: () => {
      closed = true;
      timer?.cancel();
      timer = null;
    },
  };
}
