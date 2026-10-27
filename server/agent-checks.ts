// The code-writing agents coco starts on a PR branch (dispatch with edits, fix runs, stack fix, gate skills): their worktree readied before each turn,
// remembered by agent id so a follow-up or a coco restart finds it again.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentWorktrees } from './agent-worktree.ts';
import type { Readier } from './review-agent.ts';
import type { RowKey } from './core-types.ts';

type Tracked = { cwd: string; slug?: string; key?: RowKey | null; briefed?: string; at: string };

export function createAgentChecks({ DATA, worktrees }: { DATA: string; worktrees: Pick<AgentWorktrees, 'prepare' | 'whenReady' | 'briefLines'> }) {
  const file = path.join(DATA, 'agent-worktrees.json');
  const load = (): Record<string, Tracked> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const save = (agentId: string, t: Tracked) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...load(), [agentId]: t }, null, 1));
  };

  const linesOf = async (cwd: string, agentId?: string) => {
    const r = await worktrees.prepare(cwd);
    if (agentId && r.state !== 'ready' && r.state !== 'off') worktrees.whenReady(cwd, agentId);
    return worktrees.briefLines(r);
  };

  const readier: Readier = {
    ready: (cwd) => linesOf(cwd),
    started(agentId, cwd, meta) {
      linesOf(cwd, agentId)
        .then((lines) => save(agentId, { cwd, ...meta, briefed: lines.join('\n'), at: new Date().toISOString() }))
        .catch(() => {});
    },
  };

  // a new turn of a tracked agent: the worktree readied again, its section only when it changed since the agent last read it
  async function beforeTurn(agentId: string) {
    const t = load()[agentId];
    if (!t) return [];
    const lines = await linesOf(t.cwd, agentId);
    const said = lines.join('\n');
    if (said === t.briefed) return [];
    save(agentId, { ...t, briefed: said });
    return lines;
  }

  return { readier, beforeTurn, tracked: (agentId: string) => load()[agentId] ?? null };
}
