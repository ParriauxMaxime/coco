// Per-PR milestones, in order: self-reviewed, kit, pushed, ready, approved, merged. Each is derived from git, GitHub, the findings and the kit;
// a tick or a skip of the owner wins. Self-review skills run in the PR agent; ready runs `gh pr ready` once the first three are cleared.
import fs from 'node:fs';
import path from 'node:path';
import { fileKey, isLocal, keyLabel, parseKey, rowKey } from './stack.ts';
import { skillFor } from './config.ts';
import { sameSha } from './kit.ts';
import { cacheFile, swrCache } from './swr.ts';
import type { Config } from './config.ts';
import { conflictBody } from './jobs.ts';
import type { Jobs } from './jobs.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Comment, GateRecord, PrInfo, ReadBody, Req, Res, ReviewAgentApi, RowKey, Send, StackRow, Work } from './core-types.ts';

const SETTLE_MS = 15000;
const REMOTE_TTL_MS = 60000;
const CORE_KIT = ['body', 'diagram', 'video'];
const CLEARED = ['done', 'skipped'];
const KIT_READY = ['fresh', 'present'];
const REVIEW_RUNS = ['self-review', 'review-pr'];
const RUN_LABEL: Record<string, string> = { 'self-review': 'self review', 'review-pr': 'review-pr', history: 'tidy history' };

type GateSkill = string | { name: string; ask?: string };
type SkillConfig = Partial<Pick<Config, 'gateSkills' | 'kitKinds' | 'skillOverrides' | 'methodSkill'>> | null | undefined;

interface Gate {
  id: string;
  label: string;
  skills?: GateSkill[];
  tab?: string;
}

export interface GateFacts {
  pr?: Pick<PrInfo, 'number' | 'state' | 'isDraft' | 'reviewDecision' | 'unresolvedThreads'> | null;
  body?: string;
  tip?: string | null;
  remote?: string | null;
  // a review skill or a persona review ran at the head
  reviewed?: boolean;
  openFindings?: number;
  // the kit pieces in scope
  kit?: { id: string; state: string }[] | null;
  kitBody?: { maxChars?: number; mustMatch?: string };
}

export type RowMilestone = { key: RowKey; current: string | null; done: number };

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
  dropPr?(n: number): void;
}

type Deps = {
  DATA?: string;
  config: Config;
  works: GatesWorks;
  reviewAgent: ReviewAgentApi;
  kit: { view(slug: string, key: string): Promise<{ pieces: { id: string; state: string; expected?: boolean }[] }> };
  comments: { list(slug: string, key: RowKey): { comments?: Pick<Comment, 'author' | 'sha'>[] } };
  findings: { snapshot(slug: string, only: RowKey | null): { rows: { n: RowKey | null; status?: string }[] } | null };
  agents?: { archiveWhenDone(agentId: string): Promise<boolean> };
  jobs?: Pick<Jobs, 'start'>;
};

// a gate skill is a skill name, or { name, ask } when the client asks for its argument
export const skillName = (s: GateSkill | null | undefined) => (typeof s === 'string' ? s : s?.name);
const skillsOf = (config: SkillConfig, id: string): GateSkill[] => (config?.gateSkills?.[id] || []).map((s) => (typeof s === 'string' ? skillFor(config, s) : { ...s, name: skillFor(config, s.name) }));

// every configured skill run by config.gateSkills key (self review, review-pr, history, one per kit kind), for the Agent menu and the kit box
export function skillRuns(config: SkillConfig) {
  const kinds = config?.kitKinds || CORE_KIT;
  const ids = [...new Set([...REVIEW_RUNS, 'history', ...kinds.map((k) => `kit-${k}`), ...Object.keys(config?.gateSkills || {})])];
  return ids.map((id) => ({ id, label: RUN_LABEL[id] || id.replace(/^kit-/, 'kit: '), skills: skillsOf(config, id) })).filter((r) => r.skills.length);
}
export const runSkill = (config: SkillConfig, id: string) => skillName(skillsOf(config, id)[0]);

