// Threads and dispatch: the owner sends a decision card or a review comment to a small scoped agent and approves or dismisses what it suggests.
// Items on the same subject share a group: one agent and, for code, one worktree branched off the PR head (comments join the group touching their file).
// The agent writes its reply to a file; a code change is one commit per item (Cc-Comment trailer) that Approve cherry-picks onto the PR branch;
// a card change is a JSON file of fields that Approve writes to the card. Coco follows each group agent through the Paseo SDK: a message sent while
// it works steers its turn, and its activity streams to the threads waiting on it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileKey, keyLabel, parseKey, rowKey } from './stack.ts';
import { capitalize, commentSection, fenced, sharedRules } from './review-agent.ts';
import { findingLine, settledLines } from './briefs.ts';
import { blocksToMarkdown, salvageBlocks, validateBlocks } from './blocks.ts';
import { activityEvents, createPaseoAgents } from './paseo-agent.ts';
import { FILES_ONLY, agentInput, uploadRef } from './uploads.ts';
import { HttpError, errorMessage as errText, httpStatus } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import type { ActivityEvent, AgentSession, Outcome } from './paseo-agent.ts';
import type { Block } from './blocks.ts';
import type { ActionContext, Card, CardBody, CardEffect, ThreadHook } from './cards.ts';
import type { Upload, UploadRef, Uploads } from './uploads.ts';
import { failureText } from './agent-worktree.ts';
import type { AgentWorktrees, Verification } from './agent-worktree.ts';
import { reusable, verifyCommit } from './verify.ts';
import type { VerifyRun } from './verify.ts';
import type { Models } from './models.ts';
import type { Jobs } from './jobs.ts';
import type { Decision, Exec, PaseoAgentRow, ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';

const SETTLE_MS = 15000;
const TURN_MS = 45 * 60 * 1000;
const MAX_DIFF = 20000;
const STATE_FIELDS = ['id', 'status', 'choice', 'rationale', 'decidedAt'];
const OPEN_SUGGESTION = ['pending', 'queued', 'conflict'];

type Ref = { kind: 'decision'; id: string } | { kind: 'plan'; n: RowKey } | { kind: 'comment'; n: RowKey; id: string };
type CommentRef = Extract<Ref, { kind: 'comment' }>;
// one shape for the three things a thread hangs on (decision card, review plan, review comment): the fields each kind reads
type Item = { id: string; title?: string; path: string; startLine: number; endLine: number; side: 'head' | 'base'; snippet: string; ctxBefore: string[]; ctxAfter: string[]; body: string; headSha?: string; mergeBase?: string };
type ThreadPr = { head: string; sha: string; url?: string };
type CardSuggestion = { kind: 'card'; fields: Record<string, unknown>; state: string; error?: string };
// checks: coco's own run of the repo checks on the commit, running until it lands
type CommitSuggestion = { kind: 'commit'; commit: string; files: string[]; diff: string; state: string; error?: string; appliedCommit?: string; checks?: Verification | { state: 'running'; at: string; head: string } };
type Suggestion = CardSuggestion | CommitSuggestion;
// choices and picked: replies written before the agents asked through cards, shown read-only
type Choice = { label: string; text: string; change: boolean; option?: string };
// card: the card whose answer (a user message) or effect (a system note) it records
type Message = { id: string; role: string; text: string; ts: string; model?: string; agentId?: string; groupId?: string; turn?: string; steer?: boolean; blocks?: Block[]; suggestion?: Suggestion; choices?: Choice[]; picked?: number; card?: string; files?: UploadRef[] };
type Asked = { msgId: string; replyPath: string; cardPath: string };
// deps: the first prompt is held back while the worktree installs its dependencies (since when)
type Waiting = Asked & { groupId: string; agentId: string; sentAt: string; sha?: string | null; earlier?: Asked[]; deps?: { since: string } };
// sentBack: a failed check already went back to the agent since the owner's last message
// verifies: the owner's Verify runs by commit sha
type Thread = { key: string; groupId: string | null; waiting: Waiting | null; messages: Message[]; newGroup?: boolean; sentBack?: boolean; verifies?: Record<string, VerifyRun> };
type GroupBase = { id: string; model: string; thinking?: string | null; agentId: string | null; items: string[]; status: string; createdAt: string; updatedAt?: string };
type DecisionGroup = GroupBase & { kind: 'decision'; decisionId: string; n?: undefined; files?: undefined; branch?: undefined; worktree?: undefined };
type PlanGroup = GroupBase & { kind: 'plan'; n: RowKey; decisionId?: undefined; files?: undefined; branch?: undefined; worktree?: undefined };
// briefed: the worktree section its agent was last told, sent again only once it changes
type CodeGroup = GroupBase & { kind: 'code'; n: RowKey; branch: string; worktree: string | null; files: string[]; decisionId?: undefined; briefed?: string };
type Group = DecisionGroup | PlanGroup | CodeGroup;
type Finding = { action?: string; reason?: string; patch?: Record<string, unknown> };
type Reply = { text: string; blocks?: Block[]; finding?: Finding | null; error?: string; dropped?: string[] };
type SessionPromise = Promise<AgentSession | null> & { agentId?: string | null };
type ThreadEvent = { type: string; [key: string]: unknown };
type FindingActor = (slug: string, n: RowKey, id: string, action: { action: string; reason: string }) => Promise<unknown>;
type SharedConfig = Parameters<typeof sharedRules>[0];

type ThreadsOptions = {
  DATA: string;
  REPO: string;
  config: SharedConfig & { owner: { name: string }; models: { fast: string; default: string } };
  works: {
    get(slug: string): Work | null;
    list(): Work[];
    upsertDecision(slug: string, decision: Partial<Decision> & { id: string }): unknown;
    decide?(slug: string, input: { id: string; choice: string; rationale: string }): unknown;
    personasForPaths?(paths: string[]): { login: string }[];
  };
  comments: { list(slug: string, n: RowKey): { comments?: (Item & { status?: string })[] }; update(slug: string, n: RowKey, id: string, patch: Record<string, unknown>): Promise<unknown> };
  reviewAgent: {
    rowPr(work: Work, index: number): Promise<ThreadPr>;
    timeline?(slug: string, kind: string, text: string): void;
    agentsList(): Promise<PaseoAgentRow[]>;
    worktreeFor(branch: string): Promise<string | null>;
    sameDir(a: string, b: string): boolean;
    trailersBetween(cwd: string, from: string, to: string): Promise<{ id: string; commit: string }[]>;
  };
  reviewPlan: { planOf(slug: string, n: RowKey): unknown };
  exec?: Exec;
  agents?: ReturnType<typeof createPaseoAgents>;
  uploads?: Pick<Uploads, 'resolve' | 'record'>;
  cardsOf?: (slug: string, key: string) => Card[];
  jobs?: Pick<Jobs, 'start'>;
  // readies a code group's worktree before each turn and checks its commits
  worktrees?: Pick<AgentWorktrees, 'prepare' | 'whenReady' | 'briefLines'> & Partial<Pick<AgentWorktrees, 'verify' | 'head'>>;
  // where group agents run: plan and decision groups in the work's root workspace, code groups on a scratch branch in the work's project
  placement?: {
    place(scope: { kind: 'work'; slug: string }): Promise<{ workspaceId: string; cwd: string }>;
    sideWorkspace(slug: string, opts: { branch: string; base: string; title: string }): Promise<{ workspaceId: string; cwd: string }>;
  };
  // checks a model and thinking picked in the composer beyond the sonnet / opus shorthands
  models?: Pick<Models, 'check'>;
  // how long a code agent's first prompt waits for its worktree's dependencies, and how often it looks
  hold?: { ms: number; pollMs: number };
};

const isOpenSuggestion = (s?: Suggestion) => (s ? OPEN_SUGGESTION.includes(s.state) : false);
// d.<decision id> · c.<row file key>.<comment id> · p.<row file key> (the review plan)
const KEY = /^(d\.[\w-]+|c\.[\w.~-]+\.[0-9a-f]+|p\.[\w.~-]+)$/;
const GROUP = /^[0-9a-f]{6}$/;
const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, os.homedir());
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
// the hash that opens a thread's subject: a finding on its PR, the decisions, the review plan
export function threadLink(slug: string, key: string) {
  const ref = parseThreadKey(key);
  if (!ref) return `#/work/${slug}`;
  if (ref.kind === 'decision') return `#/work/${slug}/decisions`;
  const tab = `#/work/${slug}/findings-${encodeURIComponent(String(ref.n))}`;
  return ref.kind === 'comment' ? `${tab}/f-${ref.id}` : tab;
}

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLOCKS_DOC = path.join(APP_ROOT, 'skills/coco-findings/SKILL.md');

export function parseThreadKey(key: string): Ref | null {
  if (!KEY.test(String(key))) return null;
  if (key.startsWith('d.')) return { kind: 'decision', id: key.slice(2) };
  const rest = key.slice(2);
  if (key.startsWith('p.')) {
    const n = parseKey(rest.replaceAll('~', ':'));
    return n ? { kind: 'plan', n } : null;
  }
  const dot = rest.lastIndexOf('.');
  const n = parseKey(rest.slice(0, dot).replaceAll('~', ':'));
  return n ? { kind: 'comment', n, id: rest.slice(dot + 1) } : null;
}

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

