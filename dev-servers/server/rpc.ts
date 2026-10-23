import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  UI_HOLDER,
  type Board,
  type RpcError,
  type loginRpc,
  type logsRpc,
  type pinRpc,
  type placementRpc,
  type startRpc,
  type stopRpc,
} from "../shared/contracts.ts";
import { createPresenter, type BoardDeps } from "./board.ts";
import { ServiceError } from "./errors.ts";
import type { DevServersService } from "./service.ts";

export type RpcDeps = BoardDeps & { service: DevServersService };

export type RpcRuntime = { deps: RpcDeps | null; error: string | null };

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RpcError };

const UI_LOG_BYTES = 512 * 1024;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failure = (error: unknown): { ok: false; error: RpcError } =>
  error instanceof ServiceError
    ? { ok: false, error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) } }
    : { ok: false, error: { code: "internal", message: messageOf(error) } };

// The UI talks to the same service as HTTP and MCP; it only gets lease titles and agent ids, never the agents' lease keys.
export function createRpcHandlers(runtime: () => Promise<RpcRuntime>) {
  const run = async <T>(task: (deps: RpcDeps) => Promise<T>): Promise<Outcome<T>> => {
    const { deps, error } = await runtime();
    if (!deps) return { ok: false, error: { code: "internal", message: error ?? "the dev servers plugin is not running" } };
    try {
      return { ok: true, value: await task(deps) };
    } catch (caught) {
      return failure(caught);
    }
  };

  return {
    board: async (): Promise<Board> => {
      const { deps, error } = await runtime();
      if (!deps) return { error: error ?? "the dev servers plugin is not running", cap: null, servers: [], lost: [] };
      return createPresenter(deps).board(await deps.service.list());
    },

    placement: ({ cwd }: RpcInput<typeof placementRpc>): Promise<RpcOutput<typeof placementRpc>> =>
      run(async ({ service }) => {
        const { placement, server } = await service.placement({ cwd }, { holder: UI_HOLDER, cwd });
        return { placement, serverId: server?.id ?? null };
      }),

    start: ({ cwd, serveFrom, dedicated }: RpcInput<typeof startRpc>): Promise<RpcOutput<typeof startRpc>> =>
      run(async ({ service }) => {
        const result = await service.start({ cwd, ...(serveFrom && { serveFrom }), ...(dedicated && { dedicated }) }, { holder: UI_HOLDER, cwd });
        return { serverId: result.server.id, placement: result.placement, ...(result.evicted && { evicted: result.evicted }), next: result.next };
      }),

    stop: ({ id, force }: RpcInput<typeof stopRpc>): Promise<RpcOutput<typeof stopRpc>> =>
      run(async ({ service }) => {
        const { stopped, kept, note, next } = await service.stop(id, { force }, { holder: UI_HOLDER });
        return { stopped, ...(kept && { kept }), ...(note && { note }), next };
      }),

    pin: ({ id, pinned }: RpcInput<typeof pinRpc>): Promise<RpcOutput<typeof pinRpc>> =>
      run(async ({ service }) => ({ next: (await service.pin(id, { pinned }, { holder: UI_HOLDER })).next })),

    logs: ({ id, lines, source }: RpcInput<typeof logsRpc>): Promise<RpcOutput<typeof logsRpc>> =>
      run(({ service }) => service.logs(id, { lines, source }, { touch: false, maxBytes: UI_LOG_BYTES })),

    login: ({ id, path }: RpcInput<typeof loginRpc>): Promise<RpcOutput<typeof loginRpc>> => run(({ service }) => service.login(id, path ? { path } : {})),
  };
}

export type RpcHandlers = ReturnType<typeof createRpcHandlers>;
