export const SERVER_STATES = ["prewarming", "building", "ready", "idle", "stopping", "stopped", "crashed", "external"] as const;
export type ServerState = (typeof SERVER_STATES)[number];

export type Tone = "success" | "warning" | "danger" | "muted" | "accent";

export const STATE_LABELS: Record<ServerState, string> = {
  prewarming: "prebuilding",
  building: "building",
  ready: "ready",
  idle: "idle",
  stopping: "stopping",
  stopped: "stopped",
  crashed: "crashed",
  external: "started by hand",
};

export const STATE_TONES: Record<ServerState, Tone> = {
  prewarming: "muted",
  building: "warning",
  ready: "success",
  idle: "accent",
  stopping: "warning",
  stopped: "muted",
  crashed: "danger",
  external: "accent",
};

export const SERVING_STATES: readonly ServerState[] = ["ready", "idle", "external"];
export const BUILDING_STATES: readonly ServerState[] = ["prewarming", "building"];
