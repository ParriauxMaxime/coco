// Per-PR checklist: the gates from self review to merge, each started as a skill in the PR agent, ticked by the user, or derived from GitHub and git.
// Push and ready for review have no button: cocopilot never pushes, it shows the command.
import { fileKey, isLocal, keyLabel, parseKey, rowKey } from './stack.ts';
import { skillFor } from './config.ts';
import type { Config } from './config.ts';
import { errorMessage, httpStatus } from './core-types.ts';
import type { GateRecord, PrInfo, ReadBody, Req, Res, ReviewAgentApi, Send, StackRow, Work } from './core-types.ts';

const SETTLE_MS = 15000;
const REMOTE_TTL_MS = 60000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type GateSkill = string | { name: string; ask?: string };

interface Gate {
  id: string;
  label: string;
  skills?: GateSkill[];
  tab?: string;
  command?: (r: { branch: string | null; number?: number | null }) => string;
}

interface GateFacts {
  pr?: Pick<PrInfo, 'number' | 'state' | 'isDraft'> | null;
  body?: string;
  tip?: string | null;
  remote?: string | null;
  plan?: { headSha?: string | null } | null;
  kitBody?: { maxChars?: number; mustMatch?: string };
}

interface ActInput {
  action?: string;
  reason?: string;
  skill?: string;
  args?: string;
}

interface GatesWorks {
  get(slug: string): Work | null;
  save(work: Work): unknown;
  prInfo(number: number | null | undefined): Promise<PrInfo>;
  prBody(number: number): Promise<string>;
}

// a gate skill is a skill name, or { name, ask } when the client asks for its argument
export const skillName = (s: GateSkill | null | undefined) => (typeof s === 'string' ? s : s?.name);

// skills per gate from config.gateSkills, one kit gate per config.kitKinds entry
export function gatesFor(config: Partial<Pick<Config, 'gateSkills' | 'kitKinds' | 'skillOverrides' | 'methodSkill'>> | null | undefined): Gate[] {
  const skills = (id: string): GateSkill[] => (config?.gateSkills?.[id] || []).map((s) => (typeof s === 'string' ? skillFor(config, s) : { ...s, name: skillFor(config, s.name) }));
  const kits = (config?.kitKinds || ['body', 'diagram', 'video']).map((k) => ({ id: `kit-${k}`, label: `kit: ${k}`, skills: skills(`kit-${k}`) }));
  return [
    { id: 'self-review', label: 'self review', skills: skills('self-review') },
    { id: 'fixes', label: 'fixes picked', tab: 'findings' },
    { id: 'manual-test', label: 'manual test' },
    { id: 'history', label: 'history tidy', skills: skills('history') },
    ...kits,
    { id: 'push', label: 'push', command: (r) => `git push --force-with-lease origin ${r.branch}` },
    { id: 'ready', label: 'ready for review', command: (r) => (r.number ? `gh pr ready ${r.number}` : 'gh pr create --draft (open the PR first)') },
    { id: 'review-pr', label: 'review-pr', skills: skills('review-pr') },
    { id: 'triage', label: 'triage', tab: 'findings' },
    { id: 'merged', label: 'merged' },
  ];
}

