export const SERVER_STATES = ["prewarming", "building", "ready", "idle", "stopping", "stopped", "crashed", "external"] as const;
export type ServerState = (typeof SERVER_STATES)[number];
