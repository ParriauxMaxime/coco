import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { holderSchema, type ErrorCode, type Holder } from "../shared/contracts.ts";
import { ServiceError } from "./errors.ts";
import type { Caller, DevServersService } from "./service.ts";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  not_a_project_worktree: 422,
  needs_choice: 409,
  reason_required: 422,
  capacity_full: 409,
  port_unavailable: 503,
  external_readonly: 409,
  held_by_others: 409,
  start_failed: 500,
  not_ready: 409,
  forbidden_host: 403,
  forbidden_origin: 403,
  unsupported_media_type: 415,
  payload_too_large: 413,
  method_not_allowed: 405,
  internal: 500,
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BODY_BYTES = 64 * 1024;
const HTTP_HOLDER = holderSchema.extend({ kind: z.enum(["coco", "user"]) });
const DEFAULT_HOLDER: Holder = { kind: "user", id: "http" };

const hostnameOf = (value: string, withScheme: boolean) => {
  try {
    const url = new URL(withScheme ? value : `http://${value}`);
    return withScheme && url.protocol !== "http:" && url.protocol !== "https:" ? null : url.hostname;
  } catch {
    return null;
  }
};

// The Host check defeats DNS rebinding; the Origin check stops pages on other sites from driving the API through the browser.
function guard(req: http.IncomingMessage) {
  const host = req.headers.host;
  if (!host || !LOOPBACK.has(hostnameOf(host, false) ?? "")) throw new ServiceError("forbidden_host", `Host ${host ?? "(none)"} is not a loopback address`);
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK.has(hostnameOf(origin, true) ?? ""))
    throw new ServiceError("forbidden_origin", `Origin ${origin} is not a loopback origin`);
}

export async function readJsonText(req: http.IncomingMessage): Promise<string> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") throw new ServiceError("unsupported_media_type", "send the body as Content-Type: application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ServiceError("payload_too_large", `the body is over ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readJsonText(req);
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ServiceError("bad_request", `the body is not valid JSON: ${(error as Error).message}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ServiceError("bad_request", "the body must be a JSON object");
  return body as Record<string, unknown>;
}

const callerFrom = ({ holder, ...input }: Record<string, unknown>): [Caller, Record<string, unknown>] => {
  if (holder === undefined) return [{ holder: DEFAULT_HOLDER }, input];
  const parsed = HTTP_HOLDER.safeParse(holder);
  if (!parsed.success) throw new ServiceError("bad_request", `holder: ${z.prettifyError(parsed.error)}`);
  return [{ holder: parsed.data }, input];
};

type Request = { url: URL; body: () => Promise<Record<string, unknown>> };
type Route = { method: "GET" | "POST"; path: RegExp; run: (params: string[], request: Request) => Promise<unknown> };

const routesFor = (service: DevServersService): Route[] => [
  { method: "GET", path: /^\/healthz$/, run: async () => ({ ok: true }) },
  { method: "GET", path: /^\/api\/servers$/, run: async () => ({ servers: await service.list() }) },
  {
    method: "POST",
    path: /^\/api\/servers\/start$/,
    run: async (_, { body }) => {
      const [caller, input] = callerFrom(await body());
      return service.start(input, caller);
    },
  },
  { method: "GET", path: /^\/api\/servers\/([^/]+)$/, run: async ([id]) => ({ server: await service.get(id) }) },
  {
    method: "POST",
    path: /^\/api\/servers\/([^/]+)\/stop$/,
    run: async ([id], { body }) => {
      const [caller, input] = callerFrom(await body());
      return service.stop(id, input, caller);
    },
  },
  { method: "GET", path: /^\/api\/servers\/([^/]+)\/logs$/, run: async ([id], { url }) => service.logs(id, Object.fromEntries(url.searchParams)) },
];

export const send = (res: http.ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

export type HttpApi = { listen(): Promise<{ bind: string; port: number }>; close(): Promise<void> };

export type Mount = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export type HttpApiOptions = { service: DevServersService; bind: string; port: number; mounts?: Record<string, Mount> };

const MOUNTED = Symbol("mounted");

export function createHttpApi({ service, bind, port, mounts = {} }: HttpApiOptions): HttpApi {
  const routes = routesFor(service);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    guard(req);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const mount = Object.hasOwn(mounts, url.pathname) ? mounts[url.pathname] : undefined;
    if (mount) {
      await mount(req, res);
      return MOUNTED;
    }
    const matching = routes.flatMap((route) => {
      const match = route.path.exec(url.pathname);
      return match ? [{ route, params: match.slice(1) }] : [];
    });
    if (!matching.length) throw new ServiceError("not_found", `no route ${url.pathname}`);
    const hit = matching.find(({ route }) => route.method === req.method);
    if (!hit)
      throw new ServiceError("method_not_allowed", `${req.method} is not allowed on ${url.pathname}`, { allow: matching.map(({ route }) => route.method) });
    return hit.route.run(hit.params, { url, body: () => readJson(req) });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).then(
      (value) => void (value !== MOUNTED && send(res, 200, value)),
      (error: unknown) => {
        if (res.headersSent) return void res.end();
        if (error instanceof ServiceError) return send(res, STATUS[error.code], error.toBody());
        send(res, 500, { error: { code: "internal", message: error instanceof Error ? error.message : String(error) } });
      },
    );
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        if (!LOOPBACK.has(bind)) return reject(new Error(`api.bind ${bind} is not a loopback address; the API only listens on 127.0.0.1, ::1 or localhost`));
        server.once("error", reject);
        server.listen(port, bind, () => {
          server.off("error", reject);
          resolve({ bind, port: (server.address() as AddressInfo).port });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
