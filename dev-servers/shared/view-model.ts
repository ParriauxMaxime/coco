import type { Board, BoardLost, BoardServer, LoginResult, Placement, TimelineRow } from "./contracts.ts";
import { BUILDING_STATES, SERVING_STATES, STATE_LABELS, STATE_TONES, type ServerState, type Tone } from "./states.ts";

export type Action = { visible: boolean; enabled: boolean; label: string; hint?: string };
export type StopAction = Action & { force: boolean; confirm: string };

const hidden: Action = { visible: false, enabled: false, label: "" };

export const baseName = (file: string) => file.split("/").filter(Boolean).at(-1) ?? file;
export const worktreeName = (server: Pick<BoardServer, "worktree">) => baseName(server.worktree.path);
export const stateLabel = (state: ServerState) => STATE_LABELS[state];
export const stateTone = (state: ServerState): Tone => STATE_TONES[state];

export function summarize(board: Board | undefined): string {
  if (!board) return "Dev servers";
  if (board.error) return "Dev servers · off";
  const running = board.servers.filter((server) => server.running).length;
  const count = (states: readonly ServerState[]) => board.servers.filter((server) => server.running && states.includes(server.state)).length;
  const building = count(BUILDING_STATES);
  const crashed = count(["crashed"]);
  const parts = [`Dev servers ${running}/${board.cap ?? "?"}`, building && `${building} building`, crashed && `${crashed} crashed`];
  return parts.filter(Boolean).join(" · ");
}

export function holdersText(server: Pick<BoardServer, "leases">): string {
  if (!server.leases.length) return "Nobody holds it";
  return `Held by ${server.leases.map(({ title }) => title).join(", ")}`;
}

