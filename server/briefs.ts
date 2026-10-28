// Agent briefs rendered from the work record, kept under artifacts/briefs/, started in the PR's own workspace.
// A handoff is the same brief with the branch state on top, for a fresh agent in the same worktree.
import fs from 'node:fs';
import path from 'node:path';
import { decisionSummary, isLive } from './decisions.ts';
import type { Decision } from './decisions.ts';
import { branchOf, fileKey, isLocal, keyLabel, parseKey, rowKey } from './stack.ts';
import { capitalize, fenced, listText } from './review-agent.ts';
import type { Config } from './config.ts';
import { errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, ReviewAgentApi, RowKey, Send, StackRow, Work } from './core-types.ts';
import type { FeatureFlag, FeatureFlags } from './feature-flags.ts';

const MAX_LOG = 30;
const CORE_KIT = ['body', 'diagram', 'video'];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface BriefPr {
  head: string;
  base: string;
  sha?: string;
  title?: string;
}

interface BriefStackPr {
  number?: RowKey | null;
  state?: string;
  head?: string | null;
  title?: string;
}

interface BriefRule {
  text: string;
}

interface BriefComment {
  id: string;
  kind?: string;
  path: string;
  startLine: number;
  body: string;
  status?: string;
}

interface BriefState {
  at: string;
  tip: string;
  remote: string;
  baseRef: string;
  baseTip: string;
  fork: string;
  log: string[];
  dirty: string[];
  comments: BriefComment[];
  decisions: Decision[];
  worktree: string | null;
}

interface RenderInput {
  work: Work;
  index: number;
  pr: BriefPr;
  worktree: string | null;
  stackPrs?: BriefStackPr[];
  rules?: BriefRule[];
  betas?: FeatureFlag[];
  config: Config;
}

interface BriefContext extends RenderInput {
  n: number | string;
  stackPrs: BriefStackPr[];
  rules: BriefRule[];
  betas: FeatureFlag[];
}

// bullet lines of a "## heading" section of the notes
export const notesSection = (notes: string | null | undefined, heading: string) => {
  const lines = String(notes || '').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ')) break;
    if (/^\s*[-*]\s+/.test(l)) out.push(l.replace(/^\s*[-*]\s+/, '').trim());
  }
  return out;
};

// the work's taken decisions (its own and the PR's) and its "Do not revisit" notes, one bullet each
export const settledLines = (work: Work, key: RowKey | null) => [
  ...(work.decisions || []).filter((d) => d.status === 'taken' && isLive(d) && (!d.pr || String(d.pr) === String(key))).map((d) => `- ${d.title}: ${decisionSummary(d)}${d.rationale && !d.rationale.includes('\n') ? ` (${d.rationale})` : ''}${d.decidedAt ? `, ${d.decidedAt.slice(0, 10)}` : ''}.`),
  ...notesSection(work.notes, 'Do not revisit').map((l) => `- ${l}`),
];

// a finding on one line: title, where, how it stands
export const findingLine = (c: { title?: string; body?: string; path?: string; startLine?: number; status?: string }) => `- ${c.title || String(c.body || '').split('\n')[0].slice(0, 120)} (${c.path ? `${c.path}:${c.startLine}, ` : ''}${c.status})`;

