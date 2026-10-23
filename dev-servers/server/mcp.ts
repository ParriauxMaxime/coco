import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import { logsInputSchema, pinInputSchema, startInputSchema, type Holder, type LostNotice, type ServerView } from "../shared/contracts.ts";
import { ServiceError } from "./errors.ts";
import { toplevel } from "./git.ts";
import { readJsonText, type Mount } from "./http.ts";
import { KEY_PATTERN, type LeaseManager, type LostRecord } from "./leases.ts";
import { realPath } from "./proc.ts";
import { nextStep, type Caller, type DevServersService } from "./service.ts";
import { serverIdFor } from "./store.ts";

export const MCP_SERVER_NAME = "dev-servers";
export const MCP_PATH = "/mcp";
export const KEY_HEADER = "x-dev-servers-key";
export const CWD_HEADER = "x-dev-servers-cwd";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Dev servers for the worktree you work in. Call dev_server_start to get a server and its URL instead of starting one yourself: " +
  "the plugin picks a stable port, shares the server with other agents and stops it once nobody uses it. A build takes minutes: " +
  "follow the `next` hint and call dev_server_status until the state is ready. Call dev_server_stop when you are done.";

const idInput = z.string().min(1).optional().describe("Server id from dev_server_start or dev_server_status; defaults to the server you hold");

const statusInputSchema = z.strictObject({
  id: idInput,
  all: z.boolean().optional().describe("List every server the plugin runs, not only yours"),
});
const stopInputSchema = z.strictObject({ id: idInput });
const pinToolInputSchema = pinInputSchema.extend({ id: idInput });
const logsToolInputSchema = logsInputSchema.extend({ id: idInput });

const STALE_NEXT = "your worktree no longer matches this server (see stale.because): call dev_server_start again to get the right one";

export const lostNotice = ({ serverId, worktree, why, at }: LostRecord): LostNotice => ({
  id: serverId,
  worktree,
  why,
  at,
  message: `The dev server for ${worktree} that you held is gone (${why}). Call dev_server_start again if you still need one.`,
});

type ToolContext = { caller: Caller; holder: Holder };
type Tool = { description: string; input: z.ZodType; run: (args: unknown, context: ToolContext) => Promise<unknown> };

const inputSchemaOf = (schema: z.ZodType) => {
  const { $schema: _, ...json } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return json;
};

const parse = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new ServiceError("bad_request", z.prettifyError(result.error));
  return result.data;
};

const withNext = (server: ServerView) => ({ ...server, next: nextStep(server) });

export function createMcpTools(service: DevServersService, leases: LeaseManager): Record<string, Tool> {
  const ownServerId = async ({ cwd }: Caller) => {
    const worktree = cwd ? await toplevel(cwd) : null;
    return worktree ? serverIdFor(worktree) : null;
  };

  const pick = async (id: string | undefined, { caller, holder }: ToolContext) => {
    if (id) return id;
    const held = leases.heldBy(holder);
    if (held.length === 1) return held[0];
    if (held.length > 1) throw new ServiceError("bad_request", `you hold several servers; pass id, one of ${held.join(", ")}`, { ids: held });
    const own = await ownServerId(caller);
    if (!own) throw new ServiceError("not_found", "you hold no dev server and your directory is not a git worktree; call dev_server_start first");
    return own;
  };

  const getQuietly = (id: string) =>
    service.get(id).catch((error: unknown) => {
      if (error instanceof ServiceError && error.code === "not_found") return null;
      throw error;
    });

  // A lease on another worktree's server goes stale when the caller's worktree would no longer be served by it: uncommitted changes, a restack.
  const staleBecause = async (server: ServerView, { cwd }: Caller) => {
    const own = cwd ? await toplevel(cwd) : null;
    const from = realPath(server.worktree.path);
    if (!own || realPath(own) === from) return null;
    const preview = await service.placement({ cwd: own, serveFrom: server.worktree.path }, { holder: { kind: "user", id: "stale-check" } }).catch(() => null);
    return preview && realPath(preview.placement.servedFrom) !== from ? preview.placement.because : null;
  };

  const describe = async (server: ServerView, { caller, holder }: ToolContext) => {
    if (!leases.heldBy(holder).includes(server.id)) return withNext(server);
    const because = await staleBecause(server, caller);
    return because ? { ...server, stale: { because }, next: STALE_NEXT } : withNext(server);
  };

  return {
    dev_server_start: {
      description:
        "Get a dev server for your worktree and hold it until you stop or are archived: the server of your stack's top when it contains your commit, " +
        "else your worktree's own; a running one is reused. Returns the server (url, state, port), how it was placed and why, and `next`: what to do now. " +
        "When placement.ambiguous is set, pick one of its options with serveFrom. It answers at once while the server builds; " +
        "call dev_server_status to follow the build. Background services and a dedicated database are off unless you ask with a reason. " +
        "Only a few servers run at once: a new one stops the least recently used unpinned server (listed in evicted), and capacity_full means every slot is pinned or started by hand.",
      input: startInputSchema,
      run: (args, { caller }) => service.start((args ?? {}) as Record<string, unknown>, caller),
    },
    dev_server_status: {
      description:
        "State of your dev server: building (with progress), ready, idle, crashed (with the last error), stopped or external (started by hand), its url and `next`. " +
        "Without id it shows the servers you hold, else the server of your worktree; all lists every server. " +
        "A server you hold is marked stale when your worktree changed so that it should run elsewhere.",
      input: statusInputSchema,
      run: async (args, context) => {
        const { id, all } = parse(statusInputSchema, args);
        if (all) return { servers: (await service.list()).map(withNext) };
        if (id) return { servers: [await describe(await service.get(id), context)] };
        const held = leases.heldBy(context.holder);
        const ids = held.length ? held : [await ownServerId(context.caller)].filter((value): value is string => Boolean(value));
        const found = (await Promise.all(ids.map(getQuietly))).filter((server): server is ServerView => server !== null);
        const servers = await Promise.all(found.map((server) => describe(server, context)));
        return servers.length ? { servers } : { servers, next: "no dev server for your worktree yet; call dev_server_start" };
      },
    },
    dev_server_stop: {
      description:
        "Let go of your dev server. It stops only when nobody else holds it and it is not pinned; otherwise it keeps running for the others. " +
        "A server nobody holds also stops by itself after an idle delay.",
      input: stopInputSchema,
      run: async (args, context) => {
        const { id } = parse(stopInputSchema, args);
        return service.stop(await pick(id, context), {}, context.caller);
      },
    },
    dev_server_pin: {
      description:
        "Pin your dev server so it keeps running when nobody holds it and is never stopped to make room for another one; pinned: false undoes your own pin. " +
        "Pin only while you need the server across a long pause: pinned servers take one of the few server slots.",
      input: pinToolInputSchema,
      run: async (args, context) => {
        const { id, ...input } = parse(pinToolInputSchema, args);
        return service.pin(await pick(id, context), input, context.caller);
      },
    },
    dev_server_logs: {
      description: "Last lines of your dev server's output, optionally filtered by a regular expression. Read them when it crashed or misbehaves.",
      input: logsToolInputSchema,
      run: async (args, context) => {
        const { id, ...input } = parse(logsToolInputSchema, args);
        return service.logs(await pick(id, context), input);
      },
    },
  };
}