export function optInsText({ optIns }: Pick<BoardServer, "optIns">): string | null {
  const parts = [optIns.services.length && `services ${optIns.services.join(", ")}`, optIns.dedicatedDb && "a dedicated database"].filter(Boolean);
  if (!parts.length) return null;
  return `With ${parts.join(" and ")}${optIns.reason ? `: ${optIns.reason}` : ""}`;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function clockTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return sameDay ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

export function idleText(server: Pick<BoardServer, "idleStopAt" | "pinned" | "state">, now = new Date()): string | null {
  if (!server.idleStopAt || server.pinned || server.state === "external") return null;
  return `Stops at ${clockTime(server.idleStopAt, now)} unless someone uses it`;
}

export function statusText(server: Pick<BoardServer, "state" | "progress" | "lastError" | "buildSeconds">): string | null {
  if (BUILDING_STATES.includes(server.state)) return server.progress ? `Building: ${server.progress}` : null;
  if (server.state === "crashed") return server.lastError ?? "Crashed; read the logs";
  if (server.state === "ready" && server.buildSeconds !== undefined) return `Built in ${server.buildSeconds} s`;
  return null;
}

export const pinnedText = (server: Pick<BoardServer, "pinned" | "pinnedBy">) =>
  server.pinned ? `Pinned${server.pinnedBy ? ` by ${server.pinnedBy}` : ""}` : null;

export function lostText(notice: BoardLost, now = new Date()): string {
  return `${notice.holder} lost it at ${clockTime(notice.at, now)}: ${notice.why}${notice.seen ? "" : " (not told yet)"}`;
}

export const lostFor = (board: Board, serverId: string) => board.lost.filter((notice) => notice.serverId === serverId);
export const orphanLost = (board: Board) => board.lost.filter((notice) => !board.servers.some((server) => server.id === notice.serverId));

export type ServerActions = { open: Action; login: Action; logs: Action; pin: Action; stop: StopAction | null };

export function serverActions(server: BoardServer): ServerActions {
  const serving = SERVING_STATES.includes(server.state);
  const external = server.state === "external";
  const notYet = `Waits until it is ready (now ${stateLabel(server.state)})`;
  return {
    open: { visible: true, enabled: serving, label: "Open", ...(!serving && { hint: notYet }) },
    login: server.canLogin ? { visible: true, enabled: serving, label: "Open logged in", ...(!serving && { hint: notYet }) } : hidden,
    logs: external ? hidden : { visible: true, enabled: true, label: "Logs" },
    pin: external || !server.running ? hidden : { visible: true, enabled: server.state !== "stopping", label: server.pinned ? "Unpin" : "Pin" },
    stop: external || !server.running || server.state === "stopping" ? null : stopAction(server),
  };
}

// A plain stop from the UI only releases the UI's own lease; with other holders or a pin, only a forced stop does anything.
function stopAction(server: BoardServer): StopAction {
  const name = worktreeName(server);
  const others = server.leases.filter((lease) => !lease.mine);
  const blockers = [others.length && `${others.map(({ title }) => title).join(", ")} will lose it`, server.pinned && "it is pinned"].filter(Boolean);
  if (blockers.length) {
    return {
      visible: true,
      enabled: true,
      force: true,
      label: "Force stop",
      confirm: `Force stop ${name} on port ${server.port}? ${capitalize(blockers.join(", and "))}.`,
    };
  }
  return { visible: true, enabled: true, force: false, label: "Stop", confirm: `Stop ${name} on port ${server.port}?` };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export const isUiLease = (lease: Pick<BoardServer["leases"][number], "mine">) => lease.mine;

const PLACEMENT_LABELS: Record<Placement["mode"], string> = {
  own: "Runs its own server",
  "stack-top": "Served by the top of its stack",
  "stack-running": "Served by a running server of its stack",
  dedicated: "Runs a dedicated server",
  external: "Served by a server started by hand",
};

export function placementText(placement: Placement, ownWorktree: string): string {
  const label = PLACEMENT_LABELS[placement.mode];
  return placement.servedFrom === ownWorktree ? label : `${label}: ${baseName(placement.servedFrom)}`;
}

export type PanelActions = { start: Action; dedicated: Action };

export function panelActions(placement: Placement | null, server: BoardServer | null, pending: boolean): PanelActions {
  const busy = pending ? { enabled: false, hint: "Starting; it waits for a slot when another server has to stop first" } : {};
  const running = Boolean(server?.running);
  const heldByUi = Boolean(server?.leases.some(isUiLease));
  const start: Action = placement
    ? { visible: !running || !heldByUi, enabled: true, label: pending ? "Starting…" : running ? "Use this server" : "Start", ...busy }
    : hidden;
  const elsewhere = placement?.mode === "stack-top" || placement?.mode === "stack-running";
  const dedicated: Action = elsewhere ? { visible: true, enabled: true, label: "Start dedicated", ...busy } : hidden;
  return { start, dedicated };
}

export function pillFor(servers: BoardServer[]): { label: string; title: string; tone: Tone } | null {
  if (!servers.length) return null;
  const describe = (server: BoardServer) => `${worktreeName(server)} ${stateLabel(server.state)} on port ${server.port}`;
  if (servers.length === 1) {
    const [server] = servers;
    return { label: `${stateLabel(server.state)} :${server.port}`, title: `Dev server: ${describe(server)}`, tone: stateTone(server.state) };
  }
  const worst = servers.find((server) => server.state === "crashed") ?? servers.find((server) => BUILDING_STATES.includes(server.state)) ?? servers[0];
  return { label: `${servers.length} dev servers`, title: `Dev servers: ${servers.map(describe).join("; ")}`, tone: stateTone(worst.state) };
}

export const serversOfAgent = (board: Board, agentId: string) => board.servers.filter((server) => server.leases.some((lease) => lease.agentId === agentId));

export type LoginSteps = { kind: "direct"; url: string; next: string } | { kind: "seed"; open: string; snippet: string; then: string; next: string };

export function loginSteps(result: LoginResult): LoginSteps {
  if (!result.apply) return { kind: "direct", url: result.url, next: result.next };
  const { open, script, then } = result.apply;
  return { kind: "seed", open, snippet: `${script} location.assign(${JSON.stringify(then)});`, then, next: result.next };
}

export function timelineText(row: TimelineRow, now = new Date()): { title: string; detail: string; tone: Tone } {
  const name = baseName(row.worktree);
  if (row.event === "ready") {
    const built = row.buildSeconds !== undefined ? `, built in ${row.buildSeconds} s` : "";
    return { title: `Dev server ready on :${row.port}`, detail: `${name} at ${row.url}${built}`, tone: "success" };
  }
  return { title: `Dev server for ${name} stopped at ${clockTime(row.at, now)}`, detail: row.message, tone: "warning" };
}
