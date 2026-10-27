#!/usr/bin/env node
// cocopilot MCP server (stdio): read tools over works, personas, Paseo, plus proposal tools, cards (ask, post_blocks) and work writes (findings, decisions, media, artifacts, next): docs/agent-io.md.
// Any agent (Claude Code headless, a Paseo agent, Codex) can mount it. Proposals stay in the app: the user applies.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { globToRegExp, surfaceGlobs } from './glob.ts';
import { loadConfig, personaLogins } from './config.ts';
import { catalog } from './dispatch.ts';
import { CONSULT_CAP, consultPack, pickPersona } from './consult.ts';
import { rowKey } from './stack.ts';
import { WORK_SECTIONS, readPrFindings, readReviewContext, slimWork } from './review-context.ts';
import type { PrFacts } from './review-context.ts';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const config = loadConfig({ APP });
const OWNER = config.owner.name;
const WORKS = path.join(config.dataDir, 'works');
const PERSONAS = config.personasDir;
const SKILLS = config.skillsDir;
const GITHUB = config.repo.github;
const personaFiles = () => (fs.existsSync(PERSONAS) ? fs.readdirSync(PERSONAS).filter((x) => x.endsWith('.md')) : []);
const noRepo = { error: 'no GitHub repo configured (repo.github in coco.config.json)' };
const run = (cmd: string, args: string[]) => new Promise<{ ok: boolean; out: string; err: string }>((resolve) => execFile(cmd, args, { maxBuffer: 20e6 }, (err, out, errout) => resolve({ ok: !err, out: String(out || ''), err: String(errout || err?.message || '') })));
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const listWorks = () => (fs.existsSync(WORKS) ? fs.readdirSync(WORKS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(WORKS, f), 'utf8'))) : []);

const server = new McpServer({ name: 'cocopilot', version: '0.1.0' });

