import type { WorkAgent } from '../types.ts';

export type Run<T extends WorkAgent> = { chief: T; workers: T[] };

const isWorker = (a: WorkAgent) => Boolean(a.rootAgentId && a.agentId && a.rootAgentId !== a.agentId);

// the agents as runs, in their order: each worker folds under the chief its rootAgentId names; a worker whose chief is not in
// the list stands alone, and with no parent edge on any agent every agent is its own run
export function runsOf<T extends WorkAgent>(agents: T[]): Run<T>[] {
  const chiefs = new Set(agents.filter((a) => !isWorker(a)).map((a) => a.agentId));
  const folds = (a: T) => isWorker(a) && chiefs.has(a.rootAgentId ?? null);
  return agents.filter((a) => !folds(a)).map((chief) => ({ chief, workers: chief.agentId ? agents.filter((a) => folds(a) && a.rootAgentId === chief.agentId) : [] }));
}
