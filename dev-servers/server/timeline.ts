import { TIMELINE_KIND, type Holder, type LeaseView, type TimelineRow } from "../shared/contracts.ts";
import type { LostEntry } from "./leases.ts";
import { lostNotice } from "./mcp.ts";
import type { ServerRecord } from "./store.ts";

export type TimelineItem = { type: "plugin"; id: string; kind: string; version: number; data: TimelineRow };
export type AppendRow = (agentId: string, item: TimelineItem) => Promise<unknown>;

export type TimelineOptions = {
  holders: (serverId: string) => LeaseView[];
  agentOf: (holder: Holder) => string | null;
  urlOf: (record: ServerRecord) => string;
  // Null until the plugin has seen a Paseo session: rows are best effort, like Paseo's own events.
  append: () => AppendRow | null;
  onWarning?: (message: string) => void;
};

const item = (id: string, data: TimelineRow): TimelineItem => ({ type: "plugin", id, kind: TIMELINE_KIND, version: 1, data });

// Tells each agent holding a server when its build turns ready, and each agent that lost one why, as a row in its timeline.
export function createTimelineNotifier({ holders, agentOf, urlOf, append, onWarning = console.warn }: TimelineOptions) {
  const states = new Map<string, ServerRecord["state"]>();

  const send = (agentId: string, row: TimelineItem) => {
    const sink = append();
    if (!sink) return;
    sink(agentId, row).catch((error: unknown) =>
      onWarning(`timeline row for agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  return {
    serverChanged: (record: ServerRecord) => {
      const before = states.get(record.id);
      states.set(record.id, record.state);
      if (record.state !== "ready" || before !== "building" || record.prebuild) return;
      const data: TimelineRow = {
        event: "ready",
        serverId: record.id,
        worktree: record.worktree,
        url: urlOf(record),
        port: record.port,
        ...(record.buildSeconds !== undefined && { buildSeconds: record.buildSeconds }),
        at: new Date().toISOString(),
      };
      for (const { holder } of holders(record.id)) {
        const agentId = agentOf(holder);
        if (agentId) send(agentId, item(`dev-server-ready-${record.id}`, data));
      }
    },

    lost: (entries: LostEntry[]) => {
      for (const entry of entries) {
        const agentId = agentOf(entry.holder);
        if (!agentId) continue;
        const { worktree, why, at, message } = lostNotice(entry);
        send(agentId, item(`dev-server-lost-${entry.id}`, { event: "lost", serverId: entry.serverId, worktree, why, at, message }));
      }
    },
  };
}
