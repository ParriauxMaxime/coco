// "Ask coco": a conversation with one Paseo agent that has the cocopilot MCP server; follow-ups go to the same agent, steering the turn in flight, and the transcript streams over SSE.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileKey, keyLabel, parseKey, rowKey } from './stack.ts';
import { UUID, activityEvents, createPaseoAgents, workCwd } from './paseo-agent.ts';
import type { AgentSession, Outcome } from './paseo-agent.ts';
import { errorMessage, httpStatus } from './core-types.ts';
import type { PrInfo, ReadBody, Req, Res, RowKey, Send, StackRow, TimelineEntry, Work } from './core-types.ts';
import type { AddRepoResult } from './repos.ts';
import { FILES_ONLY, agentInput, createUploads, uploadRef } from './uploads.ts';
import type { Upload, Uploads } from './uploads.ts';

const TIMEOUT_MS = 20 * 60 * 1000;
// past the prompt cache's one-hour lifetime a kept agent saves no tokens, only context, and the conversation so far restores the gist
const IDLE_MS = 60 * 60 * 1000;
const REAP_MS = 5 * 60 * 1000;
const DELTA_MS = 100;
const HISTORY_MAX = 12000;
const ID = new RegExp(`^${UUID.source}$`);
// running: a turn is out · idle: its agent waits · parked: agent archived after idling · closed: by the owner; older runs read done or error
const OPEN = ['running', 'idle'];

type Event = { type: string; text?: string; [key: string]: unknown };
type Listener = (ev: Event) => void;
type Scaffold = {
  slug: string;
  title?: string;
  description?: string;
  summary?: string;
  tier?: string;
  paseoProject?: { existingProjectId?: string; createNamed?: string };
  stack?: { order: number; title: string; scope: string; branch: string; personas?: string[]; existingPr?: number }[];
  surfaces?: { surface: string; entryPoint: string; coverage: string }[];
  personas?: string[];
  links?: { label: string; url: string }[];
  openQuestions?: { question: string; recommendation: string; tradeoff: string }[];
  notes?: string;
  nextSteps?: string[];
  betaFlags?: { code: string; why: string; prs?: number[] }[];
};
type AgentProposal = { title: string; prompt: string; workspaceId?: string; cwd?: string; provider?: string; thinking?: string; workSlug?: string };
type DispatchProposal = { entry: string; pr?: number | string; prompt?: string; persona?: string; edits?: boolean; workSlug?: string; why?: string };
type RepoProposal = { source: string; why?: string };
type Submitted = { propose_work_scaffold?: Scaffold; propose_paseo_agent?: AgentProposal; propose_rules?: { rules: { text: string; source: string }[] }; dispatch?: DispatchProposal; propose_repo?: RepoProposal };
// the tier a conversation runs at: global (repos, cross-repo), a repo (its works), a work (its plan, stack and findings)
export type AskScope = { kind: 'global' } | { kind: 'repo'; repoId: string } | { kind: 'work'; slug: string };
export const scopeKey = (s: AskScope) => (s.kind === 'global' ? 'global' : s.kind === 'repo' ? `repo:${s.repoId}` : `work:${s.slug}`);
// conversations saved before scopes existed: a work's stays the work's, any other was started from the global page
const scopeOf = (c: { scope?: AskScope | null; workSlug?: string | null }): AskScope => c.scope || (c.workSlug ? { kind: 'work', slug: c.workSlug } : { kind: 'global' });
type Conv = {
  id: string;
  prompt: string;
  scope: AskScope;
  workSlug: string | null;
  // the stack row a work's conversation is about: its agent runs in that row's worktree
  pr?: RowKey | null;
  kind: string;
  model: string | null;
  startedAt: string;
  lastActivity: string;
  status: string;
  turns: number;
  proposal: Scaffold | null;
  agentProposal: AgentProposal | null;
  rulesProposal: Submitted['propose_rules'] | null;
  dispatchProposal: DispatchProposal | null;
  repoProposal: RepoProposal | null;
  text: string;
  agentId: string | null;
  cost: number | null;
  costBase: number;
  events: Event[];
  listeners: Set<Listener>;
  session: Promise<AgentSession | null> | null;
  fresh: boolean;
  stream: ReturnType<typeof activityEvents> | null;
  onEnd?: (conv: Conv) => void;
  once?: boolean;
};
const META = ['id', 'prompt', 'scope', 'workSlug', 'pr', 'kind', 'model', 'startedAt', 'lastActivity', 'status', 'turns', 'proposal', 'agentProposal', 'rulesProposal', 'dispatchProposal', 'repoProposal', 'text', 'agentId', 'cost', 'costBase'] as const satisfies readonly (keyof Conv)[];
type Meta = Pick<Conv, (typeof META)[number]>;
type TurnEnd = { status: string; error?: string | null; submitted?: Record<string, unknown>; text?: string; cost?: number | null };
type AskWork = Work & { stack?: StackRow[]; timeline?: TimelineEntry[] };
type AskOptions = {
  DATA: string;
  APP?: string | null;
  REPO: string;
  config: { owner: { name: string }; models: { default: string }; gateSkills?: Record<string, (string | { name: string; ask?: string })[]>; methodSkill?: string; methodNotes?: string; repos?: { id: string; name: string; github: string; path: string }[] };
  works: { get(slug: string): AskWork | null | undefined; save(work: AskWork): unknown; prInfo(n: number): Promise<PrInfo | null> };
  agents?: ReturnType<typeof createPaseoAgents>;
  idleMs?: number;
  // the Paseo workspace of a scope's agents; without it, the folder decides as before
  place?: (scope: AskScope, pr?: RowKey | null) => Promise<{ workspaceId: string; cwd: string }>;
  // starts what a dispatch call proposed, once the owner confirms it
  dispatch?: (slug: string, input: { entry: string; key?: number | string; prompt?: string; persona?: string; edits?: boolean }) => Promise<{ title: string; agentId: string | null }>;
  // adds what a propose_repo call proposed, once the owner confirms it
  addRepo?: (source: string) => Promise<AddRepoResult>;
  uploads?: Uploads;
};