const precedentCommands = (lines: string[]) => {
  const shas = [...new Set(lines.flatMap((l) => [...l.matchAll(/\b[0-9a-f]{9,40}\b/g)].map((m) => m[0])))];
  const prs = [...new Set(lines.flatMap((l) => [...l.matchAll(/#(\d{3,6})\b/g)].map((m) => m[1])))];
  return [...shas.map((s) => `git show ${s}`), ...prs.map((n) => `gh pr view ${n} --json body --jq .body`)];
};

// kit pieces a PR is expected to ship with; a kind beyond body/diagram/video is a companion PR, expected when a work link names it.
// row.kit can turn any of them off ({ video: false } = "no demo")
export const kitFlags = (work: Pick<Work, 'links'>, row: StackRow, kinds = CORE_KIT): Record<string, boolean> => ({
  ...Object.fromEntries(kinds.map((k) => [k, CORE_KIT.includes(k) || (work.links || []).some((l) => new RegExp(k.replace(/[^\w-]/g, ''), 'i').test(`${l.label} ${l.url}`))])),
  ...(row.kit || {}),
});
// the pieces the kit milestone counts
export const kitScope = (work: Pick<Work, 'links'>, row: StackRow, kinds = CORE_KIT): Record<string, boolean> => (row.kitScope ? kitFlags(work, row, kinds) : Object.fromEntries(kinds.map((k) => [k, k === 'body'])));
export const kitOf = (work: Pick<Work, 'links' | 'slug'>, row: StackRow, config: Pick<Config, 'kitKinds' | 'gateSkills' | 'baseUrl'>) => {
  const kinds = config.kitKinds || CORE_KIT;
  const kit = kitFlags(work, row, kinds);
  const skill = (gate: string) => config.gateSkills?.[gate]?.[0];
  return [
    kit.body && `PR body${skill('kit-body') ? ` drafted with the \`${skill('kit-body')}\` skill` : ''}, product effect first.`,
    kit.diagram && `Mermaid diagram in the body${skill('kit-diagram') ? `, drawn by invoking the \`${skill('kit-diagram')}\` skill (never from memory: its init line and new/same/rm classes)` : ''}.`,
    kinds.includes('video') && (kit.video ? `Demo video${skill('kit-video') ? ` (\`${skill('kit-video')}\`)` : ''} when a user sees the change.` : 'No demo video for this PR.'),
    ...kinds.filter((k) => !CORE_KIT.includes(k) && kit[k]).map((k) => `${capitalize(k)} companion PR updated for the surface this PR changes.`),
    `Hand each kit file to cocopilot so it keeps the head it was made for: \`cocopilot.import_artifact\` with \`{ path, pr: "${rowKey(row)}", kind: "${kinds.join('|')}" }\`, or without that MCP \`curl -s -X POST ${config.baseUrl}/api/works/${work.slug}/artifacts -H 'Content-Type: application/json' -d '{"path":"<file>","pr":"${rowKey(row)}","kind":"${kinds.join('|')}"}'\`.`,
  ].filter((line): line is string => Boolean(line));
};

export function renderBrief({ work, index, pr, worktree, stackPrs = [], rules = [], betas = [], config }: RenderInput) {
  const row = work.stack[index];
  const scope = row.planned?.title || pr.title || `PR ${index + 1}`;
  const out = [`# ${work.title} — PR ${index + 1}: ${scope}`, ''];
  const section = (title: string, lines: string[]) => {
    if (lines.filter(Boolean).length) out.push(`## ${title}`, '', ...lines, '');
  };

  section('Task', [`${row.planned?.scope || pr.title || scope}`, '', `You own ONE PR: \`${pr.head}\`${isLocal(rowKey(row)) ? ' (local branch, no PR yet)' : ` (#${row.number})`}. Sibling PRs belong to other agents.`]);

  const merged = stackPrs.filter((p) => p.state === 'MERGED').map((p) => `#${p.number}`);
  const siblings = [index - 1, index + 1].flatMap((i) => {
    const s = work.stack[i];
    return s ? [`PR ${i + 1} \`${s.planned?.branch || stackPrs[i]?.head || '?'}\`${s.number ? ` #${s.number}` : ''} (${s.planned?.title || stackPrs[i]?.title || 'no scope'})`] : [];
  });
  const more = work.stack.length - 1 - siblings.length;
  section('Context', [
    `- Worktree: ${worktree ? `\`${worktree}\`` : 'none yet'}; branch \`${pr.head}\`; base \`${pr.base}\` (head \`${pr.sha || '?'}\`).`,
    merged.length ? `- Already merged: ${merged.join(', ')}.` : '',
    siblings.length ? `- Siblings: ${siblings.join(', ')}${more ? `; ${more} more in the stack: \`cocopilot.get_work ${work.slug}\` (or \`curl -s ${config.baseUrl}/api/works/${work.slug}\`), its \`stack\`` : ''}.` : '',
    ...(work.links || []).map((l) => `- ${l.label}: ${l.url}`),
  ].filter(Boolean));
  if (work.description) section('What the work changes', [work.description.trim()]);

  const precedents = [...notesSection(work.notes, 'Precedents'), ...(row.precedents || [])];
  const forbidden = [...notesSection(work.notes, 'Forbidden sources'), ...(row.forbidden || [])];
  const commands = precedentCommands(precedents);
  section('Precedents to mirror', [
    ...(precedents.length ? ['Read them before any code: same design, same tests, same commit granularity.', '', ...precedents.map((p) => `- ${p}`)] : []),
    ...(commands.length ? ['', fenced(commands.join('\n'), 'bash')] : []),
    ...(forbidden.length ? ['', `Forbidden sources: ${forbidden.join('; ')}.`] : []),
  ]);

  section('Decisions (settled, do not revisit)', settledLines(work, rowKey(row)));

  const ruleLines = [...rules.map((r) => `- ${r.text}`), ...notesSection(work.notes, 'Rules').map((l) => `- ${l}`)];
  const repoRules = listText((config.repo.rules || []).map((r) => `\`${r}\``));
  section('Rules', [...(repoRules ? [`Read ${repoRules}, then follow the rules matching the files in scope.`] : []), ...(ruleLines.length ? [...(repoRules ? ['On top of them:', ''] : []), ...ruleLines] : [])]);

  section('Owner personas', (row.personas || []).map((p) => `- \`${p}\`: read \`${path.join(config.personasDir, `${p}.md`)}\`, "What they check".`));
  section('Feature flags to test', betas.map((f) => `- \`${f.code}\`${f.name ? ` (${f.name})` : ''}${f.why ? `: ${f.why}` : ''}. ${f.enable}.`));
  section('Kit expected', [...kitOf(work, row, config), ...(betas.length ? [`"How to test" opens on the feature flags to switch on: ${betas.map((f) => `\`${f.code}\``).join(', ')}, with how.`] : [])].map((k) => `- [ ] ${k}`));
  section('Constraints', [`Commit locally. Push, PR opening, undrafting and pinging belong to the orchestrator and the user. The PR body and title are yours to edit when the task calls for it (\`gh pr edit ${row.number || '<n>'} --body-file <file>\`, \`--title\`), e.g. a kit skill updating the body or attaching its video. Reply in English, concise, low token use.`]);
  section('Report back (short)', [
    '- Commits: sha + one line each.',
    `- \`git diff --shortstat ${pr.base === config.repo.defaultBranch ? `origin/${pr.base}` : pr.base}\`.`,
    '- Gate results quoted (type check, lint, format, tests: "N passing, M failing (why)").',
    '- Deviations from this brief, with why.',
    '- Open questions, each as yes/no + recommendation + tradeoff.',
  ]);
  return out.join('\n');
}

export function renderHandoff({ brief, pr, agentId, state, owner = 'the user' }: { brief: string; pr: BriefPr; agentId?: string | null; state: BriefState; owner?: string }) {
  return [
    `# Handoff — ${pr.head}`,
    '',
    `You take over from agent ${agentId ? String(agentId).slice(0, 8) : '(none)'} in the same worktree. Read the state, then the brief below, then carry on.`,
    '',
    `## State (${state.at.slice(0, 16).replace('T', ' ')})`,
    '',
    `- Branch \`${pr.head}\`, local tip \`${state.tip || '?'}\`, remote head \`${state.remote || 'not pushed'}\`${state.tip && state.remote && state.tip !== state.remote ? ' (local commits not pushed)' : ''}.`,
    `- Base \`${state.baseRef}\` at \`${state.baseTip || '?'}\`, branch forked at \`${state.fork || '?'}\`.`,
    '',
    '### What landed on the branch',
    '',
    state.log.length ? fenced(state.log.join('\n')) : '(no commit since the base)',
    '',
    '### What is open',
    '',
    ...(state.dirty.length ? ['Uncommitted:', '', fenced(state.dirty.join('\n')), ''] : ['- Working tree clean.']),
    ...(state.comments.length ? state.comments.map((c) => `- Review comment \`${c.id}\` ${c.path}:${c.startLine}: ${c.body.split('\n')[0].slice(0, 160)}`) : ['- No open review comment.']),
    ...state.decisions.map((d) => `- Pending decision "${d.title}": ${d.question || ''}`),
    '',
    '### Rebase onto the base, when asked',
    '',
    fenced([`git -C ${state.worktree} fetch origin`, `git -C ${state.worktree} rebase --onto ${state.baseRef} ${state.fork || '<fork sha>'} ${pr.head}`].join('\n'), 'bash'),
    '',
    `The push stays ${owner}'s:\`git push --force-with-lease origin ${pr.head}\`.`,
    '',
    '---',
    '',
    brief,
  ].join('\n');
}

export function createBriefs({ DATA, REPO, config, works, comments, reviewAgent, rules = null, betaFlags = null }: {
  DATA: string;
  REPO: string;
  config: Config;
  works: { get(slug: string): Work | null };
  comments: { list(slug: string, n: number | string): { comments?: BriefComment[] } };
  reviewAgent: ReviewAgentApi;
  rules?: { keptFor(work: Work, index: number): BriefRule[] } | null;
  betaFlags?: FeatureFlags | null;
}) {
  const owner = config.owner.name;
  const dir = (slug: string) => path.join(DATA, 'works', slug, 'artifacts', 'briefs');
  const exec = (cmd: string, args: string[]) => reviewAgent.exec(cmd, args);

  async function context(slug: string, raw: string): Promise<BriefContext> {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const n = parseKey(raw);
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (n === null || index < 0) throw new HttpError(404, `${raw} is not in this work`);
    const pr = await reviewAgent.rowPr(work, index);
    const [worktree, stackPrs] = await Promise.all([reviewAgent.worktreeFor(pr.head), Promise.all(work.stack.map((s): Promise<BriefStackPr> | BriefStackPr => (s.number ? reviewAgent.fetchStackState(s.number) : { number: null })))]);
    return { work, n, index, pr, worktree, stackPrs, rules: rules ? rules.keptFor(work, index) : [], betas: betaFlags ? betaFlags.forRow(work, n) : [], config };
  }

  const store = (slug: string, n: number | string, text: string, suffix = '') => {
    fs.mkdirSync(dir(slug), { recursive: true });
    const name = `pr-${fileKey(n)}-${new Date().toISOString().slice(0, 10)}${suffix}.md`;
    fs.writeFileSync(path.join(dir(slug), name), text);
    return { name: `briefs/${name}`, path: path.join(dir(slug), name) };
  };

  async function agentIn(worktree: string | null) {
    if (!worktree) return null;
    return (await reviewAgent.agentsList()).find((a) => a.cwd && a.status !== 'closed' && a.status !== 'error' && reviewAgent.sameDir(a.cwd, worktree)) || null;
  }

  async function view(slug: string, raw: string, { handoff = false } = {}) {
    const ctx = await context(slug, raw);
    const stored = fs.existsSync(dir(slug)) ? fs.readdirSync(dir(slug)).filter((f) => f.startsWith(`pr-${fileKey(ctx.n)}-`)).sort().reverse() : [];
    const agent = await agentIn(ctx.worktree);
    const brief = renderBrief(ctx);
    const text = handoff && ctx.worktree ? renderHandoff({ brief, pr: ctx.pr, agentId: agent?.id, state: await state(ctx), owner }) : brief;
    return { text, worktree: ctx.worktree, agent, stored: stored.map((f) => `briefs/${f}`) };
  }

  async function state(ctx: BriefContext): Promise<BriefState> {
    const git = (args: string[]) => exec('git', ['-C', ctx.worktree || REPO, ...args]).then((r) => (r.ok ? r.stdout.trim() : ''));
    const parent = ctx.work.stack[ctx.index - 1];
    const baseRef = !parent ? `origin/${config.repo.defaultBranch}` : parent.planned?.branch || ctx.stackPrs[ctx.index - 1]?.head || ctx.pr.base;
    const [tip, baseTip, remote] = await Promise.all([reviewAgent.branchSha(ctx.pr.head), git(['rev-parse', '--verify', '-q', baseRef]), reviewAgent.remoteHead(ctx.n)]);
    const fork = tip && baseTip ? await git(['merge-base', baseRef, tip]) : '';
    const log = fork ? (await git(['log', '--oneline', '--no-decorate', `-${MAX_LOG}`, `${fork}..${tip}`])).split('\n').filter(Boolean) : [];
    const dirty = ctx.worktree ? (await git(['--no-optional-locks', 'status', '--short'])).split('\n').filter(Boolean) : [];
    const open = (comments.list(ctx.work.slug, ctx.n).comments || []).filter((c) => !c.kind && (c.status === 'open' || c.status === 'sent'));
    const decisions = (ctx.work.decisions || []).filter((d) => d.status !== 'taken' && isLive(d) && String(d.pr) === String(ctx.n));
    return { at: new Date().toISOString(), tip: tip ?? '', baseTip, remote: remote ?? '', baseRef, fork, log, dirty, comments: open, decisions, worktree: ctx.worktree };
  }

  // the brief's agent runs in the PR worktree (its Paseo workspace) when there is one, else Paseo checks the branch out
  async function start(slug: string, raw: string, { handoff = false } = {}) {
    const ctx = await context(slug, raw);
    const brief = renderBrief(ctx);
    const agent = await agentIn(ctx.worktree);
    if (handoff && !ctx.worktree) throw new HttpError(409, `${ctx.pr.head} is not checked out: nothing to hand off`);
    const text = handoff ? renderHandoff({ brief, pr: ctx.pr, agentId: agent?.id, state: await state(ctx), owner }) : brief;
    const saved = store(slug, ctx.n, text, handoff ? '-handoff' : '');
    const runner = ctx.worktree ? { mode: 'cwd', cwd: ctx.worktree } : { mode: isLocal(ctx.n) ? 'checkout-branch' : 'checkout-pr' };
    const title = `${handoff ? 'Handoff ' : ''}PR ${ctx.index + 1}: ${ctx.work.stack[ctx.index].planned?.title || ctx.pr.title || ctx.pr.head}`;
    const agentId = await reviewAgent.launch(runner, { title, provider: config.models.default, prompt: `Read ${saved.path} and follow it end to end; it is your full task brief.`, labels: { kind: handoff ? 'handoff' : 'brief', work: slug, pr: fileKey(ctx.n) }, n: ctx.n, branch: isLocal(ctx.n) ? branchOf(ctx.n) : ctx.pr.head });
    reviewAgent.timeline(slug, 'agent', `${handoff ? `handoff ${keyLabel(ctx.n)} from ${agent ? agent.id.slice(0, 8) : 'no agent'}` : `brief ${keyLabel(ctx.n)}`}: started agent ${String(agentId || '').slice(0, 8) || '?'} with ${saved.name}`);
    return { ...saved, agentId, mode: runner.mode };
  }

  async function handle(req: Req, res: Res, parts: string[], _readBody: ReadBody, send: Send) {
    try {
      const [, slug, , raw, action] = parts;
      if (!raw) throw new HttpError(400, 'pr required');
      if (req.method === 'GET') return send(res, 200, await view(slug, decodeURIComponent(raw), { handoff: new URL(req.url ?? '', 'http://x').searchParams.get('handoff') === '1' }));
      if (req.method === 'POST' && action === 'save') {
        const ctx = await context(slug, decodeURIComponent(raw));
        return send(res, 200, store(slug, ctx.n, renderBrief(ctx)));
      }
      if (req.method === 'POST' && (action === 'start' || action === 'handoff')) return send(res, 200, await start(slug, decodeURIComponent(raw), { handoff: action === 'handoff' }));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, view, start, context };
}