export const MCP_TOOL_NAMES = ["dev_server_start", "dev_server_status", "dev_server_stop", "dev_server_pin", "dev_server_logs"] as const;

type JsonRpcId = string | number | null;
type Incoming = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError && { isError }) });

const headerOf = (req: http.IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const cwdHintOf = (req: http.IncomingMessage) => {
  const raw = headerOf(req, CWD_HEADER);
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return path.isAbsolute(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

export function createMcpHandler({ service, leases, version = "0.0.0" }: { service: DevServersService; leases: LeaseManager; version?: string }): Mount {
  const tools = createMcpTools(service, leases);
  const listing = Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: inputSchemaOf(tool.input) }));

  const callTool = async (req: http.IncomingMessage, params: unknown) => {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof name === "string" && Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (!tool) return null;
    const key = headerOf(req, KEY_HEADER);
    if (!key || !KEY_PATTERN.test(key)) {
      return text(
        { error: { code: "bad_request", message: `missing or malformed ${KEY_HEADER} header: this endpoint serves agents the plugin set up` } },
        true,
      );
    }
    try {
      const record = await leases.key(key, cwdHintOf(req));
      const holder: Holder = { kind: "agent", id: key, ...(record.title && { title: record.title }) };
      await leases.touch(holder);
      const result = await tool.run(args, { holder, caller: { holder, ...(record.cwd && { cwd: record.cwd }) } });
      const lost = await leases.takeLost(holder);
      return text(lost.length ? { ...(result as object), lost: lost.map(lostNotice) } : result);
    } catch (error) {
      if (error instanceof ServiceError) return text(error.toBody(), true);
      return text({ error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }, true);
    }
  };

  const answer = async (req: http.IncomingMessage, message: Incoming): Promise<object | null> => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request");
    const id = message.id ?? null;
    if (typeof message.method !== "string") return "result" in message || "error" in message ? null : rpcError(id, -32600, "Invalid Request");
    if (message.id === undefined) return null;
    switch (message.method) {
      case "initialize": {
        const requested = (message.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listing });
      case "tools/call": {
        const result = await callTool(req, message.params);
        return result ? rpcResult(id, result) : rpcError(id, -32602, `unknown tool ${(message.params as { name?: unknown } | undefined)?.name}`);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  };

  const reply = (res: http.ServerResponse, status: number, value?: unknown) => {
    const body = value === undefined ? "" : JSON.stringify(value);
    res.writeHead(status, {
      ...(body && { "content-type": "application/json; charset=utf-8" }),
      "cache-control": "no-store",
      ...(status === 405 && { allow: "POST" }),
    });
    res.end(body);
  };

  return async (req, res) => {
    if (req.method !== "POST") return reply(res, 405);
    const raw = await readJsonText(req);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(res, 400, rpcError(null, -32700, "Parse error"));
    }
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map((message) => answer(req, message as Incoming)))).filter(Boolean);
      return answers.length ? reply(res, 200, answers) : reply(res, 202);
    }
    const single = await answer(req, body as Incoming);
    return single ? reply(res, 200, single) : reply(res, 202);
  };
}