export function createAsk({ DATA, APP, REPO, config, works, agents = createPaseoAgents({ APP }), idleMs = IDLE_MS, place, dispatch, addRepo, uploads = createUploads({ DATA }) }: AskOptions) {
  const repos = config.repos || [];
  const where = async (scope: AskScope, pr: RowKey | null = null) => {
    if (place) return place(scope, pr);
    const work = scope.kind === 'work' ? works.get(scope.slug) : null;
    return { workspaceId: null, cwd: work ? await workCwd({ repo: REPO, work, key: pr, prInfo: works.prInfo }) : REPO };
  };
  const DIR = path.join(DATA, 'asks');
  fs.mkdirSync(DIR, { recursive: true });
  const convs = new Map<string, Conv>();
  const OWNER = config.owner.name;
  const diagramSkill = config.gateSkills?.['kit-diagram']?.[0];
  const method = Boolean(config.methodSkill);
  const notes = method && config.methodNotes;

  const SYSTEM = `You are coco, the assistant inside cocopilot, ${OWNER}'s local tool for running large features with Paseo agents, reviewer personas and "works" (long-term context per PR stack).
Rules: read before proposing (${notes ? `read_skill ${notes} for how ${OWNER} wants a scaffold shaped, ` : ''}${method ? 'read_skill SKILL.md for the method, ' : ''}list_works, list_personas, list_paseo, github_pr/github_search when a PR or issue is named). Never create, push, post or send anything: you only propose.
For a new work, end with exactly one propose_work_scaffold call carrying the full proposal${notes ? `, shaped as ${notes} asks` : ''}:
- Stack: strict linear chain; order PRs so each merges safely on its own, user-visible switch last${notes ? `, following ${notes}` : ''}. Run suggest_personas on the files each PR touches; a PR whose files match no persona is a gap to flag in notes.
- Precedent works: get_work on the closest ones first and inherit their Rules and Do-not-revisit lines verbatim. A decision pinned there (chain shape, companion PRs, test rules) is not an open question.
- Pending decisions already listed in the work's notes stay open: carry them as open questions, never mark one settled yourself; only ${OWNER} closes a decision.
- Open questions: product questions only, the ones a PM or ${OWNER} must answer, four at most, each yes/no with a recommendation and its tradeoff. Process questions settled by ${method ? 'SKILL.md or ' : ''}a precedent are not questions.
- paseoProject: reuse an id from list_paseo when one matches the slug; otherwise give createNamed only and omit rootPath (the worktree exists only once the work is applied).
- Diagrams: ${diagramSkill ? `read_skill ${diagramSkill} for the house style (init line, new/same/rm classDef, shapes, quoted labels, under ~15 nodes)${notes ? `, with the overrides from ${notes}` : ''}: ` :'Mermaid, under ~15 nodes, quoted labels; '}no legend box; lanes (subgraphs) group what colour would have to explain, the heading above each diagram states the point plus the one colour rule that matters, emoji are decoration only. At most a Before/After and, for a stack, a merge-order diagram.
- Links: product spec and decision log first, then the precedent PR or stack; four at most.
- Feature flags: find the flags checked around the entry points of every surface the work touches; each flag that gates one goes in betaFlags with the PRs it applies to, so testers and PR bodies name it.
To start a Paseo agent (a local Claude Code session in a work's PR workspace, from list_paseo), end with exactly one propose_paseo_agent call carrying the full brief: the card lets ${OWNER} start it.${dispatch ? ` To run a catalog agent on the current work or one of its PRs (ask on a PR, persona review, fix findings, a gate run, a free prompt), prefer one dispatch call: coco adds the work brief and picks the workspace, ${OWNER} confirms on the card.` : ''} For a question, answer in prose, short, English. Quote file paths and PR numbers exactly.
This is a conversation: ${OWNER} follows up in the same session, sometimes while you are still working; answer the latest message and keep what was already settled.`;

  // the inbox is global too but scaffolds works: only the global Ask page gets the global tier's line
  const tierOf = ({ scope, kind, pr }: Pick<Conv, 'scope' | 'kind' | 'pr'>) => {
    if (scope.kind === 'work') return `\nCurrent work: ${scope.slug} (use get_work first).${pr != null ? ` This conversation is about its PR ${keyLabel(pr)}; you run in that PR's worktree.` : ''}`;
    const repo = scope.kind === 'repo' ? repos.find((r) => r.id === scope.repoId) : null;
    if (repo) return `\nThis is the Ask coco of the ${repo.name} repo (${repo.github || 'no GitHub slug'}, clone at ${repo.path}): the works you scaffold belong to it.`;
    if (kind !== 'ask') return '';
    const names = repos.map((r) => r.name).join(', ');
    return `\nThis is the global Ask coco: questions across ${OWNER}'s repos${names ? ` (${names})` : ''}. A work belongs to one repo: for a new work, say which repo it belongs to and send ${OWNER} to that repo's page, whose Ask coco scaffolds it; do not call propose_work_scaffold here.${addRepo ? ` To add a repo to coco (its GitHub slug owner/name, or the absolute path of a local clone), end with one propose_repo call: once ${OWNER} confirms on the card, coco reuses a clone already on disk or clones it, adds its Paseo project and starts a setup run proposing its config.` : ''}`;
  };

  const providerFor = (model?: string | null) => (!model ? config.models.default : model.includes('/') ? model : `${config.models.default.split('/')[0]}/${model}`);

  const fileOf = (id: string, ext: string) => path.join(DIR, `${id}.${ext}`);
  const meta = (c: Meta): Meta => ({ ...(Object.fromEntries(META.map((k) => [k, c[k] ?? null])) as Meta), scope: scopeOf(c) });
  const save = (c: Conv) => fs.writeFileSync(fileOf(c.id, 'json'), JSON.stringify(meta(c), null, 1));
  const now = () => new Date().toISOString();
  const metas = (): Meta[] => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  const remember = (c: Meta, events: Event[] = []): Conv => {
    const conv: Conv = { ...c, scope: scopeOf(c), events, listeners: new Set(), session: null, fresh: false, stream: null };
    convs.set(conv.id, conv);
    return conv;
  };

  // a conversation from memory or, after a coco restart, from its files
  function load(id: string) {
    const known = convs.get(id);
    if (known) return known;
    if (!ID.test(String(id)) || !fs.existsSync(fileOf(id, 'json'))) return null;
    const saved: Meta = JSON.parse(fs.readFileSync(fileOf(id, 'json'), 'utf8'));
    const log: Event[] = fs.existsSync(fileOf(id, 'jsonl')) ? fs.readFileSync(fileOf(id, 'jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return remember({ ...saved, lastActivity: saved.lastActivity || saved.startedAt, turns: saved.turns ?? 1 }, log);
  }

  const push = (conv: Conv, ev: Event) => {
    conv.events.push(ev);
    conv.lastActivity = now();
    fs.appendFileSync(fileOf(conv.id, 'jsonl'), JSON.stringify(ev) + '\n');
    for (const l of conv.listeners) l(ev);
  };

  // deltas only go to whoever is watching; text, thinking and tool calls are kept
  function streamOf(conv: Conv) {
    conv.stream ||= activityEvents({
      keep: (ev) => push(conv, ev),
      live: (ev) => {
        conv.lastActivity = now();
        for (const l of conv.listeners) l(ev);
      },
      deltaMs: DELTA_MS,
    });
    return conv.stream;
  }

  // the conversation's agent: the live one, the one it had before a coco restart, else (create) a new one in the workspace of
  // the work's stack worktree, or the repo's; a new agent that replaces another reads the conversation so far with its first message
  function sessionOf(conv: Conv, { create = true } = {}): Promise<AgentSession | null> {
    conv.session ||= (async (): Promise<AgentSession | null> => {
      const stream = streamOf(conv);
      if (conv.agentId) {
        const s = await agents.session({ agentId: conv.agentId, ...stream });
        if (s) {
          push(conv, { type: 'meta', text: `re-attached to Paseo agent ${conv.agentId.slice(0, 8)}` });
          return s;
        }
        if (!create) return null;
        push(conv, { type: 'meta', text: `Paseo agent ${conv.agentId.slice(0, 8)} is gone: a new one starts with the conversation so far` });
      }
      if (!create) return null;
      const { workspaceId, cwd } = await where(conv.scope, conv.pr ?? null);
      const s = await agents.session({
        title: `Ask: ${conv.prompt.split('\n')[0]}`,
        systemPrompt: SYSTEM + tierOf(conv),
        provider: providerFor(conv.model),
        cwd,
        workspaceId,
        labels: { source: 'cocopilot', kind: conv.kind, ask: conv.id.slice(0, 8), work: conv.workSlug, pr: conv.pr == null ? null : fileKey(conv.pr), repo: conv.scope.kind === 'repo' ? conv.scope.repoId : null },
        mcp: true,
        ...stream,
      });
      Object.assign(conv, { agentId: s.agentId, costBase: conv.cost || 0, fresh: true });
      if (s.createdWorkspace) push(conv, { type: 'meta', text: `no Paseo workspace was open on ${cwd}: created ${s.createdWorkspace}` });
      push(conv, { type: 'meta', text: `Paseo agent ${s.agentId.slice(0, 8)} in workspace ${s.workspaceId} (${cwd})` });
      save(conv);
      return s;
    })().then(
      (s) => (s || (conv.session = null), s),
      (e) => {
        conv.session = null;
        throw e;
      },
    );
    return conv.session;
  }

  // what a new agent reads when it replaces a gone one: the owner's messages and coco's answers, the latest part when long
  function withHistory(conv: Conv, text: string) {
    const events = conv.events[0]?.type === 'user' ? conv.events : [{ type: 'user', text: conv.prompt }, ...conv.events];
    const said = events.slice(0, events.findLastIndex((e) => e.type === 'user')).filter((e) => e.type === 'user' || e.type === 'text');
    if (!said.length) return text;
    const all = said.map((e) => `**${e.type === 'user' ? OWNER : 'coco'}:** ${e.text}`).join('\n\n');
    const proposed = [conv.proposal && `a work scaffold for \`${conv.proposal.slug}\``, conv.agentProposal && `a Paseo agent "${conv.agentProposal.title}"`, conv.dispatchProposal && `a dispatch of ${conv.dispatchProposal.entry}`, conv.repoProposal && `adding the repo ${conv.repoProposal.source}`].filter(Boolean);
    return [
      `This continues an Ask conversation whose previous agent is gone. The conversation so far${all.length > HISTORY_MAX ? ' (oldest part cut)' : ''}:`,
      '',
      all.slice(-HISTORY_MAX),
      '',
      ...(proposed.length ? [`You already proposed ${proposed.join(' and ')}; propose again only what changes.`, ''] : []),
      `## ${OWNER}'s new message`,
      '',
      text,
    ].join('\n');
  }

  // a turn's end: its proposals become the conversation's latest, cost is per agent and cumulative
  function settle(conv: Conv, r: TurnEnd) {
    conv.stream?.flush();
    const open = OPEN.includes(conv.status);
    if (open && r.error) push(conv, { type: 'stderr', text: r.error.slice(0, 2000) });
    const sub = (r.submitted || {}) as Submitted;
    conv.proposal = sub.propose_work_scaffold || conv.proposal || null;
    conv.agentProposal = sub.propose_paseo_agent || conv.agentProposal || null;
    conv.rulesProposal = sub.propose_rules || conv.rulesProposal || null;
    conv.dispatchProposal = sub.dispatch || conv.dispatchProposal || null;
    conv.repoProposal = sub.propose_repo || conv.repoProposal || null;
    if (r.text) conv.text = r.text;
    if (r.cost != null) conv.cost = (conv.costBase || 0) + r.cost;
    conv.turns = (conv.turns || 0) + 1;
    if (open) conv.status = conv.session ? 'idle' : 'parked';
    push(conv, { type: 'end', status: open ? r.status : 'stopped', proposal: conv.proposal, agentProposal: conv.agentProposal, dispatchProposal: conv.dispatchProposal, repoProposal: conv.repoProposal, cost: conv.cost, conversation: conv.status, agentId: conv.agentId });
    save(conv);
    conv.onEnd?.(conv);
    if (conv.once) close(conv.id).catch(() => {});
  }

  function track(conv: Conv, turn: Promise<Outcome | { steered: true }>) {
    turn.then((r) => {
      if ('steered' in r) return;
      if (!r.entries.some((e) => e.type === 'text') && r.finalText && conv.events.findLast((e) => e.type === 'text')?.text !== r.finalText) push(conv, { type: 'text', text: r.finalText });
      settle(conv, r);
    });
  }

  // a message opens a turn, or steers the turn in flight; a parked or closed conversation gets a new agent
  async function say(conv: Conv, text: string, { nonce = null, files = [] }: { nonce?: unknown; files?: Upload[] } = {}) {
    const steer = conv.status === 'running';
    push(conv, { type: 'user', text, ts: now(), ...(steer ? { steer: true } : {}), ...(nonce ? { nonce: String(nonce).slice(0, 40) } : {}), ...(files.length ? { attachments: files.map(uploadRef) } : {}) });
    if (!steer) {
      conv.status = 'running';
      save(conv);
    }
    let s: AgentSession | null;
    let input;
    try {
      input = files.length ? agentInput(files) : undefined;
      s = await sessionOf(conv);
    } catch (e) {
      if (!steer) settle(conv, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!s) return;
    const prompt = conv.fresh ? withHistory(conv, text) : text;
    conv.fresh = false;
    if (s.busy()) return s.say(prompt, { input }).catch((e) => push(conv, { type: 'stderr', text: `could not reach the agent: ${e instanceof Error ? e.message : String(e)}`.slice(0, 2000) }));
    if (conv.status !== 'running') {
      conv.status = 'running';
      save(conv);
    }
    track(conv, s.say(prompt, { timeoutMs: TIMEOUT_MS, input }));
  }

  // onEnd(conv) fires after each turn; conv.rulesProposal holds a propose_rules call. once: the agent is archived after the first turn
  // the scope: the work's when there is one, else the repo's, else global
  function start({ prompt, workSlug = null, pr = null, repoId = null, model = null, kind = 'ask', nonce = null, files = [] }: { prompt: string; workSlug?: string | null; pr?: RowKey | null; repoId?: string | null; model?: string | null; kind?: string; nonce?: unknown; files?: Upload[] }, { onEnd, once = false }: { onEnd?: (conv: Conv) => void; once?: boolean } = {}) {
    const scope: AskScope = workSlug ? { kind: 'work', slug: workSlug } : repoId ? { kind: 'repo', repoId } : { kind: 'global' };
    const conv = remember({ id: randomUUID(), prompt, scope, workSlug, pr: workSlug ? pr : null, kind, model, startedAt: now(), lastActivity: now(), status: 'idle', turns: 0, proposal: null, agentProposal: null, rulesProposal: null, dispatchProposal: null, repoProposal: null, text: '', agentId: null, cost: null, costBase: 0 });
    Object.assign(conv, { onEnd, once });
    save(conv);
    say(conv, prompt, { nonce, files });
    return conv;
  }

  // the owner closes it, or it idled: its agent is archived; a later message starts a new one with the conversation so far
  async function close(id: string, reason = 'closed') {
    const conv = load(id);
    if (!conv) return null;
    const s = conv.session ? await conv.session.catch(() => null) : null;
    conv.session = null;
    if (s) await s.close();
    else if (conv.agentId && OPEN.includes(conv.status)) await agents.archive(conv.agentId).catch(() => false);
    conv.status = reason === 'idle' ? 'parked' : 'closed';
    push(conv, { type: 'closed', reason, conversation: conv.status });
    save(conv);
    return meta(conv);
  }

  // conversations quiet for idleMs (no message, no agent output) give their agent back, those a previous coco run left open included
  async function reap(at = Date.now()) {
    const parked: string[] = [];
    for (const m of metas().filter((x) => OPEN.includes(x.status) && x.agentId)) {
      const conv = load(m.id);
      if (!conv || !OPEN.includes(conv.status) || at - Date.parse(conv.lastActivity) < idleMs) continue;
      await close(conv.id, 'idle');
      parked.push(conv.id);
    }
    return parked;
  }

  // after a coco restart: a conversation whose turn was out gets its agent back and that turn's end; a gone agent parks it
  async function resume() {
    for (const m of metas().filter((x) => x.status === 'running' && x.agentId)) {
      const conv = load(m.id);
      if (!conv) continue;
      try {
        const s = await sessionOf(conv, { create: false });
        if (s) track(conv, s.resume({ timeoutMs: TIMEOUT_MS }));
        else {
          conv.status = 'parked';
          push(conv, { type: 'end', status: 'stopped', proposal: conv.proposal, agentProposal: conv.agentProposal, dispatchProposal: conv.dispatchProposal, repoProposal: conv.repoProposal, cost: conv.cost, conversation: conv.status });
          save(conv);
        }
      } catch {
        // daemon unreachable: the next message or the reaper tries again
      }
    }
  }

  function boot() {
    resume().catch(() => {});
    setInterval(() => reap().catch(() => {}), REAP_MS).unref();
  }

  function apply(id: string, options: { replaceStack?: boolean } = {}) {
    const run = load(id);
    if (!run?.proposal) return { error: 'no proposal on this run' };
    const p = run.proposal;
    const existing = works.get(p.slug);
    const stackKept = Boolean(existing?.stack?.length && !options.replaceStack);
    const stack = (p.stack || []).map((s) => ({ number: s.existingPr || null, planned: { order: s.order, title: s.title, scope: s.scope, branch: s.branch }, personas: s.personas || [] }));
    const notes = [p.notes, '', '## Surface table', '', '| Surface | Entry point | Coverage |', '| --- | --- | --- |', ...(p.surfaces || []).map((s) => `| ${s.surface} | ${s.entryPoint} | ${s.coverage} |`), '', '## Open questions', '', ...(p.openQuestions || []).map((q, i) => `${i + 1}. ${q.question} Recommended: ${q.recommendation}. Tradeoff: ${q.tradeoff}`), '', '## Next steps', '', ...(p.nextSteps || []).map((s) => `- ${s}`)].join('\n');
    const work: AskWork = {
      ...(existing || { createdAt: new Date().toISOString(), timeline: [] }),
      slug: p.slug,
      ...(!existing?.repo && run.scope.kind === 'repo' ? { repo: run.scope.repoId } : {}),
      title: (p.title || '').slice(0, 100),
      description: p.description || '',
      summary: p.summary,
      tier: p.tier,
      projectId: p.paseoProject?.existingProjectId || existing?.projectId || null,
      projectName: p.paseoProject?.createNamed || existing?.projectName || null,
      stack: existing && stackKept ? existing.stack : stack,
      personas: p.personas || [],
      links: p.links || [],
      notes,
      // a flag tied to planned PR orders follows those rows' keys (PR number once opened, else the branch)
      betaFlags: !p.betaFlags ? existing?.betaFlags || [] : p.betaFlags.map((f) => ({ code: f.code, why: f.why, ...(f.prs?.length ? { prs: f.prs.map((order) => rowKey(stack.find((s) => s.planned.order === order))).filter(Boolean) } : {}) })),
    };
    work.timeline = [{ ts: new Date().toISOString(), kind: 'coco', text: `${existing ? 'updated' : 'created'} from ask ${id.slice(0, 8)}: "${run.prompt.slice(0, 120)}"` }, ...(work.timeline || [])];
    works.save(work);
    return { ok: true, slug: work.slug, created: !existing, stackKept };
  }

  async function startAgent(id: string) {
    const conv = load(id);
    const p = conv?.agentProposal;
    if (!conv || !p) return { error: 'no agent proposal on this run' };
    let started: { agentId?: string; createdWorkspace?: string | null } = {};
    let error = '';
    const work = p.workSlug ? works.get(p.workSlug) : null;
    try {
      const placed = p.workspaceId ? { workspaceId: p.workspaceId, cwd: null } : p.cwd ? { workspaceId: null, cwd: p.cwd } : await where(work ? { kind: 'work', slug: work.slug } : conv.scope);
      started = await agents.start({ title: p.title, prompt: p.prompt, provider: providerFor(p.provider), thinking: p.thinking, ...placed, labels: { source: 'cocopilot', ask: id.slice(0, 8) } });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const { agentId = null, createdWorkspace = null } = started;
    if (work) {
      (work.timeline ||= []).unshift({ ts: new Date().toISOString(), kind: 'agent', text: `${error ? 'failed to start' : 'started'} Paseo agent "${p.title}"${agentId ? ` (${agentId.slice(0, 8)})` : ''} from ask ${id.slice(0, 8)}${createdWorkspace ? `, in workspace ${createdWorkspace} created for it` : ''}` });
      works.save(work);
    }
    return error ? { error: error.slice(0, 500) } : { ok: true, agentId, out: `started ${agentId}${createdWorkspace ? ` in new workspace ${createdWorkspace}` : ''}` };
  }

  async function startDispatch(id: string) {
    const conv = load(id);
    if (!conv?.dispatchProposal) return { error: 'no dispatch proposal on this run' };
    const p = conv.dispatchProposal;
    const slug = conv.workSlug || p.workSlug;
    if (!dispatch || !slug) return { error: 'a dispatch needs a work' };
    try {
      const r = await dispatch(slug, { entry: p.entry, key: p.pr, prompt: p.prompt, persona: p.persona, edits: p.edits });
      return { ok: true, agentId: r.agentId, out: `started ${r.title}` };
    } catch (e) {
      return { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
    }
  }

  async function startAddRepo(id: string): Promise<AddRepoResult> {
    const conv = load(id);
    if (!conv?.repoProposal) return { ok: false, error: 'no repo proposal on this run' };
    if (!addRepo) return { ok: false, error: 'this coco cannot add repos' };
    return addRepo(conv.repoProposal.source).catch((e) => ({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }));
  }

  // the latest conversations, of one scope (its scopeKey) when given
  function list(scope?: string | null) {
    return metas().map((m) => meta(convs.get(m.id) ?? m)).filter((m) => !scope || scopeKey(m.scope) === scope).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  // the conversation's log, then every new event while the page watches; a reconnect replays the whole log
  function watch(req: Req, res: Res, conv: Conv) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const write = (ev: Event) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    for (const ev of conv.events) write(ev);
    conv.listeners.add(write);
    req.on('close', () => conv.listeners.delete(write));
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, action] = parts;
    const body = async () => JSON.parse((await readBody(req)) || '{}');
    const filesOf = (ids: unknown) => {
      try {
        return uploads.resolve(ids);
      } catch (e) {
        send(res, httpStatus(e), { error: errorMessage(e) });
        return null;
      }
    };
    if (!id) {
      if (req.method === 'POST') {
        const b = await body();
        const files = filesOf(b.attachments);
        if (!files) return;
        const prompt = String(b.prompt || '').trim() || (files.length ? FILES_ONLY : '');
        if (!prompt) return send(res, 400, { error: 'prompt required' });
        if (b.repoId && !repos.some((r) => r.id === b.repoId)) return send(res, 400, { error: `unknown repo ${b.repoId}` });
        const conv = start({ prompt, workSlug: b.workSlug || null, pr: parseKey(b.pr), repoId: b.repoId || null, model: b.model || null, nonce: b.nonce, files });
        return send(res, 200, { id: conv.id });
      }
      return send(res, 200, list(new URL(req.url || '/', 'http://coco').searchParams.get('scope')));
    }
    const conv = load(id);
    if (!conv) return send(res, 404, { error: 'no such conversation' });
    if (action === 'events') return watch(req, res, conv);
    if (action === 'messages' && req.method === 'POST') {
      const { text, nonce, attachments } = await body();
      const files = filesOf(attachments);
      if (!files) return;
      const said = String(text || '').trim() || (files.length ? FILES_ONLY : '');
      if (!said) return send(res, 400, { error: 'text required' });
      say(conv, said, { nonce, files });
      return send(res, 200, { ok: true, status: conv.status });
    }
    if (action === 'close' && req.method === 'POST') return send(res, 200, await close(id));
    if (action === 'apply' && req.method === 'POST') return send(res, 200, apply(id, await body()));
    if (action === 'start-agent' && req.method === 'POST') return send(res, 200, await startAgent(id));
    if (action === 'dispatch' && req.method === 'POST') return send(res, 200, await startDispatch(id));
    if (action === 'add-repo' && req.method === 'POST') {
      const r = await startAddRepo(id);
      return send(res, r.ok ? 200 : 400, r);
    }
    return send(res, 200, meta(conv));
  }

  return {
    handle,
    list,
    start,
    say: (id: string, text: string, opts?: { nonce?: unknown }) => {
      const conv = load(id);
      return conv ? say(conv, text, opts) : undefined;
    },
    close,
    reap,
    resume,
    boot,
    load,
    byAgent: (agentId: string) => [...convs.values()].find((c) => c.agentId === agentId) || null,
  };
}