// what GitHub and git already say; null when they say nothing
export function derive(id: string, { pr, body, tip, remote, plan, kitBody = {} }: GateFacts): boolean | null {
  const opened = Boolean(pr?.number);
  if (id === 'merged') return opened ? pr?.state === 'MERGED' : null;
  if (id === 'ready') return opened ? !pr?.isDraft || pr?.state === 'MERGED' : null;
  if (id === 'push') return tip && remote ? tip === remote : null;
  if (id === 'kit-body') return opened && body ? (!kitBody.maxChars || body.length <= kitBody.maxChars) && (!kitBody.mustMatch || new RegExp(kitBody.mustMatch, 'i').test(body)) : null;
  if (id === 'kit-diagram') return opened && body ? /```mermaid/.test(body) : null;
  if (id === 'review-pr') return plan?.headSha && tip ? plan.headSha === tip : null;
  return null;
}

// the user's tick or skip wins, then a running skill, then what is derived
export function gateState(stored: Partial<GateRecord> | null | undefined, derived: boolean | null) {
  if (stored?.state === 'skipped' || stored?.state === 'done' || stored?.state === 'running') return stored.state;
  return derived ? 'done' : 'todo';
}

export function createGates({ config, works, reviewAgent, reviewPlan }: { config: Config; works: GatesWorks; reviewAgent: ReviewAgentApi; reviewPlan: { planOf(slug: string, n: number | string): GateFacts['plan'] } }) {
  const GATES = gatesFor(config);
  const remotes = new Map<number | string, { at: number; value: string | null }>();
  const remoteOf = async (n: number | string) => {
    const hit = remotes.get(n);
    if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.value;
    const value = await reviewAgent.remoteHead(n);
    remotes.set(n, { at: Date.now(), value });
    return value;
  };

  function rowOf(slug: string, raw: string) {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const n = parseKey(raw);
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (n === null || index < 0) throw new HttpError(404, `${raw} is not in this work`);
    return { work, n, index, row: work.stack[index] };
  }
  const saveGate = (slug: string, index: number, id: string, value: GateRecord | null) => {
    const w = works.get(slug);
    if (!w) return;
    const gates = { ...(w.stack[index].gates || {}) };
    if (value) gates[id] = value;
    else delete gates[id];
    w.stack[index] = { ...w.stack[index], gates };
    works.save(w);
  };

  // a running skill settles once its agent is no longer mid-turn
  async function settle(slug: string, index: number, row: StackRow) {
    const running = Object.entries(row.gates || {}).filter(([, g]) => g.state === 'running');
    if (!running.length) return;
    const agents = await reviewAgent.agentsList();
    for (const [id, g] of running) {
      const agent = agents.find((a) => a.id === g.agentId);
      if (Date.now() - Date.parse(g.at) < SETTLE_MS || agent?.status === 'running') continue;
      saveGate(slug, index, id, { ...g, state: 'done', at: new Date().toISOString() });
      reviewAgent.timeline(slug, 'gate', `${keyLabel(rowKey(row) ?? '')} ${id}: /${g.skill} finished (agent ${String(g.agentId || '').slice(0, 8)})`);
    }
  }

  async function view(slug: string, raw: string) {
    const first = rowOf(slug, raw);
    await settle(slug, first.index, first.row);
    const { n, row } = rowOf(slug, raw);
    const pr = row.number ? await works.prInfo(row.number) : null;
    const branch = pr?.head || row.planned?.branch || null;
    const [body, tip, remote] = await Promise.all([row.number ? works.prBody(row.number) : '', branch ? reviewAgent.branchSha(branch) : null, remoteOf(n)]);
    const facts: GateFacts = { pr, body, tip, remote, plan: reviewPlan.planOf(slug, n), kitBody: config.kitBody };
    const ctx = { branch, number: row.number };
    return {
      key: n,
      branch,
      gates: GATES.map((g) => {
        const stored = row.gates?.[g.id];
        const derived = derive(g.id, facts);
        return { id: g.id, label: g.label, skills: g.skills || [], tab: g.tab || null, command: g.command ? g.command(ctx) : null, state: gateState(stored, derived), derived, reason: stored?.reason || '', at: stored?.at || null, skill: stored?.skill || null, agentId: stored?.agentId || null };
      }),
    };
  }

  // run: the skill goes to the agent of the PR worktree (or a new one there); done, skipped and todo are the user's ticks
  async function act(slug: string, raw: string, id: string, { action, reason = '', skill, args = '' }: ActInput) {
    const { work, n, index } = rowOf(slug, raw);
    const gate = GATES.find((g) => g.id === id);
    if (!gate) throw new HttpError(404, 'no such gate');
    const at = new Date().toISOString();
    if (action === 'run') {
      const names = (gate.skills || []).map(skillName);
      if (!skill || !names.includes(skill)) throw new HttpError(400, `gate ${id} runs ${names.join(', ') || 'no skill'}`);
      const pr = await reviewAgent.rowPr(work, index);
      const runner = await reviewAgent.pickRunner(pr);
      const busy = runner.mode === 'send' && (await reviewAgent.agentsList()).find((a) => a.id === runner.agentId)?.status === 'running';
      if (busy) throw new HttpError(409, `agent ${String(runner.agentId).slice(0, 8)} is mid-turn in the PR worktree; wait for it`);
      const prompt = `/${skill} ${String(args).trim() || (isLocal(n) ? '' : n)}`.trim();
      const agentId = await reviewAgent.launch(runner, { title: `${gate.label} ${keyLabel(n)}`, provider: config.models.default, prompt, labels: { kind: 'gate', gate: id, work: slug, pr: fileKey(n) }, n, branch: pr.head });
      saveGate(slug, index, id, { state: 'running', at, skill, agentId });
      reviewAgent.timeline(slug, 'gate', `${keyLabel(n)} ${id}: started ${prompt} in ${runner.mode} agent ${String(agentId || '').slice(0, 8)}`);
    } else if (action && ['done', 'skipped', 'todo'].includes(action)) {
      if (action === 'skipped' && !reason.trim()) throw new HttpError(400, 'a skip needs a reason');
      saveGate(slug, index, id, action === 'todo' ? null : { state: action, at, reason: reason.trim() });
      reviewAgent.timeline(slug, 'gate', `${keyLabel(n)} ${id}: ${action}${reason.trim() ? ` (${reason.trim()})` : ''}`);
    } else throw new HttpError(400, 'action must be run, done, skipped or todo');
    return view(slug, raw);
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , raw, id] = parts;
      if (!raw) throw new HttpError(400, 'pr required');
      if (req.method === 'GET') return send(res, 200, await view(slug, decodeURIComponent(raw)));
      if (req.method === 'POST' && id) return send(res, 200, await act(slug, decodeURIComponent(raw), id, JSON.parse((await readBody(req)) || '{}')));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, view };
}