export function gatesFor(config: SkillConfig): Gate[] {
  return [
    { id: 'self-review', label: 'self-reviewed', skills: REVIEW_RUNS.flatMap((id) => skillsOf(config, id)), tab: 'findings' },
    { id: 'kit', label: 'kit' },
    { id: 'pushed', label: 'pushed' },
    { id: 'ready', label: 'ready' },
    { id: 'approved', label: 'approved', tab: 'review' },
    { id: 'merged', label: 'merged' },
  ];
}

const bodyOk = ({ body = '', kit, kitBody = {} }: GateFacts) => !kit?.some((p) => p.id === 'body') || ((!kitBody.maxChars || body.length <= kitBody.maxChars) && (!kitBody.mustMatch || new RegExp(kitBody.mustMatch, 'i').test(body)));

// what git, GitHub, the findings and the kit say; null when they say nothing
export function derive(id: string, f: GateFacts): boolean | null {
  const opened = Boolean(f.pr?.number);
  const merged = f.pr?.state === 'MERGED';
  if (id === 'self-review') return f.reviewed === undefined ? null : f.reviewed && !f.openFindings;
  if (id === 'kit') return f.kit ? f.kit.every((p) => KIT_READY.includes(p.state)) && bodyOk(f) : null;
  if (id === 'pushed') return f.remote ? !f.tip || sameSha(f.tip, f.remote) : null;
  if (id === 'ready') return opened ? !f.pr?.isDraft || merged : null;
  if (id === 'approved') return opened ? merged || (f.pr?.reviewDecision === 'APPROVED' && !f.pr?.unresolvedThreads) : null;
  if (id === 'merged') return opened ? merged : null;
  return null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// why a derived milestone is not done yet
export function detail(id: string, f: GateFacts): string {
  if (id === 'self-review') return f.reviewed === false ? 'no review at this head' : f.openFindings ? plural(f.openFindings, 'open finding') : '';
  if (id === 'kit') return [...(f.kit || []).filter((p) => !KIT_READY.includes(p.state)).map((p) => `${p.id} ${p.state}`), ...(bodyOk(f) ? [] : ['body breaks the kit rules'])].join(', ');
  if (id === 'pushed') return derive(id, f) === false ? 'local head differs from GitHub' : '';
  if (id === 'approved' && derive(id, f) === false) return f.pr?.unresolvedThreads ? plural(f.pr.unresolvedThreads, 'thread') : 'not approved';
  return '';
}

// a tick or a skip of the owner wins, then a running skill; a finished skill run is a fact for derive, not a tick
export function gateState(stored: Partial<GateRecord> | null | undefined, derived: boolean | null) {
  if (stored?.state === 'running') return 'running';
  if (!stored?.skill && (stored?.state === 'skipped' || stored?.state === 'done')) return stored.state;
  return derived ? 'done' : 'todo';
}

export function createGates({ DATA, config, works, reviewAgent, kit, comments, findings, agents, jobs }: Deps) {
  const GATES = gatesFor(config);
  const GH = config.repo.github || '';
  const remotes = swrCache<string | null>(REMOTE_TTL_MS, cacheFile(DATA, 'remote-heads'));
  const remoteOf = (n: number | string) => remotes(String(n), () => reviewAgent.remoteHead(n));
  // each work's rows and their current milestone, as last computed: the sidebar reads it without computing
  const summaryFile = cacheFile(DATA, 'milestones');
  let summaries: Record<string, RowMilestone[]> | null = null;
  const allSummaries = () => {
    if (summaries) return summaries;
    try {
      summaries = summaryFile ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : {};
    } catch {
      summaries = {};
    }
    return summaries || {};
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

  // a running skill settles once its agent is no longer mid-turn, on the head it left
  async function settle(slug: string, index: number, row: StackRow, head: string | null) {
    const running = Object.entries(row.gates || {}).filter(([, g]) => g.state === 'running');
    if (!running.length) return;
    const agents = await reviewAgent.agentsList();
    for (const [id, g] of running) {
      const agent = agents.find((a) => a.id === g.agentId);
      if (Date.now() - Date.parse(g.at) < SETTLE_MS || agent?.status === 'running') continue;
      saveGate(slug, index, id, { ...g, state: 'done', at: new Date().toISOString(), sha: head });
      reviewAgent.timeline(slug, 'gate', `${keyLabel(rowKey(row) ?? '')} ${id}: /${g.skill} finished (agent ${String(g.agentId || '').slice(0, 8)})`);
    }
  }

  function reviewedAt(slug: string, n: RowKey, row: StackRow, head: string | null) {
    if (!head) return undefined;
    const ran = REVIEW_RUNS.some((id) => {
      const g = row.gates?.[id];
      return Boolean(g?.skill) && g?.state === 'done' && sameSha(g.sha, head);
    });
    return ran || (comments.list(slug, n).comments || []).some((c) => c.author?.startsWith('as-') && sameSha(c.sha, head));
  }
  const openFindings = (slug: string, n: RowKey) => (findings.snapshot(slug, null)?.rows || []).filter((r) => String(r.n) === String(n) && r.status === 'open').length;

  async function view(slug: string, raw: string) {
    const first = rowOf(slug, raw);
    const pr = first.row.number ? await works.prInfo(first.row.number) : null;
    const branch = pr?.head || first.row.planned?.branch || null;
    const [body, tip, remote, pieces] = await Promise.all([
      first.row.number ? works.prBody(first.row.number) : '',
      branch ? reviewAgent.branchSha(branch) : null,
      remoteOf(first.n),
      kit.view(slug, String(first.n)).then((k) => k.pieces, () => null),
    ]);
    await settle(slug, first.index, first.row, tip || remote);
    const { n, row } = rowOf(slug, raw);
    const facts: GateFacts = { pr, body, tip, remote, reviewed: reviewedAt(slug, n, row, tip || remote), openFindings: openFindings(slug, n), kit: pieces?.filter((p) => p.expected) ?? null, kitBody: config.kitBody };
    const gates = GATES.map((g) => {
      const stored = row.gates?.[g.id];
      const derived = derive(g.id, facts);
      const manual = stored && !stored.skill ? stored : null;
      const state = gateState(stored, derived);
      return { id: g.id, label: g.label, skills: g.skills || [], tab: g.tab || null, state, derived, detail: CLEARED.includes(state) ? '' : detail(g.id, facts), reason: manual?.reason || '', at: manual?.at || null, skill: stored?.state === 'running' ? stored.skill || null : null, agentId: stored?.state === 'running' ? stored.agentId || null : null };
    });
    const cleared = gates.slice(0, 3).every((g) => CLEARED.includes(g.state));
    const ready = gates.find((g) => g.id === 'ready');
    const canReady = Boolean(typeof n === 'number' && pr?.state === 'OPEN' && pr.isDraft && cleared && ready?.state === 'todo');
    return {
      key: n,
      branch,
      agentChecks: row.agentChecks ?? null,
      current: gates.find((g) => !CLEARED.includes(g.state))?.id ?? null,
      gates: gates.map((g) => ({ ...g, canRun: g.id === 'ready' && canReady })),
    };
  }

  async function summarize(slug: string): Promise<RowMilestone[]> {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const rows = await Promise.all((work.stack || []).map(async (s): Promise<RowMilestone | null> => {
      const key = rowKey(s);
      if (key === null) return null;
      if (!s.number) return { key, current: null, done: 0 };
      const pr = await works.prInfo(s.number);
      if (pr.state === 'MERGED') return { key, current: null, done: GATES.length };
      if (pr.state === 'CLOSED') return { key, current: null, done: 0 };
      const v = await view(slug, String(key)).catch(() => null);
      return { key, current: v?.current ?? null, done: v ? v.gates.filter((g) => CLEARED.includes(g.state)).length : 0 };
    }));
    const out = rows.filter((r): r is RowMilestone => r !== null);
    allSummaries()[slug] = out;
    if (summaryFile) {
      fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
      fs.writeFileSync(summaryFile, JSON.stringify(allSummaries()));
    }
    return out;
  }

  // run: a self-review skill goes to the agent of the PR worktree (or a new one there); ready flips the draft; done, skipped and todo are the owner's ticks
  async function act(slug: string, raw: string, id: string, { action, reason = '', skill, args = '' }: ActInput) {
    const { work, n, index } = rowOf(slug, raw);
    const gate = GATES.find((g) => g.id === id);
    if (!gate) throw new HttpError(404, 'no such milestone');
    const at = new Date().toISOString();
    if (action === 'run') {
      const names = (gate.skills || []).map(skillName);
      if (!skill || !names.includes(skill)) throw new HttpError(400, `${id} runs ${names.join(', ') || 'no skill'}`);
      const title = `${RUN_LABEL[id] || gate.label}: /${skill} ${keyLabel(n)}`;
      const launch = async () => {
        const pr = await reviewAgent.rowPr(work, index);
        const runner = await reviewAgent.pickRunner(pr);
        const busy = runner.mode === 'send' && (await reviewAgent.agentsList()).find((a) => a.id === runner.agentId)?.status === 'running';
        if (busy) throw new HttpError(409, `agent ${String(runner.agentId).slice(0, 8)} is mid-turn in the PR worktree; wait for it`);
        const prompt = `/${skill} ${String(args).trim() || (isLocal(n) ? '' : n)}`.trim();
        const agentId = await reviewAgent.launch(runner, { title, provider: config.models.default, prompt, labels: { kind: 'gate', gate: id, work: slug, pr: fileKey(n) }, n, branch: pr.head });
        saveGate(slug, index, id, { state: 'running', at, skill, agentId });
        if (agentId && runner.mode !== 'send') agents?.archiveWhenDone(agentId).catch(() => {});
        reviewAgent.timeline(slug, 'gate', `${keyLabel(n)} ${id}: started ${prompt} in ${runner.mode} agent ${String(agentId || '').slice(0, 8)}`);
        return { agentId };
      };
      if (!jobs) await launch();
      else jobs.start({ work: slug, pr: n, action: `gate:${id}:${skill}`, label: title, kind: 'agent' }, launch);
    } else if (action === 'ready') {
      if (id !== 'ready') throw new HttpError(400, 'only the ready milestone flips a draft');
      if (!(await view(slug, raw)).gates.find((g) => g.id === 'ready')?.canRun) throw new HttpError(409, 'ready needs an open draft with self-reviewed, kit and pushed done or skipped');
      const flip = async () => {
        const r = await reviewAgent.exec('gh', ['pr', 'ready', String(n), ...(GH ? ['--repo', GH] : [])]);
        if (!r.ok) throw new HttpError(502, (r.stderr || r.stdout).trim().slice(-400) || 'gh pr ready failed');
        works.dropPr?.(n as number);
        reviewAgent.timeline(slug, 'gate', `${keyLabel(n)} ready: marked ready for review on GitHub`);
        return { output: r.stdout };
      };
      if (!jobs) await flip();
      else jobs.start({ work: slug, pr: n, action: 'ready', label: `Mark ${keyLabel(n)} ready`, kind: 'command' }, flip);
    } else if (action && ['done', 'skipped', 'todo'].includes(action)) {
      if (action === 'skipped' && !reason.trim()) throw new HttpError(400, 'a skip needs a reason');
      saveGate(slug, index, id, action === 'todo' ? null : { state: action, at, reason: reason.trim() });
      reviewAgent.timeline(slug, 'gate', `${keyLabel(n)} ${id}: ${action}${reason.trim() ? ` (${reason.trim()})` : ''}`);
    } else throw new HttpError(400, 'action must be run, ready, done, skipped or todo');
    return view(slug, raw);
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , raw, id] = parts;
      if (!raw && req.method === 'GET') return send(res, 200, { rows: await summarize(slug) });
      if (!raw) throw new HttpError(400, 'pr required');
      if (req.method === 'GET') return send(res, 200, await view(slug, decodeURIComponent(raw)));
      if (req.method === 'POST' && id) return send(res, 200, await act(slug, decodeURIComponent(raw), id, JSON.parse((await readBody(req)) || '{}')));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), conflictBody(e) ?? { error: errorMessage(e) });
    }
  }

  return { handle, view, summarize, lastSummary: (slug: string) => allSummaries()[slug] || null };
}
