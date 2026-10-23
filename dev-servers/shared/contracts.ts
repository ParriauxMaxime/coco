import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { SERVER_STATES } from "./states.ts";

export const ERROR_CODES = [
  "bad_request",
  "not_found",
  "not_a_project_worktree",
  "needs_choice",
  "reason_required",
  "capacity_full",
  "port_unavailable",
  "external_readonly",
  "held_by_others",
  "start_failed",
  "not_ready",
  "login_unavailable",
  "login_failed",
  "forbidden_host",
  "forbidden_origin",
  "unsupported_media_type",
  "payload_too_large",
  "method_not_allowed",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorBody = { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } };

export const holderSchema = z.strictObject({
  kind: z.enum(["agent", "coco", "user"]),
  id: z.string().min(1),
  title: z.string().optional(),
});
export type Holder = z.output<typeof holderSchema>;

export const holderName = (holder: Pick<Holder, "kind" | "id" | "title">) =>
  holder.title ?? (holder.kind === "agent" ? "an agent" : `${holder.kind} ${holder.id}`);

const absolutePath = z.string().refine((value) => value.startsWith("/"), "must be an absolute path");

export const startInputSchema = z.strictObject({
  cwd: absolutePath.optional().describe("Absolute path inside the worktree to serve; defaults to the caller's own worktree"),
  serveFrom: absolutePath.optional().describe("Worktree to serve from, one of placement.ambiguous.options from an earlier start"),
  dedicated: z.boolean().optional().describe("Run a server in the caller's own worktree even when another one could serve it"),
  services: z.array(z.string().min(1)).optional().describe("Background services to turn on (off by default); needs a reason"),
  dedicatedDb: z.boolean().optional().describe("Start with a database of its own; needs a reason"),
  reason: z.string().optional().describe("Why services or a dedicated database are needed; shown to everyone"),
  pin: z.boolean().optional().describe("Keep the server running when nobody uses it"),
  waitSeconds: z.number().min(0).max(50).default(0).describe("Wait up to this many seconds for the build to finish before answering"),
});
export type StartInput = z.input<typeof startInputSchema>;

export const stopInputSchema = z.strictObject({ force: z.boolean().default(false) });
export type StopInput = z.input<typeof stopInputSchema>;

export const pinInputSchema = z.strictObject({
  pinned: z.boolean().default(true).describe("true keeps the server running when nobody holds it and never stops it to make room; false undoes your pin"),
});
export type PinInput = z.input<typeof pinInputSchema>;

export const placementInputSchema = startInputSchema.pick({ cwd: true, serveFrom: true, dedicated: true, services: true, dedicatedDb: true, reason: true });
export type PlacementInput = z.input<typeof placementInputSchema>;

export const logsInputSchema = z.strictObject({
  lines: z.coerce.number().int().min(1).max(5000).default(100).describe("How many of the last lines to return"),
  grep: z.string().min(1).optional().describe("Case-insensitive regular expression the lines must match"),
  source: z.enum(["run", "app"]).default("run").describe("run: the server's own output; app: the app log when the project has one"),
});
export type LogsInput = z.input<typeof logsInputSchema>;

export const leaseViewSchema = z.object({ id: z.string(), holder: holderSchema, since: z.string(), lastUsedAt: z.string() });
export type LeaseView = z.output<typeof leaseViewSchema>;

export const serverViewSchema = z.object({
  id: z.string(),
  project: z.string(),
  worktree: z.object({ path: z.string(), branch: z.string().nullable(), head: z.string(), dirty: z.boolean() }),
  port: z.number(),
  url: z.string(),
  reserved: z.array(z.number()),
  state: z.enum(SERVER_STATES),
  stateSince: z.string(),
  progress: z.string().optional(),
  lastError: z.string().optional(),
  buildSeconds: z.number().optional(),
  pinned: z.boolean(),
  pinnedBy: holderSchema.optional(),
  optIns: z.object({ services: z.array(z.string()), dedicatedDb: z.boolean(), reason: z.string().nullable() }),
  leases: z.array(leaseViewSchema),
  lastUsedAt: z.string(),
  idleStopAt: z.string().optional(),
  logs: z.object({ run: z.string(), app: z.string().optional() }),
});
export type ServerView = z.output<typeof serverViewSchema>;

