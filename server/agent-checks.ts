// The code-writing agents coco starts on a PR branch (dispatch with edits, fix runs, stack fix, gate skills): their worktree readied before each turn,
// and their commits checked when a turn ends (a card in the agent's chat, the PR's Gates rail, a failure sent back once); remembered by agent id across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { failureText } from './agent-worktree.ts';
import { keyLabel, rowKey } from './stack.ts';
import type { Jobs } from './jobs.ts';
import type { AgentWorktrees, Verification } from './agent-worktree.ts';
import type { Readier } from './review-agent.ts';
import type { AgentCheck, RowKey, Work } from './core-types.ts';

// base: HEAD when coco started the agent; sentBack: a failure already went back since the last pass or owner message
type Tracked = { cwd: string; slug?: string; key?: RowKey | null; briefed?: string; at: string; base?: string | null; checkedHead?: string; sentBack?: boolean; last?: Verification };
type Deps = {
  DATA: string;
  worktrees: Pick<AgentWorktrees, 'prepare' | 'whenReady' | 'briefLines'> & Partial<Pick<AgentWorktrees, 'verify' | 'head'>>;
  post?: (agentId: string, title: string, blocks: Record<string, unknown>[]) => Promise<unknown>;
  say?: (agentId: string, text: string) => Promise<unknown>;
  works?: { get(slug: string): Work | null; save(w: Work, opts?: { touch?: boolean }): unknown };
  jobs?: Pick<Jobs, 'wrap'>;
};

const TONE = { passed: 'ok', failed: 'risk', skipped: 'mute' } as const;

// the card coco posts in the agent's chat with its run of the checks
export function checksBlocks(v: Verification): Record<string, unknown>[] {
  if (v.state === 'unavailable') return [{ type: 'callout', tone: 'warn', title: 'Checks unavailable', text: v.why || 'the worktree is not ready' }];
  return [
    { type: 'table', columns: ['Check', 'Result'], rows: v.results.map((x) => [x.label, { text: x.state === 'skipped' ? `skipped: ${x.why}` : x.state, tone: TONE[x.state] }]) },
    ...v.results.filter((x) => x.state === 'failed').slice(0, 4).map((x) => ({ type: 'code', lang: 'text', code: x.output || '(no output)', caption: `${x.label}: ${x.command}`.slice(0, 200) })),
  ];
}

export function createAgentChecks({ DATA, worktrees, post, say, works, jobs }: Deps) {
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
      Promise.all([linesOf(cwd, agentId), worktrees.head?.(cwd) ?? null])
        .then(([lines, base]) => {
          const prior = load()[agentId];
          save(agentId, { cwd, ...meta, briefed: lines.join('\n'), at: new Date().toISOString(), base: prior?.cwd === cwd ? prior.base : base });
        })
        .catch(() => {});
    },
  };

  // a new turn of a tracked agent: the worktree readied again, its section only when it changed since the agent last read it
  async function beforeTurn(agentId: string) {
    const t = load()[agentId];
    if (!t) return [];
    const lines = await linesOf(t.cwd, agentId);
    const said = lines.join('\n');
    save(agentId, { ...t, sentBack: false, ...(said === t.briefed ? {} : { briefed: said }) });
    return said === t.briefed ? [] : lines;
  }

  const recordOnRow = (agentId: string, t: Tracked, v: Verification) => {
    const w = t.slug ? works?.get(t.slug) : null;
    if (!w || t.key == null) return;
    const record: AgentCheck = { state: v.state, at: v.at, head: v.head, agentId, results: v.results.map(({ label, state, why }) => ({ label, state, ...(why ? { why } : {}) })), ...(v.why ? { why: v.why } : {}) };
    w.stack = (w.stack || []).map((s) => (rowKey(s) === t.key ? { ...s, agentChecks: record } : s));
    works?.save(w, { touch: false });
  };

  // a turn ended: coco checks what the agent committed since it started, once per new head
  const running = new Set<string>();
  async function turnEnded(agentId: string) {
    const t = load()[agentId];
    if (!t?.base || !worktrees.verify || !worktrees.head || running.has(agentId)) return null;
    const head = await worktrees.head(t.cwd);
    if (!head || head === t.base || head === t.checkedHead) return null;
    running.add(agentId);
    try {
      const verify = worktrees.verify;
      const check = () => verify(t.cwd, { base: t.base ?? '', head });
      const label = `Checks on ${head.slice(0, 7)}${t.key != null ? ` ${keyLabel(t.key)}` : ''}`;
      // a failed check run is a finished job: its state is in the checks card, not a job failure
      const v = jobs ? await jobs.wrap({ work: t.slug ?? null, pr: t.key ?? null, action: `verify:${agentId}`, label, kind: 'command' }, check, (r) => r?.state ?? 'skipped') : await check();
      if (!v) return null;
      const sendBack = v.state === 'failed' && !t.sentBack;
      save(agentId, { ...load()[agentId], checkedHead: head, last: v, sentBack: v.state === 'failed' ? true : v.state === 'passed' ? false : t.sentBack });
      recordOnRow(agentId, t, v);
      await post?.(agentId, `coco checks on ${head.slice(0, 7)}: ${v.state}`, checksBlocks(v)).catch(() => {});
      if (sendBack) await say?.(agentId, failureText(v, 'your commits')).catch(() => {});
      return v;
    } finally {
      running.delete(agentId);
    }
  }

  // after a coco restart: the worktrees of live code-writing agents readied again, so an install the restart cut short starts over and its agent hears when done
  async function resume(others: { cwd: string; agentId: string }[] = []) {
    const all = [...Object.entries(load()).map(([agentId, t]) => ({ cwd: t.cwd, agentId })), ...others];
    for (const { cwd, agentId } of all) if (fs.existsSync(cwd)) await linesOf(cwd, agentId).catch(() => []);
  }

  return { readier, beforeTurn, turnEnded, resume, tracked: (agentId: string) => load()[agentId] ?? null };
}
