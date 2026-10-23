import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boardRpc, type ErrorCode, type RpcError } from "../shared/contracts.ts";

export const SCREEN_ID = "servers";
export const PANEL_ID = "dev-server";
export const QUERY_ROOT = "dev-servers";
export const BOARD_KEY = [QUERY_ROOT, "board"];

// No `class`: the mobile app's JS engine rejects class syntax in plugin bundles.
export type RpcFailure = Error & { code: ErrorCode; details?: Record<string, unknown> };

const rpcFailure = ({ code, message, details }: RpcError): RpcFailure => Object.assign(new Error(message), { code, details });

export const isRpcFailure = (failure: unknown, code?: ErrorCode): failure is RpcFailure =>
  failure instanceof Error && "code" in failure && (code === undefined || failure.code === code);

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export const unwrap = <T>(outcome: Outcome<T>): T => {
  if (outcome.ok) return outcome.value;
  throw rpcFailure(outcome.error);
};

export function useBoard(refetchInterval: number) {
  const board = useRpc(boardRpc);
  return useQuery({ queryKey: BOARD_KEY, queryFn: () => board({}), refetchInterval });
}

// Every action refreshes the board, the placement and the logs it may have changed.
export function useServerAction<Input, T>(call: (input: Input) => Promise<Outcome<T>>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Input) => unwrap(await call(input)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] }),
  });
}