export const placementOptionSchema = z.object({ worktree: z.string(), branch: z.string().nullable(), head: z.string(), running: z.boolean() });
export type PlacementOption = z.output<typeof placementOptionSchema>;

export const placementSchema = z.object({
  mode: z.enum(["own", "stack-top", "stack-running", "dedicated", "external"]),
  servedFrom: z.string(),
  because: z.array(z.string()),
  ambiguous: z.object({ question: z.string(), options: z.array(placementOptionSchema) }).optional(),
});
export type Placement = z.output<typeof placementSchema>;

export const startResultSchema = z.object({
  server: serverViewSchema,
  placement: placementSchema,
  lease: z.object({ id: z.string() }).nullable(),
  evicted: z.array(z.object({ id: z.string(), worktree: z.string(), why: z.string() })).optional(),
  next: z.string(),
});
export type StartResult = z.output<typeof startResultSchema>;

export const stopResultSchema = z.object({
  server: serverViewSchema,
  stopped: z.boolean(),
  kept: z.enum(["leased", "pinned", "external"]).optional(),
  swept: z.array(z.number()),
  portsBusy: z.array(z.number()),
  note: z.string().optional(),
  next: z.string(),
});
export type StopResult = z.output<typeof stopResultSchema>;

export const pinResultSchema = z.object({ server: serverViewSchema, next: z.string() });
export type PinResult = z.output<typeof pinResultSchema>;

export const placementResultSchema = z.object({ placement: placementSchema, server: serverViewSchema.nullable() });
export type PlacementResult = z.output<typeof placementResultSchema>;

export const lostNoticeSchema = z.object({ id: z.string(), worktree: z.string(), why: z.string(), at: z.string(), message: z.string() });
export type LostNotice = z.output<typeof lostNoticeSchema>;

export const logsResultSchema = z.object({
  id: z.string(),
  source: z.enum(["run", "app"]),
  file: z.string(),
  lines: z.array(z.string()),
  truncated: z.boolean(),
});
export type LogsResult = z.output<typeof logsResultSchema>;

export const loginInputSchema = z.strictObject({
  user: z.string().min(1).optional().describe("Who to log in as, in the project's own terms (for example a user id); the project picks one when omitted"),
  path: z.string().startsWith("/").optional().describe("Page to open once logged in, as a path on the server; defaults to /"),
});
export type LoginInput = z.input<typeof loginInputSchema>;

export const loginSeedSchema = z.strictObject({
  storage: z.literal("localStorage"),
  origin: z.url({ protocol: /^https?$/ }),
  entries: z.record(z.string(), z.string()),
});
export type LoginSeed = z.output<typeof loginSeedSchema>;

export const loginUserSchema = z.looseObject({ id: z.string().min(1) });

export const loginResultSchema = z.object({
  id: z.string(),
  url: z.string(),
  user: loginUserSchema.optional(),
  expiresAt: z.string().optional(),
  seed: loginSeedSchema.optional(),
  apply: z.object({ open: z.string(), function: z.string(), script: z.string(), then: z.string() }).optional(),
  next: z.string(),
});
export type LoginResult = z.output<typeof loginResultSchema>;

export const DEFAULT_CONFIG_PATH = "~/cocopilot/coco.config.json";

export const pluginSettings = defineSettings({
  id: "dev-servers",
  scope: "host",
  version: 1,
  schema: z.object({
    configPath: z.string().trim().min(1).default(DEFAULT_CONFIG_PATH),
    apiPort: z.number().int().min(1).max(65535).nullable().default(null).describe("null: use devServers.api.port from the config"),
  }),
});

export const configStatusRpc = defineRpc({
  name: "config.status",
  input: z.object({}),
  output: z.object({
    configPath: z.string(),
    found: z.boolean(),
    error: z.string().nullable(),
    projects: z.array(z.string()),
    stateDir: z.string().nullable(),
    api: z.object({ bind: z.string(), port: z.number() }).nullable(),
  }),
});

export const UI_HOLDER: Holder = { kind: "user", id: "paseo", title: "you, in Paseo" };