server.tool('list_works', 'Works = long-term context per PR stack (slug, title, Paseo project, stack, personas, links).', {}, async () => text(listWorks().map((w) => ({ slug: w.slug, title: w.title, projectName: w.projectName, stack: (w.stack || []).map((s: { number?: number; personas?: string[] }) => ({ number: s.number, personas: s.personas })), personas: w.personas, links: w.links, updatedAt: w.updatedAt }))));
server.tool('get_work', `A work, slim by default (a full one runs to 150k characters): summary, stack rows (number, branch, title, state, notionPage), decisions in one line each, notes (clipped) and the last note entries. \`sections\` adds the rest: ${WORK_SECTIONS.join(', ')} (full = the whole record).`, { slug: z.string(), sections: z.array(z.enum(WORK_SECTIONS)).optional() }, async ({ slug, sections }) => {
  const f = path.join(WORKS, `${slug}.json`);
  if (!fs.existsSync(f)) return text({ error: 'no such work' });
  const w = JSON.parse(fs.readFileSync(f, 'utf8'));
  const art = path.join(WORKS, slug, 'artifacts');
  const facts: Record<string, PrFacts> = {};
  const live = await coco('GET', `/api/works/${encodeURIComponent(slug)}`);
  for (const p of (live.ok && Array.isArray(live.data.prs) ? live.data.prs : []) as { number?: number; head?: string; title?: string; state?: string }[]) if (p?.number) facts[p.number] = { branch: p.head, title: p.title, state: p.state };
  return text(slimWork(w, sections, facts, fs.existsSync(art) ? fs.readdirSync(art) : []));
});
server.tool('get_review_context', `What a review plan on a PR runs under: ${OWNER}'s guidance for its latest run (it overrides your defaults), ${OWNER}'s rules (global, then work, then PR; code breaking one is a watch point) and the owner personas of its paths with hit counts.`, { pr: z.union([z.number(), z.string()]).describe('PR number, or "b:<branch>" for a stack row with no PR yet'), work: z.string().optional().describe('work slug; omit to take the latest run on that PR in any work') }, async ({ pr, work }) => text(readReviewContext(config.dataDir, { pr, work })));
server.tool('get_pr_findings', `What is already raised on a PR, so a review does not raise it again: every finding (any author) with its status (open, sent, fixed, declined, outdated), resolution note and fix commit, and the end of its thread where ${OWNER} and an agent settled it; plus the review plan watch points ${OWNER} dismissed, with their note.`, { pr: z.union([z.number(), z.string()]).describe('PR number, or "b:<branch>" for a stack row with no PR yet'), work: z.string().optional().describe('work slug; omit to take the work that last reviewed that PR') }, async ({ pr, work }) => text(readPrFindings(config.dataDir, { pr, work })));
server.tool('list_personas', 'Reviewer and message-writer personas with their surfaces (path globs) and confidence.', {}, async () => {
  const out = [];
  for (const login of personaLogins(personaFiles(), config.personaFiles)) {
    const md = fs.readFileSync(path.join(PERSONAS, `${login}.md`), 'utf8');
    const m = md.match(/```yaml\nsurfaces:\n([\s\S]*?)```/);
    const surfaces = m ? [...m[1].matchAll(/- name: (.+)\n\s+confidence: (\w+)\n\s+paths:\n((?:\s+- (?!name:).+\n)+)/g)].map((x) => ({ name: x[1].trim(), confidence: x[2], paths: [...x[3].matchAll(/- (.+)/g)].map((y) => y[1].trim()) })) : [];
    out.push({ login, title: (md.match(/^# (.*)$/m) || [])[1], surfaces });
  }
  return text(out);
});
server.tool('read_persona', 'Persona markdown file.', { login: z.string() }, async ({ login }) => {
  const f = path.join(PERSONAS, `${login}.md`);
  return text(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : { error: 'no such persona' });
});
server.tool('suggest_personas', 'Match repo paths against persona surfaces; returns personas with hit counts.', { paths: z.array(z.string()) }, async ({ paths }) => {
  const out = [];
  for (const f of personaFiles()) {
    const globs = surfaceGlobs(fs.readFileSync(path.join(PERSONAS, f), 'utf8')).map(globToRegExp);
    if (!globs.length) continue;
    const hits = paths.filter((p) => globs.some((re) => re.test(p))).length;
    if (hits) out.push({ login: f.replace(/\.md$/, ''), hits });
  }
  return text(out.sort((a, b) => b.hits - a.hits));
});
server.tool('consult_persona', `A quick consult with one reviewer, for "what would <reviewer> do?" or a tradeoff: returns a pack (about ${CONSULT_CAP} characters at most) of their rules most relevant to the question and path, their past comments on similar paths and how to answer. No model runs here: you reason with the pack, answer as them in 3 to 6 lines, then offer an ask card with their pick marked. Not a persona review (that is dispatch).`, {
  login: z.string().optional().describe('persona login; omit to take the best-mapped reviewer of path, else the work\'s first persona'),
  question: z.string(),
  path: z.string().optional().describe('repo-relative file the question is about'),
  pr: z.union([z.number(), z.string()]).optional().describe("PR number the question is about; its row's personas come first when no login or path decides"),
}, async ({ login, question, path: file, pr }) => {
  const docs = Object.fromEntries(personaLogins(personaFiles(), config.personaFiles).map((l) => [l, fs.readFileSync(path.join(PERSONAS, `${l}.md`), 'utf8')]));
  let who = login && login in docs ? login : null;
  if (login && !who) return refused(`no such persona: ${login} (list_personas)`);
  if (!who) {
    const t = await target(undefined, pr);
    const work = listWorks().find((w) => w.slug === (t.slug && decodeURIComponent(t.slug)));
    const stack: { number?: number; personas?: string[] }[] = work?.stack || [];
    const row = pr != null ? stack.find((s) => String(s.number) === String(pr)) : null;
    who = pickPersona(docs, file, [...(row?.personas || []), ...(work?.personas || []), ...stack.flatMap((s) => s.personas || []), ...Object.keys(docs)]);
  }
  if (!who) return refused('no persona to consult: pass login (list_personas)');
  const read = (name: string) => { const f = path.join(PERSONAS, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; };
  let mined = null;
  try { mined = JSON.parse(read(`${who}.json`) || 'null'); } catch { /* no mined data */ }
  return text(consultPack({ login: who, question, path: file, pr, owner: OWNER, review: read(`${who}-review-style.md`) ?? docs[who], authoring: read(`${who}-authoring-style.md`), json: mined }));
});
server.tool('read_skill', `Read a skill file: a skill name returns its SKILL.md, "<skill>/<file>.md" one file of it${config.methodSkill ? `, a bare file name (SKILL.md or another file of it) a file of the ${config.methodSkill} skill, which describes how ${OWNER} runs a work` : ''}.`, { name: z.string() }, async ({ name }) => {
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || parts.length > 2 || parts.some((p) => p === '..' || p === '.')) return text({ error: 'no such file' });
  const asSkill = path.join(SKILLS, parts[0], 'SKILL.md');
  const f = parts.length === 2 ? path.join(SKILLS, ...parts) : fs.existsSync(asSkill) ? asSkill : config.methodSkill ? path.join(SKILLS, config.methodSkill, parts[0]) : '';
  return text(f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : { error: 'no such file' });
});
server.tool('list_paseo', 'Paseo projects, workspaces and agents (CLI --json).', {}, async () => {
  const [p, w, a] = await Promise.all([run('paseo', ['project', 'ls', '--json']), run('paseo', ['workspace', 'ls', '--json']), run('paseo', ['ls', '--json'])]);
  const j = (r: { out: string; err: string }) => { try { return JSON.parse(r.out); } catch { return r.err; } };
  return text({ projects: j(p), workspaces: j(w), agents: j(a) });
});
server.tool('github_pr', 'PR summary via gh (state, draft, base/head, files, reviewers, body).', { number: z.number() }, async ({ number }) => {
  if (!GITHUB) return text(noRepo);
  const r = await run('gh', ['pr', 'view', String(number), '--repo', GITHUB, '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,additions,deletions,changedFiles,reviewDecision,body,labels,author']);
  return text(r.ok ? JSON.parse(r.out) : { error: r.err });
});
server.tool('github_search', `Search ${GITHUB || 'the repo'} PRs or issues: gh search query string (e.g. "is:open label:bug permissions").`, { query: z.string(), kind: z.enum(['prs', 'issues']).default('prs') }, async ({ query, kind }) => {
  if (!GITHUB) return text(noRepo);
  const r = await run('gh', ['search', kind, '--repo', GITHUB, '--limit', '20', '--json', 'number,title,url,state,author,updatedAt', query]);
  return text(r.ok ? JSON.parse(r.out) : { error: r.err });
});
// a proposal is a card built by coco from the input; approving it runs it (docs/agent-io.md)
const ON_CARD = `Returns at once with the card id: do not wait or poll. ${OWNER}'s answer arrives later as a new user message starting "[coco card <id> answered]", with what approving did (Done: or Failed:). A refused proposal names the bad field: fix it and call again.`;
const propose = async (type: string, input: Record<string, unknown>) => {
  const r = await postCard({ action: { type, input } });
  return 'error' in r ? refused(`proposal refused: ${r.error}`) : text({ id: r.id, status: 'open', note: ON_CARD });
};

server.tool('propose_work_scaffold', `Propose a new or updated work, shown to ${OWNER} as a card. Nothing is created until ${OWNER} presses Create work (Update work for an existing slug: its card diffs the stack and ticks "replace the stack" when it differs; rows matched by PR or branch keep their Notion page, gates, kit, workspace, reviewers and personas) on the card. The stack replace is for a full re-plan only: to split a PR use propose_split, to add, move, update or remove rows of an existing work use propose_stack_edit. For a new row's Notion page set notionPage on it. Call it once, at the end, with the full proposal. ${ON_CARD}`, {
  slug: z.string().describe('kebab-case'),
  title: z.string().max(100).describe('short noun phrase naming the feature, like a product label: "CSV export of invoices", "Bulk invoice reminders"; the description carries the behaviour change'),
  description: z.string().describe('markdown: one summary paragraph, then a before/after table per surface (Surface | Before | After), then the legend line and at most two mermaid diagrams (Before/After: where the check lives and who bypasses it; merge order for a stack)'),
  summary: z.string().describe('one sentence fallback when the description is long'),
  paseoProject: z.object({ existingProjectId: z.string().optional(), createNamed: z.string().optional(), rootPath: z.string().optional() }).describe('reuse an existing Paseo project id, or propose a name to create; rootPath only when the worktree already exists in list_paseo'),
  tier: z.enum(['solo', 'stack', 'away']).describe('size of the work: solo (small, one PR), stack (several stacked PRs), away (unattended: open questions wait on a decision page)'),
  stack: z.array(z.object({ order: z.number(), title: z.string(), scope: z.string(), branch: z.string(), personas: z.array(z.string()), existingPr: z.number().optional(), notionPage: z.object({ url: z.string(), title: z.string() }).optional().describe("the row's Notion page (a notion.so url); omit to keep the page of the matching current row") })).describe('planned PRs in merge order: order PRs so each merges safely on its own, user-visible switch last; personas from suggest_personas on the files the PR touches; no persona = gap to flag in notes'),
  surfaces: z.array(z.object({ surface: z.string(), entryPoint: z.string(), coverage: z.string() })).describe('surface table: every entry point the work changes and how the work covers it'),
  personas: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  openQuestions: z.array(z.object({ question: z.string(), recommendation: z.string(), tradeoff: z.string() })).describe('product questions only, four at most, yes/no with a recommendation and tradeoff; nothing a precedent work already pinned'),
  notes: z.string().describe('markdown for the work notes: ## Rules (one sentence each), ## Do not revisit (inherited from precedent works plus new ones), persona gaps'),
  nextSteps: z.array(z.string()),
  betaFlags: z.array(z.object({ code: z.string().describe("the flag's code, as the repo names it"), why: z.string().describe('the surface it gates, e.g. "the Export CSV button"'), prs: z.array(z.number()).optional().describe('planned PR orders it applies to; omit for every PR') })).optional().describe('feature flags a tester must switch on to reach the surfaces this work touches (grep the flag checks on the entry points); empty when nothing is gated'),
}, async (proposal) => propose('work_scaffold', proposal));

const rowRef = z.union([z.number(), z.string()]).describe('PR number, or "b:<branch>" for a row with no PR yet');
server.tool('propose_split', `Propose the stack side of a PR split, shown to ${OWNER} as ONE Apply card. Call it after you created the branches and opened the PRs (parts without a PR yet become planned rows); never use propose_work_scaffold's replace for a split. The original row is replaced in place by the parts, in order, keeping every other row and its fields; the first part keeps the original's Notion page; approving sets each part's GitHub base (the first on the original's base, each next on the previous part's branch, the row after the split on the last part), can create Notion pages for the new rows and queue a PR body refresh card per PR, and returns a result per step. The git splitting stays yours. ${ON_CARD}`, {
  work: z.string().optional().describe("work slug; omit to use this agent's work"),
  pr: rowRef.describe('the row being split'),
  parts: z.array(z.object({
    title: z.string().max(200),
    branch: z.string().describe("the part's branch"),
    files: z.array(z.string()).optional().describe('files it carries, shown on the card'),
    scope: z.string().max(2000).optional(),
    existingPr: z.number().int().optional().describe("the part's PR once opened (the original PR number for the part that keeps it); omit for a planned row"),
  })).min(2).max(12).describe('in stack order'),
  why: z.string().max(500).optional().describe('one sentence'),
}, async ({ work, ...p }) => {
  const t = await target(work);
  return propose('split', { ...p, ...(t.slug ? { work: decodeURIComponent(t.slug) } : {}) });
});

server.tool('propose_stack_edit', `Propose edits to an existing work's stack, shown to ${OWNER} as a card: add a row at a position, update a row's fields, move or remove a row. Rows keep every field the edit does not name (Notion page, gates, kit, workspace): use this, not propose_work_scaffold, to change the stack of a work that exists. Approving can also start the work's Notion sync, which rewrites the linked work page and its stack table; it creates no page per row and renames no page. ${ON_CARD}`, {
  work: z.string().optional().describe("work slug; omit to use this agent's work"),
  ops: z.array(z.object({
    op: z.enum(['add', 'update', 'remove']),
    row: rowRef.optional().describe('update, remove: the row'),
    after: z.union([z.literal('start'), rowRef]).optional().describe('add: the row it goes after, "start" for the top, omit for the end; update: moves the row there'),
    pr: z.number().int().optional().describe('add: the PR; update: the PR a planned row became'),
    branch: z.string().optional().describe('add: the branch of a planned row with no PR yet'),
    title: z.string().max(200).optional().describe('planned title'),
    scope: z.string().max(2000).optional(),
    personas: z.array(z.string()).optional().describe('reviewer logins; replaces the list'),
    notionPage: z.object({ url: z.string(), title: z.string() }).nullable().optional().describe("the row's Notion page (url, title as shown in the stack table); null unlinks it"),
  })).max(40).describe('applied in order; empty with syncNotion true to only propose a Notion sync'),
  syncNotion: z.boolean().optional().describe('pre-tick "Then sync the linked Notion page" on the card'),
  why: z.string().max(500).optional().describe('one sentence'),
}, async ({ work, ...p }) => {
  const t = await target(work);
  return propose('stack_edit', { ...p, ...(t.slug ? { work: decodeURIComponent(t.slug) } : {}) });
});

server.tool('propose_pr_reply', `Draft a reply to a PR comment (a reviewer's, a bot's like Sentry, or a new comment in the PR conversation), shown to ${OWNER} as a card with the comment answered and the draft in an editable box. Nothing is posted until ${OWNER} presses Post reply; a note instead asks you to refine: call again with the new draft. When ${OWNER} asks you to answer or reply to a comment, use this tool: never refuse, never hand back a gh command. ${ON_CARD}`, {
  pr: z.union([z.number(), z.string()]).optional().describe("PR number; omit to use this agent's PR"),
  replyTo: z.union([z.number(), z.string()]).optional().describe('the review comment to answer: its id or URL (…#discussion_r<id>, a finding url); omit for a new comment in the PR conversation'),
  body: z.string().max(20000).describe('the reply, GitHub markdown, in the voice of the PR author'),
  resolve: z.boolean().optional().describe('pre-tick "Then resolve the thread" (replyTo only)'),
  github: z.string().optional().describe("owner/name; omit for the work's repo"),
  why: z.string().max(500).optional().describe('one sentence'),
}, async ({ pr, ...p }) => {
  const here = await myPlace();
  return propose('pr_reply', { ...p, ...(pr != null ? { pr } : here.pr ? { pr: here.pr } : {}) });
});

server.tool('propose_paseo_agent',`Propose starting a Paseo agent (local, in an existing workspace or cwd), shown to ${OWNER} as a card. Nothing starts until ${OWNER} presses Start agent on the card. Call it once, at the end. Pick workspaceId from list_paseo (the PR workspace of a work) and keep the prompt complete: it is the agent's whole brief. ${ON_CARD}`, {
  title: z.string().max(60).describe('agent title shown in Paseo, e.g. "PR 1: export endpoint skeleton"'),
  prompt: z.string().describe('the full task for the agent'),
  workspaceId: z.string().optional().describe('existing Paseo workspace id (wks_…) from list_paseo'),
  cwd: z.string().optional().describe('working directory when no workspace id; absolute path'),
  provider: z.string().default(config.models.default),
  thinking: z.enum(['low', 'medium', 'high', 'auto']).default('high'),
  workSlug: z.string().optional().describe('work this agent belongs to, for its timeline'),
  why: z.string().describe('one sentence: what the agent will do and why'),
}, async (p) => propose('paseo_agent', p));

const dispatchable = catalog(config).map((e) => `${e.id} (${e.label}${e.kind === 'prompt' ? ', read-only unless edits' : e.edits ? ', works on the PR branch' : ', read-only'}${e.needsPrompt ? ', needs prompt' : ''}${e.needsPersona ? ', needs persona' : ''})`).join('; ');
server.tool('dispatch', `Propose dispatching a catalog agent on a work or one of its PRs, shown to ${OWNER} as a card. Nothing starts until ${OWNER} presses Dispatch on the card; then coco adds the work brief and picks the Paseo workspace (read-only kinds in the work's Plan workspace, the others in the PR's own). Call it once, at the end. Entries: ${dispatchable}. ${ON_CARD}`, {
  entry: z.string().describe('catalog entry id, e.g. "ask", "persona-review", "fix-findings", "gate:self-review:<skill>", "prompt"'),
  pr: z.union([z.number(), z.string()]).optional().describe('PR number, or "b:<branch>" for a stack row with no PR yet; omit only for a free prompt on the whole work'),
  prompt: z.string().optional().describe('the question (ask) or the task (prompt); extra instructions for a gate run'),
  persona: z.string().optional().describe('persona login, for persona-review'),
  edits: z.boolean().optional().describe('free prompt only: true when the agent must work on the PR branch'),
  workSlug: z.string().optional().describe('the work, when the conversation has none'),
  why: z.string().describe('one sentence: what the agent will do and why'),
}, async (p) => propose('dispatch', p));

server.tool('propose_repo', `Propose adding a repo to coco, shown to ${OWNER} as a card. Nothing happens until ${OWNER} presses Add repo on the card: then coco reuses a clone already on disk (matched by its origin remote) or clones it with gh, lists it in the config, adds a Paseo project named after it and starts a setup run proposing its config. Call it once, at the end. ${ON_CARD}`, {
  source: z.string().describe('GitHub slug "owner/name", or the absolute path of a local clone'),
  why: z.string().describe('one sentence: why this repo'),
}, async (p) => propose('repo', p));

server.tool('propose_rules', `Submit candidate rules for ${OWNER}'s rules ledger, distilled from a chat excerpt or an agent thread, shown to ${OWNER} as a card with one row per rule. Nothing is kept until ${OWNER} picks Keep or Drop on each row; the kept ones join the ledger. Call it once, at the end; an empty list is fine. ${ON_CARD}`, {
  rules: z.array(z.object({
    text: z.string().max(200).describe('one line, plain English, imperative, reusable beyond this PR: "TL;DR collapsed in PR bodies", "No low-value tests that will not survive a moving codebase"'),
    source: z.string().describe('the exact quote from the excerpt the rule comes from, short'),
  })).max(6).describe(`only corrections ${OWNER} made or rules they stated; none already in the ledger given in the prompt`),
}, async (p) => propose('rules', p));

server.tool('propose_review_plan', `Submit the review plan for the PR under review. Nothing is posted: ${OWNER} reads it in cocopilot and accepts watch points one by one. Call it once, at the end, with the full plan; every changed file goes in exactly one step or in skim.`, {
  summary: z.string().describe('2-3 sentences, product effect first: what changes for users, then how'),
  surface: z.array(z.object({ area: z.string().describe('e.g. "Public API", "Settings page"'), entryPoints: z.string().describe('routes, MCP tools, methods, UI actions touched'), risk: z.enum(['high', 'medium', 'low']), note: z.string().describe('one sentence: why this risk level, callers outside the diff') })).describe('review surface, six areas at most'),
  personas: z.array(z.string()).describe('owner persona logins whose surfaces this PR touches'),
  steps: z.array(z.object({ title: z.string().describe('short, e.g. "Use-case: invoice dedupe"'), why: z.string().describe('one or two sentences: what question this step answers and why now'), files: z.array(z.object({ path: z.string(), focus: z.string().describe('what to check in this file, with line ranges when useful') })) })).describe('reading path in order, eight steps at most'),
  skim: z.array(z.object({ path: z.string(), reason: z.string().describe('a few words: why a glance is enough') })),
  watchPoints: z.array(z.object({ path: z.string(), startLine: z.number().int().describe('head line number, verified with git show <head>:<path>'), endLine: z.number().int(), body: z.string().describe(`the review comment as ${OWNER} would write it, markdown, short`), severity: z.enum(['blocking', 'major', 'minor', 'nit']).describe('blocking: wrong behaviour, security, data loss · major: real bug or gap to fix before merge · minor: worth fixing · nit: style, naming'), confidence: z.number().int().min(0).max(100).describe('how sure you are the finding is real, 0-100') })).describe('precise risks, eight at most'),
}, async (p) => text({ recorded: true, steps: p.steps.length, skim: p.skim.length, watchPoints: p.watchPoints.length }));

const AGENT_ID = process.env.PASEO_AGENT_ID || null;
const refused = (message: string) => ({ ...text(message), isError: true });
async function postCard(card: Record<string, unknown>) {
  if (!AGENT_ID) return { error: 'no PASEO_AGENT_ID in this MCP server environment: cards need a Paseo agent started by coco' };
  try {
    const r = await fetch(new URL('/api/cards', config.baseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...card, agentId: AGENT_ID }) });
    const body = await r.json().catch(() => ({}));
    return r.ok ? { id: String(body.id) } : { error: String(body.error || `coco answered ${r.status}`) };
  } catch (e) {
    return { error: `cannot reach coco at ${config.baseUrl}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
const typedBlocks = z.array(z.looseObject({ type: z.string() })).describe('typed blocks, 16 at most: text {text}, callout {tone: risk|warn|ok|note, title?, text}, steps {title?, items[], outcome?}, diagram {mermaid, caption?}, code {path?, line?, lang?, code, caption?}, table {columns[], rows: cell[][], caption?}, media {kind: image|video, src: /api/works/<slug>/media/<file>, caption?}. Inline text takes **bold**, *italic*, `code`, path/file.ts:12 refs and <risk|warn|ok|note>…</…> marks');
const cardOption = z.object({ key: z.string().describe('short id returned in the answer'), label: z.string().max(120), details: z.string().max(500).optional(), recommended: z.boolean().optional(), confidence: z.number().min(0).max(100).optional() });
const choiceOption = cardOption.extend({ effect: z.union([z.object({ type: z.literal('take_decision'), option: z.string().describe('the decision card option key') }), z.object({ type: z.literal('dismiss_finding') })]).optional().describe('thread cards only, single choice: what picking it does in coco instead of a new turn: take_decision on a decision thread, dismiss_finding (leave the code as is) on a finding thread') });
const tableCell = z.union([z.string(), z.object({ text: z.string(), tone: z.enum(['risk', 'warn', 'ok', 'note', 'mute']).optional() })]);

server.tool('ask', `Ask ${OWNER} something on a card in coco, the only way to ask the user anything. Kinds: choice (2-8 options, multi for several picks), rows (a table of 1-40 rows to tick, select one or many; or rowOptions, one pick per row), form (1-8 fields), confirm (approve or reject). Every kind but form has a free-text "Other" box unless other is false. Returns at once with the card id: do not wait or poll, end your turn or keep working; the answer arrives later as a new user message starting "[coco card <id> answered]". A refused card names the bad field: fix it and call again.`, {
  kind: z.enum(['choice', 'rows', 'form', 'confirm']),
  title: z.string().max(120).describe('short plain text: what is decided'),
  question: z.string().max(500).optional().describe('the question, inline markup'),
  blocks: typedBlocks.optional().describe('context shown above the question, same typed blocks as post_blocks'),
  options: z.array(choiceOption).optional().describe('choice: 2-8 options'),
  multi: z.boolean().optional().describe('choice: several picks allowed'),
  columns: z.array(z.string()).optional().describe('rows: 1-8 column names'),
  rows: z.array(z.object({ key: z.string(), cells: z.array(tableCell).describe('one cell per column'), recommended: z.union([z.string(), z.boolean()]).optional().describe('true to pre-tick; with rowOptions, the recommended option key') })).optional().describe('rows: 1-40 rows'),
  select: z.enum(['many', 'one']).optional().describe('rows: tick many rows (default) or exactly one'),
  rowOptions: z.array(cardOption).optional().describe('rows: 2-4 options picked per row instead of ticks'),
  fields: z.array(z.object({ key: z.string(), label: z.string().max(120), type: z.enum(['text', 'textarea', 'number', 'select', 'toggle']), options: z.array(z.string()).optional().describe('select: the choices'), default: z.union([z.string(), z.number(), z.boolean()]).optional(), required: z.boolean().optional(), placeholder: z.string().optional() })).optional().describe('form: 1-8 fields'),
  confirmLabel: z.string().max(40).optional().describe('confirm: default "Approve"'),
  rejectLabel: z.string().max(40).optional().describe('confirm: default "Reject"'),
  other: z.boolean().optional().describe('free-text "Other" box; default true except on forms'),
  thread: z.string().optional().describe('a coco thread agent: the thread key your prompt names; the card shows in that thread and its answer comes through it'),
}, async (card) => {
  const r = await postCard(card);
  return 'error' in r ? refused(`card refused: ${r.error}`) : text({ id: r.id, status: 'open', note: 'The answer arrives as a new user message starting "[coco card <id> answered]". Do not wait or poll: end your turn or keep working.' });
});

server.tool('post_blocks', `Show ${OWNER} a rich result in coco (tables, diagrams, code, callouts) as a card in your chat. Nothing is asked: use ask for that.`, {
  title: z.string().max(120),
  blocks: typedBlocks,
  thread: z.string().optional().describe('a coco thread agent: the thread key your prompt names'),
}, async ({ title, blocks, thread }) => {
  const r = await postCard({ kind: 'post', title, blocks, thread });
  return 'error' in r ? refused(`card refused: ${r.error}`) : text({ id: r.id, shown: true });
});

type Reply = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
async function coco(method: string, route: string, body?: unknown, type = 'application/json'): Promise<Reply> {
  try {
    const payload = body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body);
    const r = await fetch(new URL(route, config.baseUrl), { method, ...(payload === undefined ? {} : { headers: { 'Content-Type': type }, body: payload }) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data } : { ok: false, error: String(data.error || `coco answered ${r.status}`) };
  } catch (e) {
    return { ok: false, error: `cannot reach coco at ${config.baseUrl}: ${e instanceof Error ? e.message : String(e)}` };
  }
}
type Place = { work: string | null; pr: string | null };
let labelled: Place | null = null;
async function myPlace(): Promise<Place> {
  if (labelled || !AGENT_ID) return labelled || { work: null, pr: null };
  const r = await coco('GET', `/api/agent-chat/${encodeURIComponent(AGENT_ID)}/place`);
  if (r.ok) labelled = { work: typeof r.data.work === 'string' ? r.data.work : null, pr: typeof r.data.pr === 'string' ? r.data.pr : null };
  return labelled || { work: null, pr: null };
}
const rowParam = (pr: string | number) => (String(pr).startsWith('b:') ? `b:${String(pr).slice(2).replaceAll('/', ':')}` : String(pr).replace(/^#/, ''));
// the work and row a write goes to: given ones, else the calling agent's labels (its row only on its own work)
async function target(work?: string, pr?: string | number | null) {
  const here = await myPlace();
  const slug = work || here.work;
  return { slug: slug ? encodeURIComponent(slug) : null, pr: pr != null ? rowParam(pr) : slug === here.work ? here.pr : null };
}
const NO_WORK = 'no work: pass work (the work slug); this agent carries no work label';
const NO_PR = 'no pr: pass pr (the PR number, or "b:<branch>" for a row with no PR yet); this agent carries no PR label';
const heads = new Map<string, { headSha?: string; mergeBase?: string }>();
async function refsOf(pr: string) {
  if (heads.has(pr)) return heads.get(pr) ?? {};
  const r = await coco('GET', `/api/code/pr/${pr}/refs?fresh=1`);
  if (!r.ok) return {};
  const refs = { headSha: String(r.data.headSha || '') || undefined, mergeBase: String(r.data.mergeBase || '') || undefined };
  heads.set(pr, refs);
  return refs;
}

const workArg = z.string().optional().describe("work slug; omit to use this agent's work");
const rowArg = z.union([z.number(), z.string()]).describe('PR number, or "b:<branch>" for a stack row with no PR yet');
const richBlocks = z.array(z.looseObject({ type: z.string() })).describe('the evidence as typed blocks, 16 at most, usually 2-4: text {text}, callout {tone, title?, text}, steps {title?, items[], outcome?}, table {columns[], rows: cell[][], caption?}, suggestion {path, startLine, endLine, lang?, after} (before is read at the sha), code {path?, line?, lang?, code, caption?}, diagram {mermaid, caption?}, media {kind: image|video, src (from attach_media), caption?}. Inline text takes **bold**, *italic*, `code`, path/file.ts:12 refs, #101 and <risk|warn|ok|note|mute>…</…> marks');
const sourcesArg = z.array(z.object({ label: z.string().max(120), path: z.string().optional(), url: z.string().optional().describe('https link') })).max(8).describe('where the evidence comes from: a review page path or an https url');

server.tool('upsert_finding', `Post one code-review finding to ${OWNER}'s Findings board in coco (coco-findings skill: one finding per defect, at the line that holds it). Work, PR and head sha default to this agent's. The same author, path and title on that PR, or an id, updates the existing finding instead of adding one. A refused finding names the bad field: fix it and call again.`, {
  work: workArg,
  pr: rowArg.optional().describe('PR whose diff holds the file (in a stack, the highest one touching it); omit for this agent\'s PR'),
  id: z.string().optional().describe('an existing finding id to update'),
  path: z.string().describe('repo-relative file'),
  startLine: z.number().int().min(1).describe('line at the sha'),
  endLine: z.number().int().min(1),
  side: z.enum(['head', 'base']).optional().describe('default head'),
  sha: z.string().optional().describe("commit the lines refer to; default the PR's head (merge base for side base)"),
  author: z.string().regex(/^[\w.-]{1,40}$/).describe('reviewer id: as-<login> for a persona review, else the agent name (opus-review, review-local)'),
  title: z.string().max(100).describe('row label, ~70 chars: subject + what breaks; not the category, not the fix'),
  severity: z.enum(['blocking', 'major', 'minor', 'nit']).describe('blocking: security, data loss, broken prod path · major: wrong behaviour a user hits · minor: edge case, test gap · nit: naming, copy, docs'),
  confidence: z.number().int().min(0).max(100).describe('how sure the defect is real: 90+ reproduced or traced, 70-89 full path read, 50-69 one link unchecked'),
  summary: z.string().max(400).optional().describe('the one-sentence claim the title shortens: what breaks, for whom, through which call'),
  category: z.string().max(80).optional().describe('e.g. "In-stack bug", "Existing bug on main (security)", "Test gap", "Product call"'),
  recommendation: z.string().max(600).optional().describe('the fix in one sentence'),
  blocks: richBlocks.optional(),
  sources: sourcesArg.optional(),
}, async ({ work: slugIn, pr: prIn, id, path: file, startLine, endLine, side = 'head', sha, ...fields }) => {
  const t = await target(slugIn, prIn);
  if (!t.slug) return refused(NO_WORK);
  if (!t.pr) return refused(NO_PR);
  const base = `/api/works/${t.slug}/prs/${t.pr}/comments`;
  const board = `${config.baseUrl}/#/work/${t.slug}/findings-${t.pr}`;
  let existing = id;
  if (!existing) {
    const list = await coco('GET', base);
    if (!list.ok) return refused(`finding refused: ${list.error}`);
    const comments = Array.isArray(list.data.comments) ? (list.data.comments as { id: string; author?: string; path?: string; title?: string }[]) : [];
    existing = comments.find((c) => c.author === fields.author && c.path === file && c.title?.trim() === fields.title.trim())?.id;
  }
  if (existing) {
    const { author: _author, ...patch } = fields;
    const r = await coco('PUT', `${base}/${encodeURIComponent(existing)}`, patch);
    return r.ok ? text({ id: existing, updated: true, board }) : refused(`finding refused: ${r.error}`);
  }
  const refs = sha ? {} : await refsOf(t.pr);
  const at = sha || (side === 'base' ? refs.mergeBase : refs.headSha);
  if (!at) return refused(`no sha: cannot read the refs of ${t.pr}; pass sha`);
  const r = await coco('POST', base, { path: file, side, sha: at, startLine, endLine, ...fields });
  return r.ok ? text({ id: r.data.id, created: true, sha: r.data.sha, board }) : refused(`finding refused: ${r.error}`);
});

server.tool('flag_coco_issue', `Flag a change ${OWNER} asks of cocopilot itself ("coco should read local head, not origin") as a finding on the cocopilot work, then answer with the returned url. Use it instead of saying another session owns it; change no coco code from another work. The same title updates the existing finding. A refused finding names the bad field.`, {
  title: z.string().max(100).describe('row label, ~70 chars: what coco should do differently'),
  severity: z.enum(['blocking', 'major', 'minor', 'nit']).describe('blocking: coco unusable · major: wrong behaviour hit often · minor: friction · nit: polish'),
  summary: z.string().max(400).describe('the change asked, one or two sentences: current behaviour, wanted behaviour'),
  quote: z.string().max(600).describe(`${OWNER}'s own words, verbatim`),
}, async ({ quote, ...fields }) => {
  const w = listWorks().find((x) => (config.cocoWork ? x.slug === config.cocoWork : x.repo === 'cocopilot'));
  const row = rowKey(w?.stack?.[0]);
  if (!w || !row) return refused(`no cocopilot work with a first row: ${config.cocoWork ? `cocoWork "${config.cocoWork}" not found` : 'set cocoWork in coco.config.json'}`);
  const here = await myPlace();
  const rich = {
    ...fields,
    blocks: [{ type: 'callout', tone: 'note', title: `${OWNER} said`, text: quote }],
    sources: [{ label: `Reported by agent ${AGENT_ID?.slice(0, 8) ?? '?'}${here.work ? ` in ${here.work}${here.pr ? ` ${here.pr}` : ''}` : ''}`, ...(here.work && AGENT_ID ? { url: `#/work/${here.work}/ag-${AGENT_ID}` } : {}) }],
  };
  const base = `/api/works/${encodeURIComponent(w.slug)}/prs/${rowParam(row)}/comments`;
  const link = (id: string) => `${config.baseUrl}/#/work/${w.slug}/findings-${row}/f-${id}`;
  const list = await coco('GET', base);
  if (!list.ok) return refused(`issue refused: ${list.error}`);
  const stored = Array.isArray(list.data.comments) ? (list.data.comments as { id: string; kind?: string; title?: string }[]) : [];
  const existing = stored.find((c) => c.kind === 'issue' && c.title?.trim() === fields.title.trim())?.id;
  if (existing) {
    const r = await coco('PUT', `${base}/${encodeURIComponent(existing)}`, rich);
    return r.ok ? text({ id: existing, updated: true, url: link(existing) }) : refused(`issue refused: ${r.error}`);
  }
  const r = await coco('POST', base, { kind: 'issue', author: 'coco-issue', from: { agent: AGENT_ID, work: here.work, pr: here.pr }, ...rich });
  return r.ok ? text({ id: r.data.id, created: true, url: link(String(r.data.id)) }) : refused(`issue refused: ${r.error}`);
});

server.tool('upsert_decision', `Write a decision card on a work: an open product or tech choice with options that ${OWNER} takes on the Decisions tab, instead of asking in chat. Merged into the card with that id, or added as a new pending card; a choice ${OWNER} already took stays. Evidence goes in summary, blocks and sources like a finding. A refused card names the bad field.`, {
  work: workArg,
  id: z.string().regex(/^[\w.:~-]{1,60}$/).describe('short id, e.g. "d3-export-denied"; the same id updates the card'),
  title: z.string().max(120).optional().describe('required on a new card: "D1 · Export CSV · Scope", short plain text'),
  question: z.string().max(500).optional().describe('the question, plain text'),
  summary: z.string().max(400).optional().describe('one-sentence lede'),
  blocks: richBlocks.optional(),
  sources: sourcesArg.optional(),
  options: z.array(z.object({ key: z.string(), label: z.string().max(120), details: z.string().optional().describe('one or two plain sentences: what it means, its tradeoff'), confidence: z.number().int().min(0).max(100).optional() })).optional().describe('required on a new card: 2 or more options'),
  rows: z.array(z.object({ key: z.string(), label: z.string().max(120), details: z.string().optional(), recommended: z.string().optional().describe('option key') })).optional().describe('a table of sub-decisions, one pick per row, options as columns'),
  recommended: z.string().optional().describe('recommended option key'),
  confidence: z.number().int().min(0).max(100).optional().describe('how sure you are of the recommendation'),
  positions: z.record(z.string(), z.string()).optional().describe('reviewer → markdown position'),
  source: z.string().optional().describe('who raised it'),
  pr: rowArg.optional().describe('stack row the card belongs to; omit for a card on the whole work'),
  sha: z.string().optional().describe('commit a suggestion block is read at'),
}, async ({ work: slugIn, id, pr: prIn, ...card }) => {
  const t = await target(slugIn, prIn);
  if (!t.slug) return refused(NO_WORK);
  const r = await coco('PUT', `/api/works/${t.slug}/decisions/${encodeURIComponent(id)}`, { ...card, ...(prIn !== undefined && t.pr ? { pr: t.pr } : {}) });
  if (!r.ok) return refused(`decision refused: ${r.error}`);
  const saved = (Array.isArray(r.data.decisions) ? (r.data.decisions as { id: string; status?: string; title?: string }[]) : []).find((d) => d.id === id);
  return text({ id, status: saved?.status ?? 'pending', title: saved?.title });
});

const MEDIA_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
server.tool('attach_media', 'Upload a screenshot or short clip from disk to the work, for a media block in a finding, a decision or post_blocks. Returns the src and a ready media block.', {
  work: workArg,
  path: z.string().describe('absolute path of a png, jpg, webp, gif, mp4 or webm file, 50 MB at most'),
  caption: z.string().max(200).optional(),
}, async ({ work: slugIn, path: file, caption }) => {
  const t = await target(slugIn);
  if (!t.slug) return refused(NO_WORK);
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!type) return refused(`path must end in ${Object.keys(MEDIA_TYPES).join(', ')}`);
  if (!path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return refused(`path: no file at ${file} (absolute path expected)`);
  const r = await coco('POST', `/api/works/${t.slug}/media`, new Blob([new Uint8Array(fs.readFileSync(file))]), type);
  if (!r.ok) return refused(`media refused: ${r.error}`);
  return text({ src: r.data.src, block: { type: 'media', kind: type.startsWith('video/') ? 'video' : 'image', src: r.data.src, ...(caption ? { caption } : {}) } });
});

server.tool('import_artifact', `Copy a file or folder (PR body draft, diagram, demo clip, review page) into the work's artifacts; with a PR and a kit kind (${config.kitKinds.join(', ')}) it records the head it was made for, so the kit line turns fresh. The path must sit under an allowed import root (a worktree or /tmp by default).`, {
  work: workArg,
  path: z.string().describe('absolute path'),
  label: z.string().optional().describe('artifact name; default the file name'),
  pr: rowArg.optional().describe("default this agent's row"),
  kind: z.string().optional().describe(`kit piece: ${config.kitKinds.join(', ')}`),
}, async ({ work: slugIn, pr: prIn, ...body }) => {
  const t = await target(slugIn, prIn);
  if (!t.slug) return refused(NO_WORK);
  const r = await coco('POST', `/api/works/${t.slug}/artifacts`, { ...body, ...(t.pr ? { pr: t.pr } : {}) });
  return r.ok ? text(r.data) : refused(`artifact refused: ${r.error}`);
});

server.tool('get_drift', `What moved on the work's PRs since they were last pushed or written: unpushed local commits, a stale PR body, diagram or video, a GitHub stack that differs from the work's, plus the next steps ${OWNER} can click. Read only: ${OWNER} starts any fix.`, { work: workArg }, async ({ work: slugIn }) => {
  const t = await target(slugIn);
  if (!t.slug) return refused(NO_WORK);
  const r = await coco('GET', `/api/works/${t.slug}/drift`);
  return r.ok ? text(r.data) : refused(`drift refused: ${r.error}`);
});

server.tool('set_next', `Write the work's "What's next": ${OWNER}'s to-do as of now (review, merge, answer, push), shown first on the Plan tab. Not what agents are doing. clear: true removes it.`, {
  work: workArg,
  summary: z.string().max(400).optional().describe('one plain sentence'),
  blocks: richBlocks.optional().describe('a steps block for the actions in order, a callout for a blocker, a table for PRs to review'),
  by: z.string().max(80).optional().describe('who wrote it'),
  clear: z.boolean().optional(),
}, async ({ work: slugIn, clear, ...next }) => {
  const t = await target(slugIn);
  if (!t.slug) return refused(NO_WORK);
  const r = await coco('PUT', `/api/works/${t.slug}`, { next: clear ? null : next });
  return r.ok ? text({ next: r.data.next ?? null }) : refused(`next refused: ${r.error}`);
});

server.tool('own_deps', 'Give your worktree its own copy of the dependency folders (node_modules) that link to the main checkout, before any install, upgrade or removal of a package: an install into a linked folder would change the main checkout and a hook refuses it. Returns at once; coco clones and installs them, then a message tells you they are ready. Install nothing until then.', {
  paths: z.array(z.string()).optional().describe('folders as your brief lists them (e.g. "node_modules"); omit for all'),
}, async ({ paths }) => {
  const r = await coco('POST', '/api/agent-worktree/own-deps', { cwd: process.env.PASEO_AGENT_CWD || process.cwd(), agentId: AGENT_ID, paths });
  return r.ok ? text(r.data) : refused(`own_deps refused: ${r.error}`);
});

await server.connect(new StdioServerTransport());
