// Hire: any coco agent starts worker agents (spawn_agent), waits on them, steers them and stops them, with no card in between.
// A worker is a sibling Paseo agent with a parent edge: its own tab, model, mode and, when it may edit, its own worktree off its conductor's branch.
// A run is the agent that hired first (its root) and every worker under it: capped in workers at once, depth and what its workers cost.
import { getParentAgentIdFromLabels, PARENT_AGENT_ID_LABEL } from '@getpaseo/protocol/agent-labels';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { catalog } from './dispatch.ts';
import { freshBranch } from './new-agent.ts';
import { notesSection } from './briefs.ts';
import { modelsFor } from './config.ts';
import { startThinking } from './models.ts';
import { fromPaseo } from './agent-usage.ts';
import { defaultExec } from './placement.ts';
import { timelineOf } from './paseo-agent.ts';
import type { DaemonClient, WaitResult } from './paseo-agent.ts';
import type { AgentSnapshot } from './permissions.ts';
import type { Config } from './config.ts';
import type { Models } from './models.ts';
import type { Exec, Placed } from './placement.ts';
import type { Readier } from './review-agent.ts';
import type { ReadBody, Req, Res, Send, Work } from './core-types.ts';

export const Q_TITLE = 'Q for conductor';
export const WAIT_MS = 120000;
// a wait answers before the MCP server's fetch gives up on coco (five minutes)
export const WAIT_MAX_MS = 270000;
const PROMPT_MAX = 20000;
const TITLE_MAX = 60;
const MESSAGE_MAX = 6000;
const FILES_MAX = 200;
const LIST_MAX = 200;
const BEHAVIORS = ['steer', 'interrupt'] as const;

export type SpawnInput = { work?: unknown; prompt?: unknown; role?: unknown; provider?: unknown; thinking?: unknown; mode?: unknown; title?: unknown; paths?: unknown; acceptance?: unknown; wait?: unknown; timeoutMs?: unknown };
// evidence only: the conductor judges
export type WorkerState = 'running' | 'blocked' | 'done' | 'failed' | 'archived';
export type Waited = { agentId: string; state: WorkerState; lastMessage: string | null; files: string[]; branch: string | null; costUsd: number | null; blockedCardId?: string; blockedOn?: string };