export const rpcErrorSchema = z.object({ code: z.enum(ERROR_CODES), message: z.string(), details: z.record(z.string(), z.unknown()).optional() });
export type RpcError = z.output<typeof rpcErrorSchema>;

const outcome = <T extends z.ZodType>(value: T) =>
  z.union([z.object({ ok: z.literal(true), value }), z.object({ ok: z.literal(false), error: rpcErrorSchema })]);

export const boardLeaseSchema = z.object({
  id: z.string(),
  kind: holderSchema.shape.kind,
  holderId: z.string().nullable().describe("the holder's id for coco and user holders; null for agents, whose id is their secret lease key"),
  title: z.string(),
  agentId: z.string().nullable(),
  mine: z.boolean().describe("held by the caller: the Paseo UI on RPC, the agent on MCP, the request's holder on HTTP"),
  since: z.string(),
  lastUsedAt: z.string(),
});
export type BoardLease = z.output<typeof boardLeaseSchema>;

export const boardServerSchema = serverViewSchema.omit({ leases: true, pinnedBy: true }).extend({
  leases: z.array(boardLeaseSchema),
  pinnedBy: z.string().nullable(),
  running: z.boolean(),
  canLogin: z.boolean(),
});
export type BoardServer = z.output<typeof boardServerSchema>;

export const startReplySchema = startResultSchema.extend({ server: boardServerSchema });
export const stopReplySchema = stopResultSchema.extend({ server: boardServerSchema });
export const pinReplySchema = pinResultSchema.extend({ server: boardServerSchema });
export const placementReplySchema = placementResultSchema.extend({ server: boardServerSchema.nullable() });

export const boardLostSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  worktree: z.string(),
  why: z.string(),
  at: z.string(),
  holder: z.string(),
  agentId: z.string().nullable(),
  seen: z.boolean(),
});
export type BoardLost = z.output<typeof boardLostSchema>;

export const boardSchema = z.object({
  error: z.string().nullable(),
  cap: z.number().nullable(),
  servers: z.array(boardServerSchema),
  lost: z.array(boardLostSchema),
});
export type Board = z.output<typeof boardSchema>;

export const boardRpc = defineRpc({ name: "servers.board", input: z.object({}), output: boardSchema });

export const placementRpc = defineRpc({
  name: "servers.placement",
  input: z.object({ cwd: absolutePath }),
  output: outcome(z.object({ placement: placementSchema, serverId: z.string().nullable() })),
});

export const startRpc = defineRpc({
  name: "servers.start",
  input: z.object({ cwd: absolutePath, serveFrom: absolutePath.optional(), dedicated: z.boolean().optional() }),
  output: outcome(z.object({ serverId: z.string(), placement: placementSchema, evicted: startResultSchema.shape.evicted, next: z.string() })),
});

export const stopRpc = defineRpc({
  name: "servers.stop",
  input: z.object({ id: z.string().min(1), force: z.boolean().default(false) }),
  output: outcome(stopResultSchema.pick({ stopped: true, kept: true, note: true, next: true })),
});

export const pinRpc = defineRpc({
  name: "servers.pin",
  input: z.object({ id: z.string().min(1), pinned: z.boolean() }),
  output: outcome(z.object({ next: z.string() })),
});

export const logsRpc = defineRpc({
  name: "servers.logs",
  input: z.object({ id: z.string().min(1), lines: z.number().int().min(1).max(500).default(60), source: z.enum(["run", "app"]).default("run") }),
  output: outcome(logsResultSchema),
});

export const loginRpc = defineRpc({
  name: "servers.login",
  input: z.object({ id: z.string().min(1), path: loginInputSchema.shape.path }),
  output: outcome(loginResultSchema),
});

export const TIMELINE_KIND = "coco-dev-server";

export const timelineRowSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("ready"),
    serverId: z.string(),
    worktree: z.string(),
    url: z.string(),
    port: z.number(),
    buildSeconds: z.number().optional(),
    at: z.string(),
  }),
  z.object({ event: z.literal("lost"), serverId: z.string(), worktree: z.string(), why: z.string(), at: z.string(), message: z.string() }),
]);
export type TimelineRow = z.output<typeof timelineRowSchema>;
