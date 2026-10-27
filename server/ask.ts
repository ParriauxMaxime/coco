// "Ask coco": a conversation with one Paseo agent that has the cocopilot MCP server; follow-ups go to the same agent, steering the turn in flight, and the transcript streams over SSE.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileKey, keyLabel, parseKey, rowKey } from './stack.ts';
import { UUID, activityEvents, createPaseoAgents, workCwd } from './paseo-agent.ts';
import type { AgentSession, Outcome } from './paseo-agent.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import type { PrInfo, ReadBody, Req, Res, RowKey, Send, StackRow, TimelineEntry, Work } from './core-types.ts';
import type { AddRepoResult } from './repos.ts';
import { list as listOf, opt, str, strip } from './cards.ts';
import type { ActionDef, Card } from './cards.ts';
import type { Raw } from './blocks.ts';
import { FILES_ONLY, agentInput, createUploads, uploadRef } from './uploads.ts';
import type { Upload, Uploads } from './uploads.ts';
import type { ModelPick, Models } from './models.ts';

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
type AgentProposal = { title: string; prompt: string; why?: string; workspaceId?: string; cwd?: string; provider?: string; thinking?: string; workSlug?: string };
type DispatchProposal = { entry: string; pr?: number | string; prompt?: string; persona?: string; edits?: boolean; workSlug: string; why?: string };
type RepoProposal = { source: string; why?: string };
// the latest proposal card of a conversation, for lists; older conversations kept the proposals themselves
type Proposed = { kind: 'work' | 'agent' | 'dispatch' | 'repo'; title: string };
const PROPOSED: Record<Proposed['kind'], string> = { work: 'a work scaffold', agent: 'a Paseo agent', dispatch: 'a dispatch of', repo: 'adding the repo' };
type Legacy = { proposal?: Scaffold | null; agentProposal?: AgentProposal | null; dispatchProposal?: DispatchProposal | null; repoProposal?: RepoProposal | null };
const legacyProposed = (c: Legacy): Proposed | null =>
  c.proposal ? { kind: 'work', title: c.proposal.title || c.proposal.slug } : c.agentProposal ? { kind: 'agent', title: c.agentProposal.title } : c.dispatchProposal ? { kind: 'dispatch', title: c.dispatchProposal.entry } : c.repoProposal ? { kind: 'repo', title: c.repoProposal.source } : null;
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
  thinking?: string | null;
  startedAt: string;
  lastActivity: string;
  status: string;
  turns: number;
  proposed: Proposed | null;
  text: string;
  agentId: string | null;
  // every agent the conversation had, the current one last: their cards stay listed
  agentIds: string[];
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
const META = ['id', 'prompt', 'scope', 'workSlug', 'pr', 'kind', 'model', 'thinking', 'startedAt', 'lastActivity', 'status', 'turns', 'proposed', 'text', 'agentId', 'agentIds', 'cost', 'costBase', 'once'] as const satisfies readonly (keyof Conv)[];
type Meta = Pick<Conv, (typeof META)[number]>;
type TurnEnd = { status: string; error?: string | null; text?: string; cost?: number | null };
type CardFeed = { ofAgent(agentId: string): Card[]; onChange(l: (agentId: string) => void): () => void };
type AskWork = Work & { stack?: StackRow[]; timeline?: TimelineEntry[] };
type AskOptions = {
  DATA: string;
  APP?: string | null;
  REPO: string;
  config: { owner: { name: string }; models: { default: string; fast?: string }; gateSkills?: Record<string, (string | { name: string; ask?: string })[]>; methodSkill?: string; methodNotes?: string; repos?: { id: string; name: string; github: string; path: string }[] };
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
  // the cards store, read lazily: the conversation stream also carries its agents' cards
  cards?: () => CardFeed;
  // checks a composer's model and thinking pick, and applies it to a live agent
  models?: Pick<Models, 'check' | 'apply'>;
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const texts = (v: unknown, field: string, max: number, len = 200) => (v == null ? [] : listOf(v, 0, max, field).map((x, i) => str(String(x ?? ''), len, `${field}[${i}]`)));
const each = <T>(v: unknown, field: string, max: number, make: (r: Raw, at: string) => T) => (v == null ? [] : listOf(v, 0, max, field).map((r, i) => make(r ?? {}, `${field}[${i}]`)));
const optNumber = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function scaffoldOf(p: Raw): Scaffold {
  const slug = str(p.slug, 80, 'slug');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error('slug must be kebab-case');
  const project = p.paseoProject && typeof p.paseoProject === 'object' ? strip({ existingProjectId: opt(p.paseoProject.existingProjectId, 120, 'paseoProject.existingProjectId'), createNamed: opt(p.paseoProject.createNamed, 120, 'paseoProject.createNamed') }) : undefined;
  return strip({
    slug,
    title: str(p.title, 100, 'title'),
    description: opt(p.description, 30000, 'description'),
    summary: opt(p.summary, 1000, 'summary'),
    tier: opt(p.tier, 20, 'tier'),
    paseoProject: project,
    stack: each(p.stack, 'stack', 40, (s, at) => strip({ order: optNumber(s.order) ?? 0, title: str(s.title, 200, `${at}.title`), scope: opt(s.scope, 2000, `${at}.scope`) ?? '', branch: str(s.branch, 200, `${at}.branch`), personas: texts(s.personas, `${at}.personas`, 20), existingPr: optNumber(s.existingPr) })),
    surfaces: each(p.surfaces, 'surfaces', 40, (s, at) => ({ surface: str(s.surface, 200, `${at}.surface`), entryPoint: opt(s.entryPoint, 500, `${at}.entryPoint`) ?? '', coverage: opt(s.coverage, 1000, `${at}.coverage`) ?? '' })),
    personas: texts(p.personas, 'personas', 20),
    links: each(p.links, 'links', 20, (l, at) => ({ label: str(l.label, 200, `${at}.label`), url: str(l.url, 2000, `${at}.url`) })),
    openQuestions: each(p.openQuestions, 'openQuestions', 8, (q, at) => ({ question: str(q.question, 1000, `${at}.question`), recommendation: opt(q.recommendation, 1000, `${at}.recommendation`) ?? '', tradeoff: opt(q.tradeoff, 1000, `${at}.tradeoff`) ?? '' })),
    notes: opt(p.notes, 30000, 'notes'),
    nextSteps: texts(p.nextSteps, 'nextSteps', 20, 1000),
    betaFlags: p.betaFlags == null ? undefined : each(p.betaFlags, 'betaFlags', 20, (f, at) => strip({ code: str(f.code, 120, `${at}.code`), why: opt(f.why, 500, `${at}.why`) ?? '', prs: Array.isArray(f.prs) ? f.prs.filter((n: unknown) => typeof n === 'number') : undefined })),
  });
}

// the confirm card of a scaffold: what Create work (or Update work) writes, and whether an existing stack is replaced
function scaffoldCard(p: Scaffold, existing: AskWork | null | undefined): Raw {
  const paseo = p.paseoProject?.existingProjectId ? `existing ${p.paseoProject.existingProjectId}` : p.paseoProject?.createNamed ? `create "${p.paseoProject.createNamed}"` : 'none';
  const blocks: Raw[] = [{ type: 'text', text: cut(`\`${p.slug}\`${p.tier ? ` · tier **${p.tier}**` : ''} · Paseo project: ${paseo} · personas: ${p.personas?.join(', ') || 'none'}`, 2000) }];
  const kept = existing?.stack?.length ?? 0;
  if (existing) blocks.push({ type: 'callout', tone: 'warn', title: 'Existing work', text: `"${existing.title || p.slug}" already exists: approving replaces its title, description, notes, personas and links${kept ? `; its stack of ${kept} PRs stays unless you tick the box below` : ''}.` });
  if (p.stack?.length) blocks.push({ type: 'table', caption: 'Planned stack', columns: ['#', 'PR', 'Scope', 'Branch', 'Reviewers'], rows: p.stack.map((s) => [String(s.order), s.existingPr ? `${s.title} (#${s.existingPr})` : s.title, s.scope || '', `\`${s.branch}\``, s.personas?.length ? s.personas.join(', ') : { text: 'none', tone: 'warn' }]) });
  if (p.surfaces?.length) blocks.push({ type: 'table', caption: 'Surfaces', columns: ['Surface', 'Entry point', 'Coverage'], rows: p.surfaces.map((s) => [s.surface, s.entryPoint ? `\`${s.entryPoint}\`` : '', s.coverage]) });
  if (p.openQuestions?.length) blocks.push({ type: 'table', caption: 'Open questions', columns: ['Question', 'Recommended', 'Tradeoff'], rows: p.openQuestions.map((q) => [q.question, q.recommendation, { text: q.tradeoff || '-', tone: 'mute' }]) });
  if (p.betaFlags?.length) blocks.push({ type: 'table', caption: 'Feature flags', columns: ['Flag', 'Gates', 'PRs'], rows: p.betaFlags.map((f) => [`\`${f.code}\``, f.why, f.prs?.length ? f.prs.join(', ') : 'all']) });
  if (p.notes) blocks.push({ type: 'code', lang: 'markdown', code: cut(p.notes, 4000), caption: 'Notes for the work' });
  if (p.nextSteps?.length) blocks.push({ type: 'steps', title: 'Next steps', items: p.nextSteps.slice(0, 12).map((s) => cut(s, 500)) });
  return {
    kind: 'confirm',
    title: cut(`${existing ? 'Update' : 'Create'} work: ${p.title}`, 120),
    question: p.summary ? cut(p.summary, 500) : undefined,
    blocks,
    fields: kept ? [{ key: 'replaceStack', label: `Replace its ${kept} stack rows with the planned stack`, type: 'toggle', default: false }] : undefined,
    confirmLabel: existing ? 'Update work' : 'Create work',
  };
}

function agentOf(p: Raw): AgentProposal {
  const cwd = opt(p.cwd, 500, 'cwd');
  if (cwd && !path.isAbsolute(cwd)) throw new Error('cwd must be an absolute path');
  return strip({ title: str(p.title, 120, 'title'), prompt: str(p.prompt, 60000, 'prompt'), why: opt(p.why, 500, 'why'), workspaceId: opt(p.workspaceId, 120, 'workspaceId'), cwd, provider: opt(p.provider, 120, 'provider'), thinking: opt(p.thinking, 20, 'thinking'), workSlug: opt(p.workSlug, 80, 'workSlug') });
}

const dispatchOf = (p: Raw, workSlug: string): DispatchProposal =>
  strip({ entry: str(p.entry, 200, 'entry'), pr: optNumber(p.pr) ?? opt(p.pr, 200, 'pr'), prompt: opt(p.prompt, 30000, 'prompt'), persona: opt(p.persona, 80, 'persona'), edits: typeof p.edits === 'boolean' ? p.edits : undefined, workSlug, why: opt(p.why, 500, 'why') });

const repoAdded = (r: AddRepoResult) => [
  `${r.repo?.name} ${r.how === 'cloned' ? 'cloned into' : r.how === 'found' ? 'found at' : 'at'} ${r.repo?.path}`,
  r.project?.error ? `no Paseo project: ${r.project.error}` : r.project ? `Paseo project ${r.project.name}` : null,
  r.setup?.error ? `setup run failed: ${r.setup.error}` : r.setup?.agentId ? `setup run ${r.setup.agentId.slice(0, 8)} proposes its config` : null,
].filter(Boolean).join(' · ');

export function createAsk({ DATA, APP, REPO, config, works, agents = createPaseoAgents({ APP }), idleMs = IDLE_MS, place, dispatch, addRepo, uploads = createUploads({ DATA }), cards, models }: AskOptions) {
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
To add, move, update or remove PRs of an existing work, or to sync its Notion page, use propose_stack_edit: rows keep their Notion pages.
When ${OWNER} asks you to answer or reply to a PR comment (a reviewer, Sentry, a finding), draft it and call propose_pr_reply with the comment id: ${OWNER} posts it from the card. Never refuse it or hand back a gh command.
When ${OWNER} asks for a change to coco itself, call flag_coco_issue with ${OWNER}'s words and answer with the link it returns. Never refuse it, never change coco code from another work.
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
This is a conversation: ${OWNER} follows up in the same session, sometimes while you are still working; answer the latest message and keep what was already settled.${config.models.fast ? `\nHand focused subtasks (a single-file read, a search, a per-file review) to subagents on the fast model ${config.models.fast.split('/').slice(1).join('/')}; keep the synthesis yourself.` : ''}`;

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
  const agentsOf = (c: { agentId: string | null; agentIds?: string[] | null }) => [...new Set([...(c.agentIds || []), ...(c.agentId ? [c.agentId] : [])])];
  const meta = (c: Meta & Legacy): Meta => ({ ...(Object.fromEntries(META.map((k) => [k, c[k] ?? null])) as Meta), scope: scopeOf(c), proposed: c.proposed || legacyProposed(c), agentIds: agentsOf(c) });
  const save = (c: Conv) => fs.writeFileSync(fileOf(c.id, 'json'), JSON.stringify(meta(c), null, 1));
  const now = () => new Date().toISOString();
  const metas = (): Meta[] => fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  const remember = (c: Meta, events: Event[] = []): Conv => {
    const conv: Conv = { ...meta(c), events, listeners: new Set(), session: null, fresh: false, stream: null };
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
        systemPrompt: `${SYSTEM + tierOf(conv)}\nYou run as ${providerFor(conv.model)}${conv.thinking ? `, thinking ${conv.thinking}` : ''}.`,
        provider: providerFor(conv.model),
        ...(conv.thinking ? { thinking: conv.thinking } : {}),
        cwd,
        workspaceId,
        labels: { source: 'cocopilot', kind: conv.kind, ask: conv.id.slice(0, 8), work: conv.workSlug, pr: conv.pr == null ? null : fileKey(conv.pr), repo: conv.scope.kind === 'repo' ? conv.scope.repoId : null },
        ...stream,
      });
      Object.assign(conv, { agentId: s.agentId, agentIds: agentsOf({ agentId: s.agentId, agentIds: conv.agentIds }), costBase: conv.cost || 0, fresh: true });
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
    const p = conv.proposed;
    return [
      `This continues an Ask conversation whose previous agent is gone. The conversation so far${all.length > HISTORY_MAX ? ' (oldest part cut)' : ''}:`,
      '',
      all.slice(-HISTORY_MAX),
      '',
      ...(p ? [`You already proposed ${PROPOSED[p.kind]} "${p.title}" on a card; propose again only what changes.`, ''] : []),
      `## ${OWNER}'s new message`,
      '',
      text,
    ].join('\n');
  }

  // a turn's end: cost is per agent and cumulative
  function settle(conv: Conv, r: TurnEnd) {
    conv.stream?.flush();
    const open = OPEN.includes(conv.status);
    if (open && r.error) push(conv, { type: 'stderr', text: r.error.slice(0, 2000) });
    if (r.text) conv.text = r.text;
    if (r.cost != null) conv.cost = (conv.costBase || 0) + r.cost;
    conv.turns = (conv.turns || 0) + 1;
    if (open) conv.status = conv.session ? 'idle' : 'parked';
    push(conv, { type: 'end', status: open ? r.status : 'stopped', cost: conv.cost, conversation: conv.status, agentId: conv.agentId });
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

  // a composer's model or thinking pick: the live agent switches in place, else the next agent starts with it
  async function repick(conv: Conv, pick: ModelPick) {
    if (!models || (pick.provider == null && pick.thinking == null)) return;
    const current = providerFor(conv.model);
    const p = await models.check(pick, current);
    const model = p.provider ?? conv.model;
    const thinking = p.thinking ?? conv.thinking ?? null;
    if (providerFor(model) === current && thinking === (conv.thinking ?? null)) return;
    Object.assign(conv, { model, thinking });
    save(conv);
    const live = conv.agentId && OPEN.includes(conv.status) ? await models.apply(conv.agentId, p).then(() => true, () => false) : false;
    push(conv, { type: 'meta', text: `model ${providerFor(model)}${thinking ? ` · thinking ${thinking}` : ''}${live ? '' : ', from the next agent'}` });
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

  // onEnd(conv) fires after each turn. once: the agent is archived after the first turn, and answers to its cards are not delivered
  // the scope: the work's when there is one, else the repo's, else global
  function start({ prompt, workSlug = null, pr = null, repoId = null, model = null, thinking = null, kind = 'ask', nonce = null, files = [] }: { prompt: string; workSlug?: string | null; pr?: RowKey | null; repoId?: string | null; model?: string | null; thinking?: string | null; kind?: string; nonce?: unknown; files?: Upload[] }, { onEnd, once = false }: { onEnd?: (conv: Conv) => void; once?: boolean } = {}) {
    const scope: AskScope = workSlug ? { kind: 'work', slug: workSlug } : repoId ? { kind: 'repo', repoId } : { kind: 'global' };
    const conv = remember({ id: randomUUID(), prompt, scope, workSlug, pr: workSlug ? pr : null, kind, model, thinking, startedAt: now(), lastActivity: now(), status: 'idle', turns: 0, proposed: null, text: '', agentId: null, agentIds: [], cost: null, costBase: 0, once });
    conv.onEnd = onEnd;
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
          push(conv, { type: 'end', status: 'stopped', cost: conv.cost, conversation: conv.status });
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

  // the conversation an agent belongs to, past agents and saved conversations included
  function convOf(agentId: string) {
    const live = [...convs.values()].find((c) => agentsOf(c).includes(agentId));
    if (live) return live;
    const saved = metas().find((m) => agentsOf(m).includes(agentId));
    return saved ? load(saved.id) : null;
  }
  const from = (conv: Conv | null, agentId: string) => (conv ? `ask ${conv.id.slice(0, 8)}: "${conv.prompt.slice(0, 120)}"` : `agent ${agentId.slice(0, 8)}`);

  function apply(p: Scaffold, { scope, source, replaceStack = false }: { scope: AskScope; source: string; replaceStack?: boolean }) {
    const existing = works.get(p.slug);
    const stackKept = Boolean(existing?.stack?.length && !replaceStack);
    const stack = (p.stack || []).map((s) => ({ number: s.existingPr || null, planned: { order: s.order, title: s.title, scope: s.scope, branch: s.branch }, personas: s.personas || [] }));
    const notes = [p.notes, '', '## Surface table', '', '| Surface | Entry point | Coverage |', '| --- | --- | --- |', ...(p.surfaces || []).map((s) => `| ${s.surface} | ${s.entryPoint} | ${s.coverage} |`), '', '## Open questions', '', ...(p.openQuestions || []).map((q, i) => `${i + 1}. ${q.question} Recommended: ${q.recommendation}. Tradeoff: ${q.tradeoff}`), '', '## Next steps', '', ...(p.nextSteps || []).map((s) => `- ${s}`)].join('\n');
    const work: AskWork = {
      ...(existing || { createdAt: new Date().toISOString(), timeline: [] }),
      slug: p.slug,
      ...(!existing?.repo && scope.kind === 'repo' ? { repo: scope.repoId } : {}),
      title: (p.title || '').slice(0, 100),
      description: p.description || '',
      summary: p.summary,
      tier: p.tier,
      projectId: p.paseoProject?.existingProjectId || existing?.projectId || null,
      projectName: p.paseoProject?.createNamed || existing?.projectName || null,
      stack: existing && stackKept ? existing.stack : stack.map((s) => {
        const old = existing?.stack?.find((o) => rowKey(o) === rowKey(s));
        return old ? { ...old, ...s, planned: { ...old.planned, ...s.planned }, personas: s.personas.length ? s.personas : old.personas || [] } : s;
      }),
      personas: p.personas || [],
      links: p.links || [],
      notes,
      // a flag tied to planned PR orders follows those rows' keys (PR number once opened, else the branch)
      betaFlags: !p.betaFlags ? existing?.betaFlags || [] : p.betaFlags.map((f) => ({ code: f.code, why: f.why, ...(f.prs?.length ? { prs: f.prs.map((order) => rowKey(stack.find((s) => s.planned.order === order))).filter(Boolean) } : {}) })),
    };
    work.timeline = [{ ts: new Date().toISOString(), kind: 'coco', text: `${existing ? 'updated' : 'created'} from ${source}` }, ...(work.timeline || [])];
    works.save(work);
    return { slug: work.slug, created: !existing, stackKept };
  }

  // labelled with its work and row, so it lists among the work's agents
  async function startAgent(p: AgentProposal, conv: Conv | null, agentId: string, at: { work: string | null; pr: string | null } = { work: null, pr: null }) {
    const slug = p.workSlug || conv?.workSlug || at.work;
    const work = slug ? works.get(slug) : null;
    const row = work?.slug === conv?.workSlug && conv?.pr != null ? fileKey(conv.pr) : work?.slug === at.work && at.pr ? fileKey(at.pr) : null;
    let started: { agentId?: string; createdWorkspace?: string | null } = {};
    let error = '';
    try {
      const placed = p.workspaceId ? { workspaceId: p.workspaceId, cwd: null } : p.cwd ? { workspaceId: null, cwd: p.cwd } : await where(work ? { kind: 'work', slug: work.slug } : conv?.scope ?? { kind: 'global' });
      started = await agents.start({ title: p.title, prompt: p.prompt, provider: providerFor(p.provider), thinking: p.thinking, ...placed, labels: { source: 'cocopilot', ask: (conv?.id ?? agentId).slice(0, 8), work: work?.slug, pr: row } });
    } catch (e) {
      error = errorMessage(e);
    }
    const { agentId: id = null, createdWorkspace = null } = started;
    if (work) {
      (work.timeline ||= []).unshift({ ts: new Date().toISOString(), kind: 'agent', text: `${error ? 'failed to start' : 'started'} Paseo agent "${p.title}"${id ? ` (${id.slice(0, 8)})` : ''} from ${from(conv, agentId)}${createdWorkspace ? `, in workspace ${createdWorkspace} created for it` : ''}` });
      works.save(work);
    }
    if (error) throw new Error(error);
    return { agentId: id, createdWorkspace };
  }

  // what an agent proposes on a card, checked when it posts it; approving the card runs it (docs/agent-io.md)
  const proposed = (card: Card, p: Proposed) => {
    const conv = convOf(card.agentId);
    if (!conv) return;
    conv.proposed = p;
    save(conv);
  };
  const actions: Record<string, ActionDef> = {
    work_scaffold: {
      card: (raw) => {
        const p = scaffoldOf(raw);
        return { input: p, card: scaffoldCard(p, works.get(p.slug)) };
      },
      run: async (card) => {
        const conv = convOf(card.agentId);
        const r = apply(scaffoldOf(card.action?.input ?? {}), { scope: conv?.scope ?? { kind: 'global' }, source: from(conv, card.agentId), replaceStack: card.answer?.values?.replaceStack === true });
        return { ok: true, detail: `${r.created ? 'created' : 'updated'} work ${r.slug}${r.stackKept ? ', its stack kept' : ''}`, link: `#/work/${r.slug}` };
      },
      posted: (card) => proposed(card, { kind: 'work', title: String(card.action?.input.title) }),
    },
    paseo_agent: {
      card: (raw, ctx) => {
        const p = agentOf(raw);
        const where = p.workspaceId ? `workspace \`${p.workspaceId}\`` : p.cwd ? `in \`${p.cwd}\`` : 'workspace picked by coco';
        const brief = { type: 'code', code: cut(p.prompt, 4000), caption: p.prompt.length > 4000 ? 'Brief (cut here: the agent gets all of it)' : 'Brief' };
        const work = p.workSlug || convOf(ctx.agentId)?.workSlug || ctx.work;
        return {
          input: p,
          card: { kind: 'confirm', title: cut(`Start agent: ${p.title}`, 120), question: p.why, blocks: [{ type: 'text', text: `**${providerFor(p.provider)}** · thinking ${p.thinking || 'default'} · ${where}${work ? ` · work \`${work}\`` : ''}` }, brief], confirmLabel: 'Start agent' },
        };
      },
      run: async (card) => {
        const p = agentOf(card.action?.input ?? {});
        const conv = convOf(card.agentId);
        const r = await startAgent(p, conv, card.agentId, card);
        const slug = p.workSlug || conv?.workSlug || card.work;
        return { ok: true, detail: `started agent ${r.agentId?.slice(0, 8) ?? ''}${r.createdWorkspace ? ` in new workspace ${r.createdWorkspace}` : ''}`, link: slug && r.agentId ? `#/work/${slug}/ag-${r.agentId}` : undefined };
      },
      posted: (card) => proposed(card, { kind: 'agent', title: String(card.action?.input.title) }),
    },
    dispatch: {
      card: (raw, ctx) => {
        const slug = convOf(ctx.agentId)?.workSlug || opt(raw.workSlug, 80, 'workSlug') || ctx.work;
        if (!dispatch) throw new Error('this coco cannot dispatch');
        if (!slug) throw new Error('a dispatch needs a work: pass workSlug');
        if (!works.get(slug)) throw new Error(`no work ${slug}`);
        const p = dispatchOf(raw, slug);
        const key = parseKey(p.pr);
        const on = p.pr == null ? 'the whole work' : key == null ? String(p.pr) : keyLabel(key);
        const blocks: Raw[] = [{ type: 'text', text: `work \`${slug}\` · on ${on}${p.persona ? ` · as \`${p.persona}\`` : ''}${p.edits ? ' · works on the PR branch' : ''}` }];
        if (p.prompt) blocks.push({ type: 'code', code: cut(p.prompt, 4000), caption: 'Prompt' });
        return { input: p, card: { kind: 'confirm', title: cut(`Start agent: ${p.entry} on ${on}`, 120), question: p.why, blocks, confirmLabel: 'Start agent' } };
      },
      run: async (card) => {
        const p = dispatchOf(card.action?.input ?? {}, String(card.action?.input.workSlug));
        if (!dispatch) throw new Error('this coco cannot dispatch');
        const r = await dispatch(p.workSlug, { entry: p.entry, key: p.pr, prompt: p.prompt, persona: p.persona, edits: p.edits });
        return { ok: true, detail: `started ${r.title}`, link: r.agentId ? `#/work/${p.workSlug}/ag-${r.agentId}` : `#/work/${p.workSlug}` };
      },
      posted: (card) => proposed(card, { kind: 'dispatch', title: String(card.action?.input.entry) }),
    },
    repo: {
      card: (raw) => {
        if (!addRepo) throw new Error('this coco cannot add repos');
        const p: RepoProposal = strip({ source: str(raw.source, 300, 'source'), why: opt(raw.why, 500, 'why') });
        const blocks = [{ type: 'callout', tone: 'note', title: 'What Add repo does', text: 'coco reuses a clone already on disk (matched by its origin remote) or clones it with gh, lists it in your config, adds its Paseo project and starts a setup run proposing its config.' }];
        return { input: p, card: { kind: 'confirm', title: cut(`Add repo ${p.source}`, 120), question: p.why, blocks, confirmLabel: 'Add repo' } };
      },
      run: async (card) => {
        if (!addRepo) throw new Error('this coco cannot add repos');
        const r = await addRepo(str(card.action?.input.source, 300, 'source'));
        return r.ok && r.repo ? { ok: true, detail: repoAdded(r), link: `#/repo/${r.repo.id}` } : { ok: false, detail: r.error || 'the repo was not added' };
      },
      posted: (card) => proposed(card, { kind: 'repo', title: String(card.action?.input.source) }),
    },
  };

  // the latest conversations, of one scope (its scopeKey) when given
  function list(scope?: string | null) {
    return metas().map((m) => meta(convs.get(m.id) ?? m)).filter((m) => !scope || scopeKey(m.scope) === scope).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  // the conversation's log, then every new event while the page watches; a reconnect replays the whole log
  // then the cards of every agent the conversation had, again whenever one of them changes
  function watch(sink: Sink, conv: Conv) {
    const write = (ev: Event) => sink.send(JSON.stringify(ev));
    const feed = cards?.();
    const sendCards = () => feed && sink.send(JSON.stringify(agentsOf(conv).flatMap((id) => feed.ofAgent(id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))), 'cards');
    for (const ev of conv.events) write(ev);
    sendCards();
    conv.listeners.add(write);
    const off = feed?.onChange((agentId) => agentsOf(conv).includes(agentId) && sendCards());
    sink.onClose(() => {
      conv.listeners.delete(write);
      off?.();
    });
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
        let pick;
        try {
          pick = models ? await models.check({ provider: b.provider, thinking: b.thinking }, config.models.default) : {};
        } catch (e) {
          return send(res, httpStatus(e), { error: errorMessage(e) });
        }
        const conv = start({ prompt, workSlug: b.workSlug || null, pr: parseKey(b.pr), repoId: b.repoId || null, model: pick.provider || b.model || null, thinking: pick.thinking || null, nonce: b.nonce, files });
        return send(res, 200, { id: conv.id });
      }
      return send(res, 200, list(new URL(req.url || '/', 'http://coco').searchParams.get('scope')));
    }
    const conv = load(id);
    if (!conv) return send(res, 404, { error: 'no such conversation' });
    if (action === 'events') return watch(sseSink(req, res), conv);
    if (action === 'messages' && req.method === 'POST') {
      const { text, nonce, attachments, provider, thinking } = await body();
      const files = filesOf(attachments);
      if (!files) return;
      const said = String(text || '').trim() || (files.length ? FILES_ONLY : '');
      if (!said) return send(res, 400, { error: 'text required' });
      try {
        await repick(conv, { provider, thinking });
      } catch (e) {
        return send(res, httpStatus(e), { error: errorMessage(e) });
      }
      say(conv, said, { nonce, files });
      return send(res, 200, { ok: true, status: conv.status });
    }
    if (action === 'close' && req.method === 'POST') return send(res, 200, await close(id));
    return send(res, 200, meta(conv));
  }

  return {
    handle,
    watch: (sink: Sink, id: string) => {
      const conv = load(id);
      if (!conv) throw new HttpError(404, 'no such conversation');
      watch(sink, conv);
    },
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
    convOf,
    actions,
  };
}