export function createThreads({ DATA, REPO, config, works, comments, reviewAgent, reviewPlan, exec = defaultExec, agents = createPaseoAgents(), placement, uploads, cardsOf = () => [], worktrees, models, jobs, hold = { ms: 90_000, pollMs: 2000 } }: ThreadsOptions) {
  const MODELS: Record<string, string> = { sonnet: config.models.fast, opus: config.models.default };
  const SHARED_RULES = sharedRules(config);
  const OWNER = config.owner.name;
  const Owner = capitalize(OWNER);
  const git = (cwd: string, args: string[]) => exec('git', ['-C', cwd, ...args]);
  const dir = (slug: string) => path.join(DATA, 'works', slug, 'threads');
  const groupDir = (slug: string) => path.join(DATA, 'works', slug, 'groups');
  const changed = new Set<(slug: string, key: string) => void>();
  const readJson = <T>(f: string, fallback: T): T => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
  const writeJson = <T>(f: string, data: T): T => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    return data;
  };
  const read = (slug: string, key: string) => readJson<Thread>(path.join(dir(slug), `${key}.json`), { key, groupId: null, waiting: null, messages: [] });
  const write = (slug: string, thread: Thread) => {
    writeJson(path.join(dir(slug), `${thread.key}.json`), thread);
    notify(slug, thread.key, { type: 'thread' });
    changed.forEach((l) => l(slug, thread.key));
    return thread;
  };
  const readGroup = (slug: string, id: unknown) => (GROUP.test(String(id)) ? readJson<Group | null>(path.join(groupDir(slug), `${id}.json`), null) : null);
  const writeGroup = (slug: string, group: Group) => writeJson(path.join(groupDir(slug), `${group.id}.json`), { ...group, updatedAt: new Date().toISOString() });
  const listJson = <T>(d: string, name: (stem: string) => boolean = () => true): T[] => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json') && name(f.slice(0, -5))).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []);
  const listGroups = (slug: string) => listJson<Group>(groupDir(slug));
  // reply and card files share the directory
  const listThreads = (slug: string) => listJson<Thread>(dir(slug), (name) => KEY.test(name) && !/-[0-9a-f]{8}-(reply|card)$/.test(name));
  const message = (role: string, text: string, extra: Partial<Message> = {}): Message => ({ id: hex(4), role, text, ts: new Date().toISOString(), ...extra });

  const locks = new Map<string, Promise<unknown>>();
  const withLock = <T>(key: string, fn: () => Promise<T> | T): Promise<T> => {
    const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  };

  const check = (slug: string, key: string) => {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const ref = parseThreadKey(key);
    if (!ref) throw new HttpError(400, 'bad thread key');
    return { work, ref };
  };
  const itemOf = (slug: string, work: Work, ref: Ref) => {
    if (ref.kind === 'decision') return ((work.decisions || []).find((d) => d.id === ref.id) as Item | undefined) || null;
    if (ref.kind === 'plan') return reviewPlan.planOf(slug, ref.n) as Item | null;
    return (comments.list(slug, ref.n).comments || []).find((c) => c.id === ref.id) || null;
  };
  // the best-mapped persona of the file a comment (or its group) is on, for the "Ask <persona>" prefill
  const personaOf = (slug: string, work: Work, ref: Ref, group: Group | null) => {
    const file = ref.kind === 'comment' ? itemOf(slug, work, ref)?.path : group?.files?.[0];
    return (file && works.personasForPaths?.([file])[0]?.login) || null;
  };
  async function prOf(work: Work, n: RowKey) {
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (index < 0) throw new HttpError(404, `${keyLabel(n)} is not in this work`);
    return reviewAgent.rowPr(work, index);
  }
  const branchHead = async (branch: string) => {
    const r = await git(REPO, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };
  // Paseo may check a code group out on another branch than the one asked (cocopilot-<id>-1): the agent commits on its worktree's HEAD
  const worktreeHead = async (group: CodeGroup) => {
    const r = group.worktree ? await git(group.worktree, ['rev-parse', '--verify', '-q', 'HEAD']) : null;
    return r?.ok ? r.stdout.trim() : null;
  };
  const groupTip = async (group: CodeGroup) => (await worktreeHead(group)) || `refs/heads/${group.branch}`;
  // the PR's local head when it carries GitHub's (commits not pushed yet), else GitHub's
  const prBase = async (pr: ThreadPr | null) => {
    if (!pr) return null;
    const local = pr.head ? await branchHead(pr.head) : null;
    if (local && (!pr.sha || (await git(REPO, ['merge-base', '--is-ancestor', pr.sha, local])).ok)) return local;
    return pr.sha || pr.head || null;
  };
  // a clean group worktree behind the PR head moves forward before a turn, so the agent never answers from old code
  const catchUp = async (group: CodeGroup, pr: ThreadPr | null): Promise<string[]> => {
    const [base, head] = [await prBase(pr), await worktreeHead(group)];
    if (!group.worktree || !base || !head || base === head) return [];
    if ((await git(group.worktree, ['status', '--porcelain'])).stdout.trim()) return [];
    if (!(await git(group.worktree, ['merge-base', '--is-ancestor', head, base])).ok) return [];
    if (!(await git(group.worktree, ['merge', '--ff-only', '-q', base])).ok) return [];
    return [`- The PR moved since your last turn: coco fast-forwarded this worktree from \`${head.slice(0, 9)}\` to \`${base.slice(0, 9)}\`. Re-read the files you rely on.`, ''];
  };

  function summaries(slug: string) {
    return Object.fromEntries(listThreads(slug).map((t) => [t.key, {
      count: t.messages.length,
      waiting: Boolean(t.waiting),
      lastTs: t.messages.at(-1)?.ts || null,
      groupId: t.groupId,
      open: t.messages.filter((m) => isOpenSuggestion(m.suggestion)).length,
      asks: cardsOf(slug, t.key).filter((c) => c.status === 'open').length,
    }]));
  }

  // the group a dispatch goes to: the one asked for, the thread's own, else for a comment the open group of that PR touching its file, for a card the card's group
  function pickGroup(slug: string, ref: Ref, item: Item, thread: Thread, { groupId, model, thinking }: { groupId?: string | null; model?: string | null; thinking?: string | null }): Group {
    const open = listGroups(slug).filter((g) => g.status === 'active');
    const sameModel = (g: Group) => !model || g.model === model;
    if (groupId && groupId !== 'new') {
      const g = open.find((x) => x.id === groupId);
      if (!g) throw new HttpError(404, 'no such open group');
      return g;
    }
    if (groupId !== 'new' && !thread.newGroup) {
      // one live agent per comment: the group that already holds it takes it back, whatever model is picked now
      const holder = ref.kind === 'comment' ? open.find((g) => g.kind === 'code' && g.n === ref.n && g.items.includes(thread.key)) : undefined;
      if (holder) return holder;
      const own =open.find((g) => g.id === thread.groupId && sameModel(g));
      if (own) return own;
      const subject = open.find((g) => sameModel(g) && (ref.kind === 'decision' ? g.kind === 'decision' && g.decisionId === ref.id : ref.kind === 'plan' ? g.kind === 'plan' && g.n === ref.n : g.kind === 'code' && g.n === ref.n && g.files.includes(item.path)));
      if (subject) return subject;
    }
    const base = { id: hex(3), model: model || 'sonnet', ...(thinking ? { thinking } : {}), agentId: null, items: [], status: 'active', createdAt: new Date().toISOString() };
    if (ref.kind === 'decision') return { ...base, kind: 'decision', decisionId: ref.id };
    if (ref.kind === 'plan') return { ...base, kind: 'plan', n: ref.n };
    return { ...base, kind: 'code', n: ref.n, branch: `cocopilot/${base.id}`, worktree: null, files: [item.path] };
  }

  const findingRule = [
    `Only when ${OWNER} asks you to accept, dismiss or edit this finding, add to the reply JSON`,
    '`"finding": { "action": "accept" | "dismiss", "reason": "…", "patch": { "title", "severity", "confidence", "summary", "recommendation", "blocks" } }`',
    '(each part optional; dismiss needs a reason). cocopilot applies it after your turn; accept or dismiss may end your session. Never on your own initiative,',
    `except one case: when ${OWNER} picks an option that leaves the code unchanged, dismiss the finding in that same reply with the option as reason, without asking.`,
  ].join(' ');
  const askRule = (key: string, kind: string) => [
    `To have ${OWNER} pick between options, call cocopilot \`ask\` (a choice card) with \`thread: "${key}"\`, never a list to answer in text; the pick comes back as a new message.`,
    ...(kind === 'decision' ? ['An option with `effect: { "type": "take_decision", "option": "<card option key>" }` takes the decision on that card option when picked, without a new turn: only keys the card has.'] : []),
    ...(kind === 'comment' ? ['An option that leaves the code as is gets `effect: { "type": "dismiss_finding" }`: picking it dismisses the finding, without a new turn. Its `details` state the why in one sentence: it becomes the dismiss reason later agents read.'] : []),
    `End every turn with an \`ask\` card of next steps, your recommendation marked, unless the item was just settled: never stop on a plain answer that leaves ${OWNER} to type the next move.`,
  ].join(' ');
  const replyRule = (replyPath: string, kind: string, key: string) => [
    `Last step of your turn: call cocopilot \`post_reply\` with \`{ "blocks": [...], "thread": "${key}" }\` (typed blocks, never markdown); a refusal names the bad field: fix it and call again. Only if the tool is missing or keeps failing, write the same JSON \`{ "blocks": [...] }\` to \`${replyPath}\`.`,
    `Blocks (full reference: "Blocks" in \`${BLOCKS_DOC}\`): \`text\` (1-3 sentences), \`steps\` ({ title, items, outcome }), \`table\` ({ caption, columns, rows; a cell may be { text, tone } }),`,
    '`suggestion` ({ path, startLine, endLine, lang, after }: the code you propose at those lines; cocopilot shows it as a diff), `code` ({ path, line, lang, code }), `diagram` ({ mermaid, caption }), `callout` ({ tone, title, text }).',
    'Inline text: **bold**, `code`, path/file.ts:12 refs and <risk>…</risk> <warn> <ok> <note> marks. Lead with the answer; short.',
    'Link what the reader may open: files as repo-relative path:line (never a bare name), PRs as #123, commits as their sha in `code`, anything else in sources with its url.',
    askRule(key, kind),
    ...(kind === 'comment' ? [findingRule] : []),
  ].join(' ');

  function buildPrompt({ work, ref, item, thread, text, group, replyPath, cardPath, pr, setup, earlier }: { work: Work; ref: Ref; item: Item; thread: Thread; text: string; group: Group; replyPath: string; cardPath: string; pr: ThreadPr | null; setup: string[]; earlier: string | null }) {
    const history = thread.messages.filter((m) => m.role !== 'system').map((m) => `**${m.role === 'user' ? Owner : 'You'}:** ${m.text}${m.suggestion ? ` _(suggestion ${m.suggestion.state})_` : ''}`);
    const label = ref.kind === 'decision' ? '' : keyLabel(ref.n);
    const about = {
      decision: () => ({ title: `decision "${item.title}"`, section: ['## Decision card', '', fenced(JSON.stringify(item, null, 1), 'json')] }),
      plan: () => ({ title: `review plan of ${label}`, section: ['## Review plan (coco)', '', fenced(JSON.stringify(item, null, 1), 'json')] }),
      comment: () => {
        const settled = settledLines(work, ref.kind === 'comment' ? ref.n : null);
        const related = (comments.list(work.slug, ref.kind === 'comment' ? ref.n : '').comments || []).filter((c) => c.id !== item.id && c.path === item.path).map(findingLine);
        return {
          title: `review comment on ${item.path}:${item.startLine}-${item.endLine}, ${label}`,
          section: [
            '## Comment',
            '',
            ...commentSection(item),
            `PR branch \`${pr?.head}\`${pr?.url ? ` · ${pr.url}` : ''}. A finding's Recommendation is a hypothesis, not a decision.`,
            ...(settled.length ? ['', `## Settled, don't revisit`, '', ...settled] : []),
            ...(related.length ? ['', `## Other findings on ${item.path} (this PR)`, '', ...related, 'Do not contradict them without saying so.'] : []),
          ],
        };
      },
    }[ref.kind]();
    const rules = {
      decision: [
        `- To suggest a card change (question, summary, blocks, sources, options, rows, positions, confidence), write only the fields to change as one JSON object to \`${cardPath}\`; evidence goes in \`blocks\`, same types as your reply. Never status, choice, rationale or decidedAt: ${OWNER} takes the decision. Do not change files in the repo.`,
        SHARED_RULES[0],
      ],
      plan: [
        `- Read PR code only through git at the plan's head sha (\`git show ${item.headSha}:<path>\`, \`git grep -n <term> ${item.headSha}\`, \`git diff ${item.mergeBase} ${item.headSha} -- <path>\`); the working tree is on another branch. Change nothing.`,
        `- When the plan should be redone, say so and give the guidance in one short paragraph: ${OWNER} re-plans from cocopilot with it.`,
        SHARED_RULES[0],
      ],
      comment: [
        `- You work in your own worktree on branch \`${group.branch}\`, branched off the PR head; stay on it. To suggest a change, make it and commit ONE commit with the trailer \`Cc-Comment: ${item.id}\`, self-contained. ${Owner} presses Approve, which cherry-picks that commit onto the PR worktree (\`${pr?.head}\`). Never cherry-pick, merge or push onto the PR branch yourself. A suggestion shown as "dismissed" is ${Owner}'s call, not a failure. When you disagree, say why instead of changing it.`,
        `- When ${Owner}'s message is a question ("what do you recommend?", "why?", "options?"), answer it. Do not commit.`,
        ...SHARED_RULES,
      ],
    }[ref.kind];
    return [
      `# cocopilot · ${about.title} (work \`${work.slug}\`)`,
      '',
      `You are a scoped agent of cocopilot group ${group.id}${group.files ? ` (files: ${group.files.join(', ')})` : ''}. ${Owner} writes from cocopilot and reads your reply inline, under the item, then approves or dismisses each suggestion you make.`,
      '',
      ...about.section,
      '',
      ...(earlier ? ['## Earlier work on this comment', '', `${earlier}. Build on it or say why not; do not redo it.`, ''] : []),
      ...(history.length ? ['## Thread so far', '', ...history, ''] : []),
      `## ${Owner}'s message`,
      '',
      text,
      '',
      '## How to answer',
      '',
      `- ${replyRule(replyPath, ref.kind, thread.key)} Only that file and your cards show in cocopilot.`,
      ...rules,
      '',
      ...setup,
    ].join('\n');
  }

  // the agent still holds this thread in its context: only the new turn goes out, with what changed since its last answer
  function followUpPrompt({ ref, item, thread, text, replyPath, cardPath, agentId, steer, setup }: { ref: Ref; item: Item; thread: Thread; text: string; replyPath: string; cardPath: string; agentId: string; steer: boolean; setup: string[] }) {
    const lastSeen = thread.messages.findLastIndex((m) => m.agentId === agentId && m.role !== 'system');
    const lastSuggestion = thread.messages.slice(0, lastSeen + 1).findLast((m) => m.suggestion)?.suggestion;
    const since = [
      ...(lastSuggestion && lastSuggestion.state !== 'pending' ? [`- Your last suggestion is now ${lastSuggestion.state}.`] : []),
      ...thread.messages.slice(lastSeen + 1).filter((m) => m.role === 'system').map((m) => `- ${m.text}`),
    ];
    const where = ref.kind === 'comment' ? `the comment on ${item.path}:${item.startLine}` : ref.kind === 'plan' ? `the review plan of ${keyLabel(ref.n)}` : `decision "${item.title}"`;
    return [
      `# cocopilot · follow-up on ${where}`,
      '',
      ...(since.length ? ['## Since your last answer', '', ...since, ''] : []),
      `## ${Owner}'s message${steer ? ', sent while you were still on the previous one' : ''}`,
      '',
      text,
      '',
      ...(steer ? ['Take it into account in the work in flight. A reply you already wrote for the previous message stays; this message gets its own reply file below.', ''] : []),
      `Same rules as your first turn. Reply with cocopilot \`post_reply\` (\`{ "blocks": [...], "thread": "${thread.key}" }\`; fallback: the same JSON written to \`${replyPath}\`)${ref.kind === 'decision' ? `; a card change goes to \`${cardPath}\`` : ''}.`,
      '',
      ...(setup.length ? [setup[0].replace('## ', '## Changed since: '), ...setup.slice(1)] : []),
    ].join('\n');
  }

  // a code group's worktree, readied before each of its turns; its section goes in the prompt when it differs from what the agent was last told
  // a first prompt waits (up to hold.ms) while the worktree installs its dependencies; past that it says so, and the agent hears when they are ready
  async function setupOf(group: Group, s: AgentSession, first = false, onHold: () => void = () => {}) {
    if (group.kind !== 'code' || !worktrees) return [];
    const cwd = group.worktree || s.cwd();
    if (!cwd) return [];
    group.worktree = expandHome(cwd);
    let r = await worktrees.prepare(group.worktree).catch(() => null);
    if (!r) return [];
    const t0 = Date.now();
    if (first && r.state === 'preparing') onHold();
    while (first && r?.state === 'preparing' && Date.now() - t0 < hold.ms) {
      await new Promise((ok) => setTimeout(ok, hold.pollMs));
      r = (await worktrees.prepare(group.worktree, { retrying: true, start: false }).catch(() => null)) ?? r;
    }
    const late = first && r.state !== 'ready' && r.state !== 'off';
    if (r.state !== 'ready' && r.state !== 'off') worktrees.whenReady(group.worktree, s.agentId);
    const lines = worktrees.briefLines(r);
    const said = lines.join('\n');
    const waited = late ? [`- coco waited ${Math.round(hold.ms / 1000)}s for the dependencies and they are not ready: run no checks, no \`npm ci\` or install of your own. A message "checks are available now: <commands>" follows when they work; commit meanwhile and coco checks your commit.`, ''] : [];
    if (said === group.briefed) return waited;
    group.briefed = said;
    return [...lines, ...waited];
  }

  // a fix an earlier group already committed for this comment (its Cc-Comment trailer), for the brief of a fresh agent
  async function earlierFix(slug: string, ref: Ref, group: Group, pr: ThreadPr | null) {
    if (ref.kind !== 'comment' || !pr) return null;
    for (const g of listGroups(slug).filter((x): x is CodeGroup => x.id !== group.id && x.kind === 'code' && x.n === ref.n)) {
      const fix = (await reviewAgent.trailersBetween(REPO, pr.sha, await groupTip(g)).catch(() => [])).find((t) => t.id === ref.id);
      if (!fix) continue;
      const subject = (await git(REPO, ['show', '--no-patch', '--format=%s', fix.commit])).stdout.trim();
      return `an earlier agent already committed ${fix.commit.slice(0, 7)}${subject ? `: ${subject}` : ''} (branch \`${g.branch}\`)`;
    }
    return null;
  }

  // the readiness news of a group agent: steers its turn in flight; an idle one reads the changed section with its next prompt
  async function steerAgent(agentId: string, text: string) {
    for (const work of works.list().filter((w) => !w.archived)) {
      const group = listGroups(work.slug).find((g) => g.agentId === agentId && g.status === 'active');
      if (!group) continue;
      const s = await groupSession(work.slug, group);
      if (s?.busy()) await s.say(text);
      return true;
    }
    return false;
  }

  // live following: SSE listeners per thread; per group, the threads waiting on its agent with the message their activity belongs to
  const listeners = new Map<string, Set<(ev: ThreadEvent) => void>>();
  const routes = new Map<string, Map<string, string>>();
  const sessions = new Map<string, SessionPromise>();
  const following = new Set<string>();
  const at = (slug: string, id: string) => `${slug}\0${id}`;
  function notify(slug: string, key: string, ev: ThreadEvent) {
    for (const l of listeners.get(at(slug, key)) || []) l(ev);
  }
  const activityFile = (slug: string, key: string) => path.join(dir(slug), `${key}.activity.jsonl`);
  const readActivity = (slug: string, key: string): ThreadEvent[] => (fs.existsSync(activityFile(slug, key)) ? fs.readFileSync(activityFile(slug, key), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  function routeOf(slug: string, groupId: string) {
    const k = at(slug, groupId);
    let waiting = routes.get(k);
    if (!waiting) {
      waiting = new Map();
      for (const t of listThreads(slug)) if (t.waiting?.groupId === groupId) waiting.set(t.key, t.waiting.msgId);
      routes.set(k, waiting);
    }
    return waiting;
  }
  const route = (slug: string, groupId: string, key: string, msgId: string | null) => (msgId ? routeOf(slug, groupId).set(key, msgId) : routeOf(slug, groupId).delete(key));

  // a group agent's event goes to the threads waiting on it, only to the one whose reply or card file a tool call names when it names one;
  // a settled tool call may have written a reply, read at once
  function onActivity(slug: string, groupId: string, ev: ActivityEvent, keep: boolean) {
    const waiting = [...routeOf(slug, groupId)];
    const named = ev.type === 'tool' ? waiting.filter(([key]) => `${ev.summary}\n${ev.input}`.includes(`${path.sep}${key}-`)) : [];
    const targets = named.length ? named : waiting;
    for (const [key, msgId] of targets) {
      const line = { msgId, ...ev };
      if (keep) fs.appendFileSync(activityFile(slug, key), JSON.stringify(line) + '\n');
      notify(slug, key, line);
    }
    if (keep && ev.type === 'tool' && ev.status !== 'running') for (const [key] of targets) ingest(slug, key).catch(() => {});
  }
  const streamFor = (slug: string, groupId: string) => activityEvents({ keep: (ev) => onActivity(slug, groupId, ev, true), live: (ev) => onActivity(slug, groupId, ev, false) });

  // the group agent followed through the SDK, re-attached after a coco restart; null once it is gone
  function groupSession(slug: string, group: Group) {
    const k = at(slug, group.id);
    const held = sessions.get(k);
    if (held && held.agentId === group.agentId) return held;
    held?.then((s) => s?.detach());
    const p: SessionPromise = group.agentId && group.status === 'active' ? agents.session({ agentId: group.agentId, ...streamFor(slug, group.id) }).catch(() => null) : Promise.resolve(null);
    p.agentId = group.agentId;
    sessions.set(k, p);
    p.then((s) => !s && sessions.get(k) === p && sessions.delete(k));
    return p;
  }

  // the first dispatch of a group starts its agent, in a worktree branched off the PR head for code
  async function startSession(slug: string, group: Group, pr: ThreadPr | null) {
    const title = group.kind === 'code' ? `cc ${keyLabel(group.n)} · ${group.files[0]?.split('/').pop()}` : group.kind === 'plan' ? `cc plan ${keyLabel(group.n)}` : `cc decision ${group.decisionId}`;
    const worktree = group.kind === 'code' ? { mode: 'branch-off', newBranch: group.branch, base: (await prBase(pr)) ?? undefined, slug: `cc-${group.id}` } : null;
    let s;
    try {
      const fileName = group.files?.[0]?.split('/').pop() || 'the PR';
      const where = !placement
        ? { cwd: REPO, worktree }
        : worktree
          ? await placement.sideWorkspace(slug, { branch: worktree.newBranch, base: String(worktree.base || ''), title: `Finding fixes on ${fileName}` })
          : await placement.place({ kind: 'work', slug });
      if (group.kind === 'code' && 'workspaceId' in where && where.cwd) group.worktree = expandHome(where.cwd);
      s = await agents.session({ title, provider: MODELS[group.model] || group.model, thinking: group.thinking || 'high', ...where, labels: { source: 'cocopilot', kind: 'cc-group', work: slug, group: group.id, ...(group.kind === 'decision' ? {} : { pr: fileKey(group.n) }) }, ...streamFor(slug, group.id) });
    } catch (e) {
      throw new HttpError(500, `paseo agent start failed: ${errText(e).slice(0, 300)}`);
    }
    if (s.createdWorkspace) reviewAgent.timeline?.(slug, 'agent', `${worktree ? 'new branch-off worktree' : `no Paseo workspace was open on ${REPO}`}: created workspace ${s.createdWorkspace}`);
    const p: SessionPromise = Promise.resolve(s);
    p.agentId = s.agentId;
    sessions.get(at(slug, group.id))?.then((old) => old?.detach());
    sessions.set(at(slug, group.id), p);
    return s;
  }

  // a turn coco follows to its end: then every thread still waiting on that agent reads its reply, or learns there is none
  function track(slug: string, groupId: string, s: AgentSession, turn: Promise<Outcome | { steered: true }>) {
    following.add(s.agentId);
    turn.then(
      async (r) => {
        following.delete(s.agentId);
        if ('steered' in r) return;
        for (const [key, msgId] of [...routeOf(slug, groupId)]) {
          const end = { msgId, type: 'end', status: r.status, ...(r.cost != null ? { cost: r.cost } : {}), ...(r.error ? { error: String(r.error).slice(0, 500) } : {}) };
          fs.appendFileSync(activityFile(slug, key), JSON.stringify(end) + '\n');
          notify(slug, key, end);
          if (r.status !== 'timeout') await ingest(slug, key, null, { ended: true }).catch(() => {});
        }
        await drainQueue(slug).catch(() => {});
      },
      () => following.delete(s.agentId),
    );
  }

  // a thread waiting on an agent this coco run does not follow yet (a restart, a reload): re-attach and follow its turn
  async function follow(slug: string, key: string) {
    const { waiting } = read(slug, key);
    if (!waiting || waiting.deps || following.has(waiting.agentId)) return;
    const group = readGroup(slug, waiting.groupId);
    if (group?.status !== 'active' || group.agentId !== waiting.agentId) return;
    route(slug, group.id, key, waiting.msgId);
    const s = await groupSession(slug, group);
    if (s && !following.has(s.agentId)) track(slug, group.id, s, s.resume({ timeoutMs: TURN_MS }));
  }

  async function post(slug: string, key: string, { text, model, thinking, groupId, attachments }: { text?: string; model?: string | null; thinking?: string | null; groupId?: string | null; attachments?: unknown } = {}) {
    const { work, ref } = check(slug, key);
    const files = uploads?.resolve(attachments) ?? [];
    const said = String(text || '').trim() || (files.length ? FILES_ONLY : '');
    if (!said) throw new HttpError(400, 'text required');
    const short = Boolean(model && MODELS[model]);
    if (model && !short && !models) throw new HttpError(400, `model must be one of ${Object.keys(MODELS).join(', ')}`);
    const picked = models && (thinking || (model && !short)) ? await models.check({ provider: short ? MODELS[model || ''] : model, thinking }, MODELS[model || 'sonnet']) : {};
    const chosen = short ? model : picked.provider || model;
    const send = () => withLock(`${slug}:${key}`, () => dispatch(slug, work, ref, key, { text: said, model: chosen, thinking: picked.thinking, groupId, role: 'user', files }));
    if (!jobs) return send();
    // each message is its own job: a thread takes a second message while its agent still works
    const label = `Thread: ${said.split('\n')[0].slice(0, 50)}`;
    const { done } = jobs.start({ work: slug, pr: ref.kind === 'decision' ? null : ref.n, action: `thread:${key}:${crypto.randomUUID()}`, label, kind: 'agent' }, async () => {
      const thread = await send();
      return { agentId: thread.waiting?.agentId ?? null, thread };
    });
    return (await done).thread;
  }

  // a message (the owner's, a card answer, or cocopilot's own after a failed apply) goes to the item's group agent; while it works, it steers the turn in flight;
  // a card answer only reaches the agent that asked it, never a new one
  type Sending = { text: string; model?: string | null; thinking?: string | null; groupId?: string | null; role: string; files?: Upload[]; card?: Card };
  // one group picked and written at a time per file, so two first messages on different comments of a file land in one group
  const acquire = (lockKey: string) => {
    let release = () => {};
    const mine = new Promise<void>((ok) => (release = ok));
    const prev = locks.get(lockKey) || Promise.resolve();
    locks.set(lockKey, prev.then(() => mine));
    return prev.then(() => release);
  };
  // the first prompts being sent in the background (deps wait), by agent: a later message to the agent goes out after it
  const delivering = new Map<string, Promise<void>>();
  async function dispatch(slug: string, work: Work, ref: Ref, key: string, sending: Sending): Promise<Thread> {
    const subject = ref.kind === 'comment' ? itemOf(slug, work, ref) : null;
    const release = subject ? await acquire(`${slug}:file:${subject.path}`) : () => {};
    try {
      return await dispatchIn(slug, work, ref, key, sending, release);
    } finally {
      release();
    }
  }
  async function dispatchIn(slug: string, work: Work, ref: Ref, key: string, { text, model, thinking, groupId, role, files = [], card }: Sending, release: () => void): Promise<Thread> {
    const thread = read(slug, key);
    const item = itemOf(slug, work, ref);
    if (!item) throw new HttpError(404, `no such ${ref.kind}`);
    const prior = thread.waiting;
    const held = prior && readGroup(slug, prior.groupId);
    const group = held?.status === 'active' ? held : pickGroup(slug, ref, item, thread, { groupId, model, thinking });
    const live = await groupSession(slug, group);
    if (card && live?.agentId !== card.agentId) throw new Error('the agent that asked is gone');
    const pr = ref.kind === 'comment' ? await prOf(work, ref.n) : null;
    const msg = message(role, text, { ...(model && !held ? { model } : {}), ...(card ? { card: card.id } : {}), ...(files.length ? { files: files.map(uploadRef) } : {}) });
    const replyPath = path.join(dir(slug), `${key}-${msg.id}-reply.json`);
    const cardPath = path.join(dir(slug), `${key}-${msg.id}-card.json`);
    const busy = live && prior?.agentId === live.agentId ? prior : null;
    const seen = live && thread.messages.some((m) => m.agentId === live.agentId && m.role !== 'system');
    const moved = live && !busy && group.kind === 'code' ? await catchUp(group, pr) : [];
    const sha = busy ? busy.sha : group.kind === 'code' ? (await worktreeHead(group)) || (await branchHead(group.branch)) || pr?.sha : null;
    const s = live || (await startSession(slug, group, pr));
    if (!live && group.kind === 'code') delete group.briefed;
    // the prompts read the thread as it was before this message; the message is stored first so the owner sees it while a first prompt waits for the deps
    const prev: Thread = { ...thread, messages: [...thread.messages] };
    const fixed = live ? null : await earlierFix(slug, ref, group, pr);
    group.agentId = s.agentId;
    if (!group.items.includes(key)) group.items.push(key);
    writeGroup(slug, group);
    release();
    if (thread.groupId && thread.groupId !== group.id) leaveGroup(slug, thread.groupId, key);
    thread.messages.push({ ...msg, agentId: s.agentId, groupId: group.id, ...(seen ? { turn: 'follow-up' } : {}), ...(busy ? { steer: true } : {}) });
    if (role === 'user') delete thread.sentBack;
    thread.groupId = group.id;
    delete thread.newGroup;
    const earlier = busy ? [...(busy.earlier || []), { msgId: busy.msgId, replyPath: busy.replyPath, cardPath: busy.cardPath }] : [];
    thread.waiting = { msgId: msg.id, groupId: group.id, agentId: s.agentId, sentAt: msg.ts, replyPath, cardPath, sha, earlier };
    write(slug, thread);
    if (prior && prior.groupId !== group.id) route(slug, prior.groupId, key, null);
    route(slug, group.id, key, msg.id);
    const sendPrompt = (setup: string[]) => {
      writeGroup(slug, group);
      const prompt = seen ? followUpPrompt({ ref, item, thread: prev, text, replyPath, cardPath, agentId: s.agentId, steer: Boolean(busy), setup }) : buildPrompt({ work, ref, item, thread: prev, text, group, replyPath, cardPath, pr, setup, earlier: fixed });
      const messageId = files.length ? crypto.randomUUID() : null;
      if (messageId) uploads?.record(s.agentId, { messageId, text: prompt, at: msg.ts, attachments: files.map(uploadRef) });
      const steering = s.busy();
      const sent = s.say(prompt, { timeoutMs: TURN_MS, ...(messageId ? { input: { ...agentInput(files), messageId } } : {}) });
      if (steering) sent.catch((e) => addNote(slug, key, `Could not reach the agent: ${errText(e)}`.slice(0, 500)));
      else track(slug, group.id, s, sent);
    };
    // deps still installing (or a first prompt of this agent still held back): return now, wait and send in the background
    let hold = () => {};
    const holding = new Promise<'hold'>((ok) => (hold = () => ok('hold')));
    const setupP = setupOf(group, s, !seen, hold).then((lines) => [...moved, ...lines]);
    const ahead = delivering.get(s.agentId);
    const early = ahead ? 'hold' : await Promise.race([setupP, holding]);
    if (early !== 'hold') {
      sendPrompt(early);
      return thread;
    }
    thread.waiting = { ...thread.waiting!, deps: { since: ahead ? new Date().toISOString() : thread.waiting!.sentAt } };
    write(slug, thread);
    const job: Promise<void> = (async () => {
      const setup = await setupP;
      await ahead?.catch(() => {});
      await withLock(`${slug}:${key}`, () => {
        const t = read(slug, key);
        if (t.waiting?.deps && delivering.get(s.agentId) === job) {
          delete t.waiting.deps;
          t.waiting.sentAt = new Date().toISOString();
          write(slug, t);
        }
        sendPrompt(setup);
      });
    })()
      .catch((e) => void addNote(slug, key, `Could not send to the agent: ${errText(e)}`.slice(0, 500)))
      .finally(() => void (delivering.get(s.agentId) === job && delivering.delete(s.agentId)));
    delivering.set(s.agentId, job);
    return thread;
  }

  function leaveGroup(slug: string, id: string, key: string) {
    const g = readGroup(slug, id);
    if (g) writeGroup(slug, { ...g, items: g.items.filter((k) => k !== key) });
  }

  // what the agent suggested for this item since the message: its latest commit with the item's trailer, or a card JSON
  async function suggestionOf(slug: string, ref: Ref, waiting: Waiting): Promise<Suggestion | null> {
    if (ref.kind === 'decision') {
      const fields = readJson<Record<string, unknown> | null>(waiting.cardPath, null);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
      for (const k of STATE_FIELDS) delete fields[k];
      return Object.keys(fields).length ? { kind: 'card', fields, state: 'pending' } : null;
    }
    const group = readGroup(slug, waiting.groupId);
    if (!group || group.kind !== 'code' || !waiting.sha) return null;
    const fix = (await reviewAgent.trailersBetween(REPO, waiting.sha, await groupTip(group))).find((t) => ref.kind === 'comment' && t.id === ref.id);
    if (!fix) return null;
    const [diff, names] = await Promise.all([git(REPO, ['show', '--format=', '--stat', '--patch', fix.commit]), git(REPO, ['show', '--format=', '--name-only', fix.commit])]);
    const files = names.stdout.split('\n').filter(Boolean);
    writeGroup(slug, { ...group, files: [...new Set([...group.files, ...files])] });
    return { kind: 'commit', commit: fix.commit, files, diff: diff.stdout.slice(0, MAX_DIFF), state: 'pending' };
  }

  // a reply is `{ "blocks": [...] }` (typed blocks, as on finding cards); `text` keeps its markdown twin for the next prompts' history.
  // Older waits point at a `.md` reply; a reply that is not valid blocks still shows, as text
  async function readReply(file: string, sha?: string | null): Promise<Reply> {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (file.endsWith('.md')) return { text: raw };
    let blocks: Block[];
    let dropped: string[];
    let finding: Finding | null;
    try {
      const json = JSON.parse(raw);
      ({ blocks, dropped } = salvageBlocks(json.blocks));
      finding = json.finding && typeof json.finding === 'object' ? json.finding : null;
    } catch (e) {
      return { text: raw, error: errText(e) };
    }
    // a suggestion's `before` is read at the agent's base, never trusted
    for (const b of blocks.filter((x) => x.type === 'suggestion')) {
      const r = sha ? await git(REPO, ['show', `${sha}:${b.path}`]) : { ok: false, stdout: '' };
      const lines = r.ok ? r.stdout.split('\n') : null;
      b.before = lines && b.endLine <= lines.length ? lines.slice(b.startLine - 1, b.endLine).join('\n') : undefined;
    }
    return { blocks, text: blocksToMarkdown({ blocks }), finding, ...(dropped.length ? { dropped } : {}) };
  }

  // what an agent asked to do to its own finding (only on the owner's request, per its prompt): edit it now, accept or dismiss once the thread lock is free
  const PATCHABLE = ['title', 'severity', 'confidence', 'summary', 'recommendation', 'blocks'];
  let findingActor: FindingActor | null = null;
  const setFindingActor = (fn: FindingActor) => (findingActor = fn);
  const addNote = (slug: string, key: string, text: string) => withLock(`${slug}:${key}`, () => {
    const thread = read(slug, key);
    thread.messages.push(message('system', text));
    return write(slug, thread);
  });
  async function applyFinding(slug: string, ref: CommentRef, key: string, finding: Finding) {
    const notes: string[] = [];
    const patch = Object.fromEntries(Object.entries(finding.patch || {}).filter(([k]) => PATCHABLE.includes(k)));
    if (Object.keys(patch).length) {
      try {
        await comments.update(slug, ref.n, ref.id, patch);
        notes.push(`The agent edited the finding: ${Object.keys(patch).join(', ')}.`);
      } catch (e) {
        notes.push(`The agent's edit of the finding was refused: ${errText(e)}`);
      }
    }
    const { action } = finding;
    const reason = String(finding.reason || '').trim().slice(0, 300);
    if (action === 'dismiss' && !reason) notes.push('The agent asked to dismiss the finding without a reason: not applied.');
    else if ((action === 'accept' || action === 'dismiss') && findingActor) {
      const actor = findingActor;
      // after this turn's lock: accept or dismiss releases the thread, which waits on the same lock
      setImmediate(() => actor(slug, ref.n, ref.id, { action, reason }).catch((e) => addNote(slug, key, `The agent's ${action} failed: ${errText(e)}`)));
      notes.push(`The agent ${action === 'accept' ? 'accepted' : 'dismissed'} the finding${reason ? `: ${reason}` : ''}.`);
    } else if (action) notes.push(`Unknown finding action "${action}": not applied.`);
    return notes;
  }

  // a card of a group agent asks in the thread it names, else in the one thread waiting on it; its effects must fit that thread's subject
  function cardThread(body: CardBody, { agentId, work: slug }: ActionContext) {
    const work = slug ? works.get(slug) : null;
    if (!slug || !work) return null;
    const waiting = listThreads(slug).filter((t) => t.waiting?.agentId === agentId);
    const key = body.thread ?? (waiting.length === 1 ? waiting[0].key : null);
    if (!key) return null;
    const ref = parseThreadKey(key);
    if (!ref) throw new Error(`thread: "${key}" is not a thread key`);
    const thread = read(slug, key);
    if (readGroup(slug, thread.groupId)?.agentId !== agentId) throw new Error(`thread: ${key} is not a thread of this agent`);
    (body.options || []).forEach(({ effect }, i) => {
      const at = `options[${i}].effect`;
      if (effect?.type === 'dismiss_finding' && ref.kind !== 'comment') throw new Error(`${at}: dismiss_finding is only for a finding thread`);
      if (effect?.type !== 'take_decision') return;
      const decision = ref.kind === 'decision' ? (work.decisions || []).find((d) => d.id === ref.id) : null;
      if (!decision) throw new Error(`${at}: take_decision is only for a decision thread`);
      if (decision.rows?.length) throw new Error(`${at}: the decision is a table of rows, it takes no single option`);
      if (!decision.options.some((x) => x.key === effect.option)) throw new Error(`${at}.option: the decision has no option "${effect.option}"`);
    });
    return key;
  }

  const inThread = (card: Card) => {
    if (!card.work || !card.thread) throw new Error('the card is not in a thread');
    return { slug: card.work, key: card.thread, ...check(card.work, card.thread) };
  };

  // a picked option's effect: the decision taken or the finding dismissed, noted in the thread, with no turn of the agent
  function cardEffect(card: Card, effect: CardEffect, label: string) {
    const { slug, key, ref } = inThread(card);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const reason = `Picked ${label}`.slice(0, 300);
      if (effect.type === 'take_decision') {
        if (ref.kind !== 'decision' || !works.decide) throw new Error('only a decision thread takes a decision');
        if (!works.decide(slug, { id: ref.id, choice: effect.option, rationale: reason })) throw new Error(`the decision has no option "${effect.option}"`);
        thread.messages.push(message('system', `Decision taken: ${effect.option}.`, { card: card.id }));
        write(slug, thread);
        return { ok: true, detail: `Decision taken: ${effect.option}` };
      }
      if (ref.kind !== 'comment' || !findingActor) throw new Error('only a finding thread dismisses a finding');
      thread.messages.push(message('system', `No code change: finding dismissed (${reason}).`, { card: card.id }));
      write(slug, thread);
      const actor = findingActor;
      // after this lock: dismiss releases the thread, which waits on the same lock
      setImmediate(() => actor(slug, ref.n, ref.id, { action: 'dismiss', reason }).catch((e) => addNote(slug, key, `Dismiss failed: ${errText(e)}`)));
      return { ok: true, detail: 'Finding dismissed' };
    });
  }

  // a card answer is a message of the thread, so its log records it and the reply it gets
  function cardAnswer(card: Card, text: string) {
    const { slug, key, work, ref } = inThread(card);
    return withLock(`${slug}:${key}`, () => dispatch(slug, work, ref, key, { text, role: 'user', card }));
  }
  const cardHook: ThreadHook = { resolve: cardThread, effect: cardEffect, deliver: cardAnswer };

  // replies land as the agent writes them, one per message (a steered thread waits on several); the thread stops waiting once its latest
  // message has its reply or the agent's turn ended (ended: coco followed it; otherwise idle in `paseo ls` past the settle time)
  function ingest(slug: string, key: string, agentList?: PaseoAgentRow[] | null, { ended = false }: { ended?: boolean } = {}): Promise<Thread> {
    const { ref } = check(slug, key);
    // nothing to ingest: answer without queueing behind a first message whose agent is still starting
    const idle = read(slug, key);
    if (!idle.waiting) return Promise.resolve(idle);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const { waiting } = thread;
      if (!waiting) return thread;
      const asked = [...(waiting.earlier || []), { msgId: waiting.msgId, replyPath: waiting.replyPath, cardPath: waiting.cardPath }];
      const replied = asked.filter((a) => fs.existsSync(a.replyPath));
      if (waiting.deps && !replied.length) return thread;
      let agent: PaseoAgentRow | null | undefined = null;
      let final = ended || replied.includes(asked[asked.length - 1]);
      if (!final && !replied.length && !following.has(waiting.agentId) && Date.now() - Date.parse(waiting.sentAt) > SETTLE_MS) {
        agent = (agentList || (await reviewAgent.agentsList())).find((a) => a.id === waiting.agentId);
        final = agent?.status !== 'running';
      }
      if (!final && !replied.length) return thread;
      const by = { agentId: waiting.agentId, groupId: waiting.groupId };
      const added = [];
      const notes = [];
      for (const a of replied) {
        const reply = await readReply(a.replyPath, waiting.sha);
        added.push(message('agent', reply.text, { ...by, ...(reply.blocks ? { blocks: reply.blocks } : {}) }));
        if (reply.error) notes.push(message('system', `Reply not in blocks (${reply.error}): shown as text.`));
        if (reply.dropped) notes.push(message('system', `Part of the reply was not valid blocks, left out: ${reply.dropped.join('; ')}.`.slice(0, 500)));
        if (reply.finding && ref.kind === 'comment') for (const note of await applyFinding(slug, ref, key, reply.finding)) notes.push(message('system', note));
      }
      if (final) {
        const group = readGroup(slug, waiting.groupId);
        if (group?.kind === 'code') {
          const s = await sessions.get(at(slug, group.id))?.catch(() => null);
          const cwd = s?.agentId === waiting.agentId ? s.cwd() : (agent || (await reviewAgent.agentsList()).find((x) => x.id === waiting.agentId))?.cwd;
          if (cwd && !(group.worktree && reviewAgent.sameDir(group.worktree, expandHome(cwd)))) writeGroup(slug, { ...group, worktree: expandHome(cwd) });
        }
        const suggestion = await suggestionOf(slug, ref, { ...waiting, cardPath: asked.map((a) => a.cardPath).findLast((f) => fs.existsSync(f)) || waiting.cardPath });
        const lastAdded = added[added.length - 1];
        if (suggestion && lastAdded) lastAdded.suggestion = suggestion;
        else if (suggestion) added.push(message('agent', '', { ...by, suggestion }));
        else if (!added.length) added.push(message('system', 'The agent ended its turn without writing a reply.', by));
        const cwd = readGroup(slug, waiting.groupId)?.worktree;
        if (suggestion?.kind === 'commit' && cwd && worktrees?.verify) {
          const holder = added.findLast((m) => m.suggestion === suggestion);
          suggestion.checks = { state: 'running', at: new Date().toISOString(), head: suggestion.commit };
          if (holder) setImmediate(() => verifySuggestion(slug, key, holder.id, suggestion.commit, cwd).catch((e) => addNote(slug, key, `coco could not run the checks: ${errText(e)}`.slice(0, 500))));
        }
      }
      thread.messages.push(...added, ...notes);
      thread.waiting = final ? null : { ...waiting, earlier: asked.slice(0, -1).filter((a) => !replied.includes(a)) };
      if (final) route(slug, waiting.groupId, key, null);
      return write(slug, thread);
    });
  }

  // coco's own run of the checks on a suggested commit: a failure goes back to the agent once per owner message, then the thread waits on the owner
  async function verifySuggestion(slug: string, key: string, msgId: string, commit: string, cwd: string) {
    const v = await worktrees!.verify!(cwd, { base: `${commit}^`, head: commit });
    const { work, ref } = check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const s = thread.messages.find((m) => m.id === msgId)?.suggestion;
      if (s?.kind !== 'commit' || s.commit !== commit) return;
      if (v) s.checks = v;
      else delete s.checks;
      if (v?.state !== 'failed') return write(slug, thread);
      const failed = v.results.filter((x) => x.state === 'failed').map((x) => x.label).join(', ');
      if (thread.sentBack || thread.waiting || !isOpenSuggestion(s)) {
        thread.messages.push(message('system', `coco's checks still fail on ${commit.slice(0, 7)} (${failed}): waiting for ${Owner}. Approve stays possible.`));
        return write(slug, thread);
      }
      thread.sentBack = true;
      write(slug, thread);
      const item = ref.kind === 'comment' ? ref.id : '';
      await dispatch(slug, work, ref, key, { role: 'system', text: failureText(v, 'your commit for this comment', `Fix them and commit again: one commit with the trailer \`Cc-Comment: ${item}\`.`) });
    });
  }

  // what each open thread of a work leaves to the owner (the waiting queue): the agent's last word and the suggestion not decided yet; no git here, see ready
  function queue(slug: string) {
    const work = works.get(slug);
    if (!work) return [];
    return listThreads(slug).flatMap((t) => {
      const ref = parseThreadKey(t.key);
      const item = ref && (itemOf(slug, work, ref) as (Item & { status?: string }) | null);
      const group = t.groupId ? readGroup(slug, t.groupId) : null;
      if (!ref || !item || group?.status !== 'active' || !['open', 'sent', 'pending', undefined].includes(item.status)) return [];
      const last = t.messages.findLast((m) => m.role !== 'system');
      const open = t.messages.findLast((m) => isOpenSuggestion(m.suggestion));
      const s = open?.suggestion;
      return [{
        key: t.key,
        pr: ref.kind === 'decision' ? null : String(ref.n),
        title: ref.kind === 'comment' ? item.title || `${item.path?.split('/').pop()} L${item.startLine}` : ref.kind === 'plan' ? 'Review plan' : item.title || 'Decision',
        link: threadLink(slug, t.key),
        busy: Boolean(t.waiting),
        agentLast: last?.role === 'agent',
        code: group.kind === 'code',
        at: (open ?? last)?.ts || '',
        text: t.messages.findLast((m) => m.role === 'agent' && m.text)?.text || '',
        asks: cardsOf(slug, t.key).filter((c) => c.status === 'open').length,
        suggestion: s && open ? { msg: open.id, kind: s.kind, ...(s.kind === 'commit' ? { commit: s.commit, files: s.files } : {}) } : null,
      }];
    });
  }

  // the commit a code group's agent left for this comment (its trailer) that is not on the PR branch yet, by trailer or patch-id; information only, Approve stays the owner's
  async function readyOf(slug: string, work: Work, ref: Ref, thread: Thread) {
    const group = ref.kind === 'comment' && thread.groupId ? readGroup(slug, thread.groupId) : null;
    if (ref.kind !== 'comment' || group?.kind !== 'code' || group.status !== 'active') return null;
    const pr = await prOf(work, ref.n).catch(() => null);
    if (!pr) return null;
    const fix = (await reviewAgent.trailersBetween(REPO, pr.sha, await groupTip(group))).find((t) => t.id === ref.id);
    if (!fix) return null;
    const tip = (await branchHead(pr.head)) || pr.sha;
    const [cherry, same, shown, stat] = await Promise.all([
      git(REPO, ['cherry', tip, fix.commit]),
      git(REPO, ['log', '-n1', '--format=%H', '-F', '--grep', `Cc-Comment: ${ref.id}`, tip]),
      git(REPO, ['show', '--no-patch', '--format=%s', fix.commit]),
      git(REPO, ['show', '--format=', '--shortstat', fix.commit]),
    ]);
    if (same.stdout.trim() || cherry.stdout.split('\n').some((l) => l.startsWith(`- ${fix.commit}`))) return null;
    const approve = thread.messages.findLast((m) => m.suggestion?.kind === 'commit' && m.suggestion.commit === fix.commit && isOpenSuggestion(m.suggestion));
    return { commit: fix.commit, subject: shown.stdout.trim(), stat: stat.stdout.trim(), ...(approve ? { approve: approve.id } : {}) };
  }

  // the owner's Verify: the repo checks on the ready commit (else the open suggestion's) in the group's worktree, in the background; a run is kept per sha in the thread
  // and reused until a new commit comes, except a deps-pending one, which the next click tries again
  const verifying = new Map<string, VerifyRun>();
  async function verifyThread(slug: string, key: string, want?: unknown): Promise<VerifyRun> {
    const { work, ref } = check(slug, key);
    if (!worktrees?.verify) throw new HttpError(400, 'coco runs no checks here');
    const thread = read(slug, key);
    const group = thread.groupId ? readGroup(slug, thread.groupId) : null;
    if (ref.kind !== 'comment' || group?.kind !== 'code' || !group.worktree) throw new HttpError(400, 'this thread has no agent worktree');
    const open = thread.messages.findLast((m) => m.suggestion?.kind === 'commit' && isOpenSuggestion(m.suggestion))?.suggestion;
    const ready = (await readyOf(slug, work, ref, thread))?.commit;
    const commit = want ? [ready, ...thread.messages.flatMap((m) => (m.suggestion?.kind === 'commit' && isOpenSuggestion(m.suggestion) ? [m.suggestion.commit] : []))].find((c) => c === want) : (ready ?? (open?.kind === 'commit' ? open.commit : null));
    if (!commit) throw new HttpError(400, want ? 'that commit is neither ready nor an open suggestion' : 'no commit to verify');
    if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new HttpError(400, 'not a commit sha');
    const id = `${slug}:${key}:${commit}`;
    // no await from here to verifying.set: a second click gets the run in flight, and the thread is read again after the awaits above
    const inflight = verifying.get(id);
    const cached = read(slug, key).verifies?.[commit];
    if (inflight) return cached ?? inflight;
    if (reusable(cached, false)) return cached;
    const save = (run: VerifyRun) => withLock(`${slug}:${key}`, () => {
      const t = read(slug, key);
      t.verifies = { ...t.verifies, [commit]: { ...run } };
      write(slug, t);
    });
    const first: VerifyRun = { commit, startedAt: new Date().toISOString(), status: 'running', checks: [] };
    verifying.set(id, first);
    await save(first);
    verifyCommit({ prepare: worktrees.prepare, verify: worktrees.verify, head: worktrees.head }, group.worktree, commit, save)
      .catch((e) => save({ ...first, finishedAt: new Date().toISOString(), status: 'fail', note: `coco could not run the checks: ${errText(e)}`.slice(0, 500) }))
      .finally(() => verifying.delete(id));
    return first;
  }

  // the PR worktree can take a cherry-pick when it has no tracked change and no agent is mid-turn in it
  async function prTarget(pr: ThreadPr) {
    const wt = await reviewAgent.worktreeFor(pr.head);
    if (!wt) return { wt: null, busy: false };
    const [status, agents] = await Promise.all([git(wt, ['status', '--porcelain', '--untracked-files=no']), reviewAgent.agentsList()]);
    const busy = Boolean(status.stdout.trim()) || agents.some((a) => a.status === 'running' && a.cwd && reviewAgent.sameDir(a.cwd, wt));
    return { wt, busy };
  }

  async function cherryPick(pr: ThreadPr, commit: string): Promise<{ queued: true } | { error: string } | { conflict: string } | { applied: string }> {
    const { wt, busy } = await prTarget(pr);
    if (busy) return { queued: true };
    const cwd = wt || path.join(os.tmpdir(), `cc-apply-${hex(3)}`);
    if (!wt) {
      const add = await git(REPO, ['worktree', 'add', cwd, pr.head]);
      if (!add.ok) return { error: `cannot check out ${pr.head}: ${add.stderr.slice(0, 200)}` };
    }
    try {
      const pick = await git(cwd, ['cherry-pick', commit]);
      if (!pick.ok) {
        await git(cwd, ['cherry-pick', '--abort']);
        return { conflict: pick.stderr.slice(0, 400) || 'cherry-pick failed' };
      }
      return { applied: (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim() };
    } finally {
      if (!wt) await git(REPO, ['worktree', 'remove', '--force', cwd]);
    }
  }

  // Approve on a code suggestion: cherry-pick onto the PR branch, or queue while its worktree is busy, or send the conflict back to the group agent
  async function apply(slug: string, work: Work, ref: Ref, key: string, thread: Thread, suggestion: Suggestion) {
    const s = suggestion;
    if (s.kind === 'card') {
      if (ref.kind !== 'decision') return;
      await works.upsertDecision(slug, { ...s.fields, id: ref.id });
      s.state = 'applied';
      thread.messages.push(message('system', 'Card updated.'));
      return;
    }
    if (ref.kind !== 'comment') return;
    const pr = await prOf(work, ref.n);
    const out = await cherryPick(pr, s.commit);
    if ('queued' in out) {
      s.state = 'queued';
      return;
    }
    if ('error' in out) {
      s.state = 'pending';
      s.error = out.error;
      return;
    }
    if ('conflict' in out) {
      s.state = 'conflict';
      s.error = out.conflict;
      if (thread.waiting) {
        thread.messages.push(message('system', `Commit ${s.commit.slice(0, 7)} no longer applies on ${pr.head}. Ask the agent to rebase once it has answered.`));
        return;
      }
      thread.messages.push(message('system', `Commit ${s.commit.slice(0, 7)} no longer applies on ${pr.head}; sent back to the agent.`));
      write(slug, thread);
      await dispatch(slug, work, ref, key, { role: 'system', text: `Your commit ${s.commit} does not apply on \`${pr.head}\` any more (head ${pr.sha}). Rebase your branch on that head (\`git rebase ${pr.sha}\`), resolve, and commit the change for this comment again with its trailer.` });
      Object.assign(thread, read(slug, key));
      return;
    }
    s.state = 'applied';
    s.appliedCommit = out.applied;
    delete s.error;
    await comments.update(slug, ref.n, ref.id, { status: 'fixed', resolution: { commit: out.applied, note: 'approved from the thread' } });
    thread.messages.push(message('system', `Applied on ${pr.head} as ${out.applied.slice(0, 7)}.`));
  }

  function decideSuggestion(slug: string, key: string, msgId: string, action: string) {
    const { work, ref } = check(slug, key);
    if (!['approve', 'dismiss'].includes(action)) throw new HttpError(400, "action must be 'approve' or 'dismiss'");
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const suggestion = thread.messages.find((m) => m.id === msgId && m.suggestion)?.suggestion;
      if (!suggestion) throw new HttpError(404, 'no such suggestion');
      if (!OPEN_SUGGESTION.includes(suggestion.state)) throw new HttpError(400, `suggestion is already ${suggestion.state}`);
      if (action === 'dismiss') suggestion.state = 'dismissed';
      else await apply(slug, work, ref, key, thread, suggestion);
      return write(slug, thread);
    });
  }

  // approvals waiting on a busy PR worktree: try them again
  async function drainQueue(slug: string) {
    const work = works.get(slug);
    if (!work) return;
    for (const t of listThreads(slug).filter((x) => x.messages.some((m) => m.suggestion?.state === 'queued'))) {
      const ref = parseThreadKey(t.key);
      if (!ref) continue;
      await withLock(`${slug}:${t.key}`, async () => {
        const thread = read(slug, t.key);
        for (const msg of thread.messages) if (msg.suggestion?.state === 'queued') await apply(slug, work, ref, t.key, thread, msg.suggestion);
        write(slug, thread);
      });
    }
  }

  // move a thread to another open group of the same subject kind, or mark it for a new group on its next dispatch
  function regroup(slug: string, key: string, groupId: string) {
    const { ref } = check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      if (thread.waiting) throw new HttpError(409, 'the agent is still answering');
      if (groupId === 'new') {
        if (thread.groupId) leaveGroup(slug, thread.groupId, key);
        return write(slug, { ...thread, groupId: null, newGroup: true });
      }
      const g = readGroup(slug, groupId);
      const fits = g && g.kind === { comment: 'code', plan: 'plan', decision: 'decision' }[ref.kind] && (ref.kind === 'decision' || g.n === ref.n);
      if (!fits || g.status !== 'active') throw new HttpError(400, 'that group cannot take this item');
      if (thread.groupId) leaveGroup(slug, thread.groupId, key);
      writeGroup(slug, { ...g, items: [...new Set([...g.items, key])] });
      return write(slug, { ...thread, groupId, newGroup: false });
    });
  }

  // a code group archives its Paseo workspace (agent and worktree) and drops its branch: approved commits already live on the PR branch
  async function closeGroup(slug: string, id: string) {
    const g = readGroup(slug, id);
    if (!g) throw new HttpError(404, 'no such group');
    sessions.get(at(slug, id))?.then((s) => s?.detach());
    sessions.delete(at(slug, id));
    routes.delete(at(slug, id));
    const worktree = g.worktree;
    const r = worktree ? await exec('paseo', ['workspace', 'ls', '--json']) : null;
    const ws = r?.ok && worktree ? JSON.parse(r.stdout).find((w: { cwd?: string }) => w.cwd && reviewAgent.sameDir(w.cwd, worktree)) : null;
    if (ws) await exec('paseo', ['workspace', 'archive', ws.workspaceId]);
    else if (g.agentId) await exec('paseo', ['archive', g.agentId]);
    if (g.branch) await git(REPO, ['branch', '-D', g.branch]);
    return writeGroup(slug, { ...g, status: 'closed' });
  }

  // the item is settled (finding accepted or dismissed): it leaves its group, and the group's agent and worktree go once no item is left;
  // kept while the agent is answering or a suggested commit is not applied yet, since closing deletes its branch
  function release(slug: string, key: string): Promise<{ key: string; outcome: string; reason?: string; group?: string; others?: number }> {
    check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const g = thread.groupId ? readGroup(slug, thread.groupId) : null;
      if (!g || g.status !== 'active') return { key, outcome: 'none' };
      if (thread.waiting) return { key, outcome: 'kept', reason: 'the agent is still answering' };
      if (thread.messages.some((m) => isOpenSuggestion(m.suggestion))) return { key, outcome: 'kept', reason: 'a suggestion is not applied yet' };
      const items = g.items.filter((k) => k !== key);
      if (items.length) {
        writeGroup(slug, { ...g, items });
        return { key, outcome: 'left', group: g.id, others: items.length };
      }
      await closeGroup(slug, g.id);
      return { key, outcome: 'pruned', group: g.id };
    });
  }

  // the Paseo plugin reports a finished turn: read back the threads waiting on that agent, then retry queued approvals
  async function turnEnded(agentId: string) {
    const agents = await reviewAgent.agentsList();
    for (const work of works.list().filter((w) => !w.archived)) {
      for (const t of listThreads(work.slug)) if (t.waiting?.agentId === agentId) await ingest(work.slug, t.key, agents);
      await drainQueue(work.slug);
    }
  }

  // the thread's stored activity, then live events and a `thread` ping on every change while the page watches; a reconnect replays it all
  function watch(sink: Sink, slug: string, key: string) {
    check(slug, key);
    const out = (ev: ThreadEvent) => sink.send(JSON.stringify(ev));
    for (const ev of readActivity(slug, key)) out(ev);
    const k = at(slug, key);
    const set = listeners.get(k) ?? new Set();
    set.add(out);
    listeners.set(k, set);
    sink.onClose(() => {
      listeners.get(k)?.delete(out);
      if (!listeners.get(k)?.size) listeners.delete(k);
    });
    follow(slug, key).catch(() => {});
  }

  // the post_reply tool: the agent's reply blocks, checked like post_blocks, written as the reply file the thread waits on, then read at once.
  // The thread is the named one, else the only one waiting on the agent
  async function postReply(agentId: string, input: { blocks?: unknown; finding?: unknown; thread?: unknown }) {
    const waiting = works.list().filter((w) => !w.archived).flatMap((w) => listThreads(w.slug).filter((t) => t.waiting?.agentId === agentId).map((t) => ({ slug: w.slug, thread: t })));
    const named = typeof input.thread === 'string' && input.thread ? waiting.filter((x) => x.thread.key === input.thread) : waiting;
    if (!named.length) throw new HttpError(404, input.thread ? `thread: no thread "${input.thread}" waits on this agent` : 'no thread waits on this agent');
    if (named.length > 1) throw new HttpError(400, `thread: several threads wait on this agent, name one of ${named.map((x) => x.thread.key).join(', ')}`);
    const [{ slug, thread }] = named;
    let blocks: Block[];
    try {
      blocks = validateBlocks(input.blocks);
    } catch (e) {
      throw new HttpError(400, errText(e));
    }
    const { finding } = input;
    if (finding != null && (typeof finding !== 'object' || Array.isArray(finding))) throw new HttpError(400, 'finding must be an object { action?, reason?, patch? }');
    const file = thread.waiting!.replyPath;
    writeJson(file, { blocks, ...(finding ? { finding } : {}) });
    await ingest(slug, thread.key);
    return { ok: true, thread: thread.key, blocks: blocks.length };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, b, key, sub, msgId] = parts;
      if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
      const body = async () => JSON.parse((await readBody(req)) || '{}');
      if (b === 'groups') {
        if (key && sub === 'close' && req.method === 'POST') return send(res, 200, await closeGroup(slug, key));
        return send(res, 200, listGroups(slug));
      }
      if (!key) {
        await drainQueue(slug);
        return send(res, 200, summaries(slug));
      }
      if (sub === 'verify' && req.method === 'POST') return send(res, 200, await verifyThread(slug, key, (await body()).commit));
      if (sub === 'suggestions' && req.method === 'POST') return send(res, 200, await decideSuggestion(slug, key, msgId, (await body()).action));
      if (sub === 'events' && req.method === 'GET') {
        check(slug, key);
        return watch(sseSink(req, res), slug, key);
      }
      if (req.method === 'POST') return send(res, 200, await post(slug, key, await body()));
      if (req.method === 'PUT') return send(res, 200, await regroup(slug, key, (await body()).groupId));
      const thread = await ingest(slug, key);
      follow(slug, key).catch(() => {});
      const group = thread.groupId ? readGroup(slug, thread.groupId) : null;
      const s = group?.agentId && group.status === 'active' ? await groupSession(slug, group) : null;
      const { work, ref } = check(slug, key);
      return send(res, 200, { ...thread, cards: cardsOf(slug, key), ready: await readyOf(slug, work, ref, thread).catch(() => null), persona: personaOf(slug, work, ref, group), agent: group?.agentId ? { id: group.agentId, live: Boolean(s), status: s ? (thread.waiting || s.busy() ? 'running' : 'idle') : null } : null });
    } catch (e) {
      return send(res, httpStatus(e), { error: errText(e) });
    }
  }

  return {
    handle,
    watch,
    post,
    postReply,
    ingest,
    turnEnded,
    summaries,
    decideSuggestion,
    drainQueue,
    regroup,
    release,
    setFindingActor,
    cardHook,
    cardChanged: (slug: string, key: string) => notify(slug, key, { type: 'thread' }),
    queue,
    ready: (slug: string, key: string) => {
      const { work, ref } = check(slug, key);
      return readyOf(slug, work, ref, read(slug, key));
    },
    onChange: (l: (slug: string, key: string) => void) => (changed.add(l), () => changed.delete(l)),
    steerAgent,
    codeWorktrees: () => works.list().filter((w) => !w.archived).flatMap((w) => listGroups(w.slug).flatMap((g) => (g.kind === 'code' && g.status === 'active' && g.worktree && g.agentId ? [{ cwd: g.worktree, agentId: g.agentId }] : []))),
    groupKind: (slug: string, id: string) => readGroup(slug, id)?.kind ?? null,
  };
}
