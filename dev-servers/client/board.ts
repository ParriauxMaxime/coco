import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { boardRpc, type ErrorCode, type RpcError } from "../shared/contracts.ts";

export const SCREEN_ID = "servers";
export const PANEL_ID = "dev-server";
export const QUERY_ROOT = "dev-servers";
export const BOARD_KEY = [QUERY_ROOT, "board"];

export class RpcFailure extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor({ code, message, details }: RpcError) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export const unwrap = <T>(outcome: Outcome<T>): T => {
  if (outcome.ok) return outcome.value;
  throw new RpcFailure(outcome.error);
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