type Snap = AgentSnapshot & { currentModeId?: string | null };
type OpenCard = { id: string; title: string; question?: string; status: string };
type Deps = {
  config: Config;
  client: () => Promise<Pick<DaemonClient, 'agents'>>;
  works: { get(slug: string): Work | null };
  agents: { start(opts: Record<string, unknown>): Promise<{ agentId: string; workspaceId?: string | null }> };
  archive: (agentId: string) => Promise<boolean>;
  models?: Pick<Models, 'check' | 'mode'>;
  placement?: { sideWorkspace(slug: string, opts: { branch: string; base: string; title: string }): Promise<Placed> };
  rules?: { keptFor(work: Work): { text: string }[] };
  cards?: { ofAgent(agentId: string): OpenCard[]; chatted?(agentIds: string[]): unknown };
  readier?: Readier;
  exec?: Exec;
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const isLive = (a: Snap) => !a.archivedAt && a.status !== 'closed' && a.status !== 'idle' && a.status !== 'error';

// what a worker reads on top of its task: it inherits no AGENTS.md, rules or conversation from its conductor
export function workerBrief({ conductor, work, rules, paths, acceptance, place }: { conductor: string; work: Work; rules: string[]; paths: string[]; acceptance: string; place: { cwd: string; branch?: string; base?: string } }) {
  const lines = (items: string[]) => items.map((x) => `- ${x}`);
  return [
    '---',
    '',
    `You are a worker hired by agent ${conductor} (your conductor) on the work \`${work.slug}\` (${work.title}). Nothing of its context reached you: this brief and the task above are all you know. Read only the files the task needs and keep your context small.`,
    '',
    ...(rules.length ? ['## Rules', '', ...lines(rules), ''] : []),
    '## Where',
    '',
    ...(paths.length
      ? [`Your own worktree: \`${place.cwd}\`, branch \`${place.branch}\` off \`${place.base}\`. You may change only these paths:`, '', ...lines(paths.map((p) => `\`${p}\``)), '', 'Touch nothing else. Commit on your branch; never push.']
      : [`\`${place.cwd}\`, your conductor's checkout. Read-only: do not edit files, commit or push.`]),
    '',
    '## Acceptance',
    '',
    acceptance || 'The task above says when you are done.',
    '',
    '## Questions',
    '',
    `When you cannot go on without an answer, post one cocopilot ask card titled "${Q_TITLE}" and end your turn: your conductor answers with a message. Do not ask anyone else.`,
    '',
    '## Return',
    '',
    'Your last message is your report, evidence only, never a verdict: your conductor judges. No next-steps card.',
    '- Files: each file you changed',
    '- Commands: each command you ran, with its exit code',
    '- Output: the decisive lines of that output, verbatim',
    '- Blocked: no, or what blocks you and what you need',
  ].join('\n');
}

export function createHire({ config, client, works, agents, archive, models, placement, rules, cards, readier, exec = defaultExec }: Deps) {
  const caps = config.orchestration;
  // spawns past their checks and not started yet, per run: two at once cannot both take the last seat
  const starting = new Map<string, number>();

  const snapOf = async (agentId: string) => ((await (await client()).agents.ref(agentId).refresh())?.agent ?? null) as Snap | null;

  // the agent and its conductors up to the run's root, nearest first
  async function lineage(agentId: string) {
    const chain: (Snap & { id: string })[] = [];
    for (let id: string | null = agentId; id && chain.length <= caps.maxDepth + 1 && !chain.some((a) => a.id === id); ) {
      const snap = await snapOf(id);
      if (!snap) break;
      chain.push({ ...snap, id });
      id = getParentAgentIdFromLabels(snap.labels);
    }
    if (!chain.length) throw new HttpError(404, 'Paseo no longer knows this agent');
    return chain;
  }

  async function runAgents(root: string) {
    const c = await client();
    if (!c.agents.list) throw new HttpError(501, 'this Paseo client cannot list agents');
    const page = await c.agents.list({ includeBackground: true, filter: { labels: { run: root }, includeArchived: true, includeBackground: true }, page: { limit: LIST_MAX } });
    return page.entries.map((e) => e.agent as Snap);
  }

  // a conductor reaches only the workers under it
  async function owned(caller: string, agentId: string) {
    const chain = await lineage(agentId);
    if (!chain.slice(1).some((a) => a.id === caller)) throw new HttpError(403, `agent ${agentId} is not a worker of ${caller}`);
    return chain[0];
  }

  // role: a models tier (default, fast, …), "worker", or a dispatch catalog entry, which takes the model dispatch would give it
  function roleModel(role: string, work: Work) {
    const repo = config.repos.find((r) => r.id === work.repo) ?? null;
    const ms = modelsFor(config, repo) as Record<string, string | undefined> & { default: string };
    if (!role || role === 'worker') return null;
    if (typeof ms[role] === 'string' && role !== 'thinking') return ms[role] as string;
    const entry = catalog(config, repo).find((e) => e.id === role);
    if (entry) return entry.kind === 'persona-review' ? ms.fast || ms.default : ms.default;
    throw new HttpError(400, `unknown role ${role}: worker, ${Object.keys(ms).filter((k) => k !== 'thinking').join(', ')} or a dispatch entry (${catalog(config, repo).map((e) => e.id).join(', ')})`);
  }

  async function pickModel(input: SpawnInput, work: Work) {
    const ms = modelsFor(config, config.repos.find((r) => r.id === work.repo) ?? null);
    const asked = str(input.provider) || roleModel(str(input.role), work);
    const check = (provider: string): Promise<{ provider?: string; thinking?: string }> => (models ? models.check({ provider, thinking: input.thinking }) : Promise.resolve({ provider }));
    // the worker model is a default: where Paseo does not list it, the fast model stands in
    const pick = asked ? await check(asked) : await check(caps.workerModel).catch(() => check(ms.fast || ms.default));
    const provider = pick.provider || asked || caps.workerModel;
    const mode = models ? await models.mode(provider, input.mode) : str(input.mode) || undefined;
    return { provider, thinking: pick.thinking || startThinking(ms, provider), mode };
  }

  const git = async (cwd: string, args: string[]) => {
    const r = await exec('git', ['-C', cwd, ...args]);
    return r.ok ? r.stdout.trim() : '';
  };

  async function spawn(caller: string, input: SpawnInput) {
    const prompt = str(input.prompt).slice(0, PROMPT_MAX);
    if (!prompt) throw new HttpError(400, 'prompt required: the whole task, the worker knows nothing else');
    const paths = Array.isArray(input.paths) ? input.paths.map(str).filter(Boolean) : [];
    const chain = await lineage(caller);
    const conductor = chain[0];
    const root = chain.at(-1)!.id;
    if (chain.length > caps.maxDepth) throw new HttpError(409, `depth ${chain.length} is past this run's ${caps.maxDepth}: a worker this deep does the task itself`);
    const slug = str(input.work) || conductor.labels?.work || '';
    const work = slug ? works.get(slug) : null;
    if (!work || work.archived) throw new HttpError(400, slug ? `no live work ${slug}` : 'no work: pass work (the work slug); this agent carries no work label');
    const picked = await pickModel(input, work);

    const spawned = await seated(root, async () => {
      const run = await runAgents(root);
      const live = run.filter(isLive).length + (starting.get(root) ?? 0);
      if (live > caps.maxWorkers) throw new HttpError(409, `${caps.maxWorkers} workers already run in this run: wait_agent on one, or stop_agent one you no longer need`);
      const spent = run.reduce((sum, a) => sum + (fromPaseo(a.lastUsage).costUsd ?? 0), 0);
      if (spent >= caps.budgetUsd) throw new HttpError(409, `this run's workers spent $${spent.toFixed(2)} of its $${caps.budgetUsd} budget: finish with the workers you have`);

      const title = (str(input.title) || prompt.split('\n')[0]).slice(0, TITLE_MAX);
      const from = conductor.cwd || '';
      let place: { workspaceId: string | null; cwd: string; branch?: string; base?: string; baseSha?: string };
      if (paths.length) {
        if (!placement) throw new HttpError(501, 'worktrees are not wired');
        const branch = await git(from, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const baseSha = await git(from, ['rev-parse', 'HEAD']);
        if (!baseSha) throw new HttpError(409, `cannot read the branch of ${from || 'the conductor'}: a worker that edits starts off its conductor's commit`);
        const base = branch && branch !== 'HEAD' ? branch : baseSha;
        const newBranch = freshBranch(title);
        const placed = await placement.sideWorkspace(work.slug, { branch: newBranch, base, title: `Worker · ${title}` });
        place = { ...placed, branch: newBranch, base, baseSha };
      } else place = { workspaceId: conductor.workspaceId ?? null, cwd: from };

      const setup = paths.length && readier ? await readier.ready(place.cwd).catch(() => []) : [];
      const kept = [...(rules?.keptFor(work) ?? []).map((r) => r.text), ...notesSection(work.notes, 'Rules')];
      const brief = workerBrief({ conductor: caller, work, rules: kept, paths, acceptance: str(input.acceptance), place });
      const message = [prompt, '', brief, ...(setup.length ? ['', ...setup] : [])].join('\n');
      const labels = { source: 'cocopilot', kind: 'worker', work: work.slug, pr: conductor.labels?.pr, run: root, [PARENT_AGENT_ID_LABEL]: caller, base: place.baseSha };
      const started = await agents.start({ title, ...picked, prompt: message, labels, parent: caller, workspaceId: place.workspaceId, cwd: place.cwd });
      if (paths.length) readier?.started(started.agentId, place.cwd, { slug: work.slug });
      return { agentId: started.agentId, parentAgentId: caller, rootAgentId: root, depth: chain.length, title, ...picked, workspaceId: started.workspaceId ?? place.workspaceId, cwd: place.cwd, ...(place.branch ? { branch: place.branch, base: place.base } : {}) };
    });
    return input.wait === true ? { ...spawned, result: await wait(caller, spawned.agentId, input.timeoutMs) } : spawned;
  }

  // holds a seat of the run while a spawn checks the caps and starts its worker
  async function seated<T>(root: string, fn: () => Promise<T>) {
    starting.set(root, (starting.get(root) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (starting.get(root) ?? 1) - 1;
      if (left > 0) starting.set(root, left);
      else starting.delete(root);
    }
  }

  async function lastText(agentId: string) {
    const items = (await timelineOf((await client()).agents.ref(agentId), 1).catch(() => [])).map((e) => e.item);
    return items.findLast((it) => it?.type === 'assistant_message' && it.text)?.text ?? null;
  }

  // what the worker changed against the commit it started from, committed or not
  async function filesOf(snap: Snap) {
    const base = snap.labels?.base;
    if (!base || !snap.cwd) return [];
    const [changed, added] = await Promise.all([git(snap.cwd, ['diff', '--name-only', base]), git(snap.cwd, ['ls-files', '--others', '--exclude-standard'])]);
    return [...new Set([...changed.split('\n'), ...added.split('\n')].filter(Boolean))].slice(0, FILES_MAX);
  }

  // waits until the worker's turn ends, it blocks on a permission or a card, or timeoutMs passes (state running)
  async function wait(caller: string, agentId: string, timeoutMs?: unknown): Promise<Waited> {
    const first = await owned(caller, agentId);
    const ms = Math.min(Math.max(Number(timeoutMs) || WAIT_MS, 1000), WAIT_MAX_MS);
    let result: WaitResult | null = null;
    if (!first.archivedAt) result = await (await client()).agents.ref(agentId).waitForFinish(ms).catch((e) => ({ status: 'error', error: errorMessage(e) }));
    const snap = (await snapOf(agentId)) ?? first;
    const open = (cards?.ofAgent(agentId) ?? []).filter((c) => c.status === 'open');
    const card = open.find((c) => c.title === Q_TITLE) ?? open[0];
    const permission = snap.pendingPermissions?.[0];
    const state: WorkerState = snap.archivedAt || snap.status === 'closed' ? 'archived' : permission || result?.status === 'permission' || card ? 'blocked' : snap.status === 'error' || result?.status === 'error' ? 'failed' : snap.status === 'idle' ? 'done' : 'running';
    const message = result?.lastMessage || (await lastText(agentId));
    const blocked = card ? { blockedCardId: card.id, blockedOn: [card.title, card.question].filter(Boolean).join(': ') } : permission ? { blockedOn: `permission: ${permission.title || permission.name}${permission.description ? ` (${permission.description})` : ''}` } : {};
    return { agentId, state, lastMessage: message ? clip(message, MESSAGE_MAX) : null, files: await filesOf(snap), branch: snap.labels?.base && snap.cwd ? (await git(snap.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null : null, costUsd: fromPaseo(snap.lastUsage).costUsd ?? null, ...blocked, ...(state === 'failed' && result?.error ? { error: result.error } : {}) };
  }

  // steer joins the turn in flight, interrupt ends it first; either closes the worker's open asks, as the owner's message does
  async function message(caller: string, agentId: string, { text, behavior }: { text?: unknown; behavior?: unknown }) {
    const said = str(text);
    if (!said) throw new HttpError(400, 'text required');
    const how = behavior == null || behavior === '' ? 'steer' : behavior;
    if (!BEHAVIORS.includes(how as (typeof BEHAVIORS)[number])) throw new HttpError(400, `behavior must be ${BEHAVIORS.join(' or ')}`);
    const snap = await owned(caller, agentId);
    if (snap.archivedAt || snap.status === 'closed') throw new HttpError(409, 'this worker is archived');
    await (await client()).agents.ref(agentId).send(said, { activeTurnBehavior: how as string });
    cards?.chatted?.([agentId]);
    return { ok: true, behavior: how };
  }

  // ends the worker's turn and archives it; cascade first does the same to the workers it hired, deepest first
  async function stop(caller: string, agentId: string, { cascade }: { cascade?: unknown }) {
    const snap = await owned(caller, agentId);
    const ids = [agentId];
    if (cascade === true && snap.labels?.run) {
      const run = (await runAgents(snap.labels.run)).filter((a) => !a.archivedAt);
      for (let i = 0; i < ids.length; i++) ids.push(...run.filter((a) => getParentAgentIdFromLabels(a.labels) === ids[i]).map((a) => a.id));
    }
    const stopped: string[] = [];
    const failed: { agentId: string; error: string }[] = [];
    for (const id of ids.reverse()) {
      await exec('paseo', ['agent', 'stop', id]);
      try {
        await archive(id);
        stopped.push(id);
      } catch (e) {
        failed.push({ agentId: id, error: errorMessage(e) });
      }
    }
    return { stopped, failed };
  }

  // POST /api/agent-chat/<caller>/workers · GET …/workers/<id>?timeoutMs= · POST …/workers/<id>/messages|stop
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, caller, , id, action] = parts;
    try {
      const body = async () => {
        try {
          return JSON.parse((await readBody(req)) || '{}') || {};
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      };
      if (!id && req.method === 'POST') return send(res, 200, await spawn(caller, await body()));
      if (id && !action && req.method === 'GET') return send(res, 200, await wait(caller, id, new URL(req.url || '/', 'http://local').searchParams.get('timeoutMs')));
      if (id && action === 'messages' && req.method === 'POST') return send(res, 200, await message(caller, id, await body()));
      if (id && action === 'stop' && req.method === 'POST') return send(res, 200, await stop(caller, id, await body()));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { spawn, wait, message, stop, handle };
}
