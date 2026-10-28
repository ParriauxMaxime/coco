// What each coco agent cost: the size of its first prompt and system prompt, and the input tokens and cost Paseo reports, kept once Paseo forgets them;
// for any agent, how full its context window was at its last turn.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type PaseoUsage = { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalCostUsd?: number; contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };
export type AgentUsage = { promptChars?: number; promptTokens?: number; systemChars?: number; systemTokens?: number; inputTokens?: number; outputTokens?: number; costUsd?: number; contextTokens?: number; contextMax?: number; at: string };
export type UsageStore = ReturnType<typeof createAgentUsage>;

const KEEP = 3000;
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
export const promptSize = (text: string | null | undefined) => (text ? { promptChars: text.length, promptTokens: estimateTokens(text.length) } : {});
export const systemSize = (text: string | null | undefined) => (text ? { systemChars: text.length, systemTokens: estimateTokens(text.length) } : {});

// the context window is the last turn's, not a sum
export const contextOf = (u: PaseoUsage | null | undefined): Partial<AgentUsage> => (u?.contextWindowUsedTokens && u.contextWindowMaxTokens ? { contextTokens: u.contextWindowUsedTokens, contextMax: u.contextWindowMaxTokens } : {});

// Paseo's lastUsage is per agent and cumulative; cached reads count as input
export const fromPaseo = (u: PaseoUsage | null | undefined): Partial<AgentUsage> => {
  if (!u) return {};
  const input = (u.inputTokens || 0) + (u.cachedInputTokens || 0);
  return { ...(input ? { inputTokens: input } : {}), ...(u.outputTokens ? { outputTokens: u.outputTokens } : {}), ...(u.totalCostUsd ? { costUsd: u.totalCostUsd } : {}), ...contextOf(u) };
};

export function createAgentUsage(file: string) {
  const load = (): Record<string, AgentUsage> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  let cache: Record<string, AgentUsage> | null = null;
  const all = () => (cache ||= load());
  const save = (data: Record<string, AgentUsage>) => {
    const ids = Object.keys(data);
    if (ids.length > KEEP) for (const id of ids.sort((a, b) => data[a].at.localeCompare(data[b].at)).slice(0, ids.length - KEEP)) delete data[id];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  // onlyIfMissing keeps the first prompt's size when a later turn reports another one
  function record(agentId: string, patch: Partial<AgentUsage>, { onlyIfMissing = false } = {}) {
    const data = all();
    const was = data[agentId];
    const fresh = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'at' && (!onlyIfMissing || was?.[k as keyof AgentUsage] === undefined) && was?.[k as keyof AgentUsage] !== v));
    if (!Object.keys(fresh).length) return was ?? null;
    data[agentId] = { ...was, ...fresh, at: new Date().toISOString() };
    save(data);
    return data[agentId];
  }
  return { record, get: (agentId: string): AgentUsage | null => all()[agentId] ?? null };
}
