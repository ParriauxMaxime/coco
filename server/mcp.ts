#!/usr/bin/env node
// cocopilot MCP server (stdio): read tools over works, personas, Paseo, plus proposal tools.
// Any agent (Claude Code headless, a Paseo agent, Codex) can mount it. Writes stay in the app: the user applies.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { globToRegExp, surfaceGlobs } from './glob.ts';
import { loadConfig, personaLogins } from './config.ts';
import { catalog } from './dispatch.ts';
import { readReviewContext } from './review-context.ts';

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
server.tool('get_work', 'Full work JSON: notes, timeline, stack, links, artifacts list.', { slug: z.string() }, async ({ slug }) => {
  const f = path.join(WORKS, `${slug}.json`);
  if (!fs.existsSync(f)) return text({ error: 'no such work' });
  const w = JSON.parse(fs.readFileSync(f, 'utf8'));
  const art = path.join(WORKS, slug, 'artifacts');
  return text({ ...w, artifacts: fs.existsSync(art) ? fs.readdirSync(art) : [] });
});
server.tool('get_review_context', `What a review plan on a PR runs under: ${OWNER}'s guidance for its latest run (it overrides your defaults), ${OWNER}'s rules (global, then work, then PR; code breaking one is a watch point) and the owner personas of its paths with hit counts.`, { pr: z.union([z.number(), z.string()]).describe('PR number, or "b:<branch>" for a stack row with no PR yet'), work: z.string().optional().describe('work slug; omit to take the latest run on that PR in any work') }, async ({ pr, work }) => text(readReviewContext(config.dataDir, { pr, work })));
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
server.tool('propose_work_scaffold', 'Submit the proposal for a new or updated work. Nothing is created: the user reviews and applies it in cocopilot. Call it once, at the end, with the full proposal.', {
  slug: z.string().describe('kebab-case'),
  title: z.string().max(100).describe('short noun phrase naming the feature, like a product label: "CSV export of invoices", "Bulk invoice reminders"; the description carries the behaviour change'),
  description: z.string().describe('markdown: one summary paragraph, then a before/after table per surface (Surface | Before | After), then the legend line and at most two mermaid diagrams (Before/After: where the check lives and who bypasses it; merge order for a stack)'),
  summary: z.string().describe('one sentence fallback when the description is long'),
  paseoProject: z.object({ existingProjectId: z.string().optional(), createNamed: z.string().optional(), rootPath: z.string().optional() }).describe('reuse an existing Paseo project id, or propose a name to create; rootPath only when the worktree already exists in list_paseo'),
  tier: z.enum(['solo', 'stack', 'away']).describe('size of the work: solo (small, one PR), stack (several stacked PRs), away (unattended: open questions wait on a decision page)'),
  stack: z.array(z.object({ order: z.number(), title: z.string(), scope: z.string(), branch: z.string(), personas: z.array(z.string()), existingPr: z.number().optional() })).describe('planned PRs in merge order: order PRs so each merges safely on its own, user-visible switch last; personas from suggest_personas on the files the PR touches; no persona = gap to flag in notes'),
  surfaces: z.array(z.object({ surface: z.string(), entryPoint: z.string(), coverage: z.string() })).describe('surface table: every entry point the work changes and how the work covers it'),
  personas: z.array(z.string()),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
  openQuestions: z.array(z.object({ question: z.string(), recommendation: z.string(), tradeoff: z.string() })).describe('product questions only, four at most, yes/no with a recommendation and tradeoff; nothing a precedent work already pinned'),
  notes: z.string().describe('markdown for the work notes: ## Rules (one sentence each), ## Do not revisit (inherited from precedent works plus new ones), persona gaps'),
  nextSteps: z.array(z.string()),
  betaFlags: z.array(z.object({ code: z.string().describe("the flag's code, as the repo names it"), why: z.string().describe('the surface it gates, e.g. "the Export CSV button"'), prs: z.array(z.number()).optional().describe('planned PR orders it applies to; omit for every PR') })).optional().describe('feature flags a tester must switch on to reach the surfaces this work touches (grep the flag checks on the entry points); empty when nothing is gated'),
}, async (proposal) => text({ recorded: true, proposal }));

server.tool('propose_paseo_agent', `Propose starting a Paseo agent (local, in an existing workspace or cwd). Nothing starts: ${OWNER} presses Start on the card. Call it once, at the end. Pick workspaceId from list_paseo (the PR workspace of a work) and keep the prompt complete: it is the agent's whole brief.`, {
  title: z.string().max(60).describe('agent title shown in Paseo, e.g. "PR 1: export endpoint skeleton"'),
  prompt: z.string().describe('the full task for the agent'),
  workspaceId: z.string().optional().describe('existing Paseo workspace id (wks_…) from list_paseo'),
  cwd: z.string().optional().describe('working directory when no workspace id; absolute path'),
  provider: z.string().default(config.models.default),
  thinking: z.enum(['low', 'medium', 'high', 'auto']).default('high'),
  workSlug: z.string().optional().describe('work this agent belongs to, for its timeline'),
  why: z.string().describe('one sentence: what the agent will do and why'),
}, async (p) => text({ recorded: true, proposal: p }));

const dispatchable = catalog(config).map((e) => `${e.id} (${e.label}${e.kind === 'prompt' ? ', read-only unless edits' : e.edits ? ', works on the PR branch' : ', read-only'}${e.needsPrompt ? ', needs prompt' : ''}${e.needsPersona ? ', needs persona' : ''})`).join('; ');
server.tool('dispatch', `Propose dispatching a catalog agent on a work or one of its PRs. Nothing starts: ${OWNER} confirms on the card, then coco adds the work brief and picks the Paseo workspace (read-only kinds in the work's Plan workspace, the others in the PR's own). Call it once, at the end. Entries: ${dispatchable}.`, {
  entry: z.string().describe('catalog entry id, e.g. "ask", "persona-review", "fix-findings", "gate:self-review:<skill>", "prompt"'),
  pr: z.union([z.number(), z.string()]).optional().describe('PR number, or "b:<branch>" for a stack row with no PR yet; omit only for a free prompt on the whole work'),
  prompt: z.string().optional().describe('the question (ask) or the task (prompt); extra instructions for a gate run'),
  persona: z.string().optional().describe('persona login, for persona-review'),
  edits: z.boolean().optional().describe('free prompt only: true when the agent must work on the PR branch'),
  workSlug: z.string().optional().describe('the work, when the conversation has none'),
  why: z.string().describe('one sentence: what the agent will do and why'),
}, async (p) => text({ recorded: true, proposal: p }));

server.tool('propose_repo', `Propose adding a repo to coco. Nothing happens until ${OWNER} confirms on the card: then coco reuses a clone already on disk (matched by its origin remote) or clones it with gh, lists it in the config, adds a Paseo project named after it and starts a setup run proposing its config. Call it once, at the end.`, {
  source: z.string().describe('GitHub slug "owner/name", or the absolute path of a local clone'),
  why: z.string().describe('one sentence: why this repo'),
}, async (p) => text({ recorded: true, proposal: p }));

server.tool('propose_rules', `Submit candidate rules for ${OWNER}'s rules ledger, distilled from a chat excerpt or an agent thread. Nothing is kept: each lands as "proposed" and ${OWNER} keeps or drops it. Call it once, at the end.`, {
  rules: z.array(z.object({
    text: z.string().max(200).describe('one line, plain English, imperative, reusable beyond this PR: "TL;DR collapsed in PR bodies", "No low-value tests that will not survive a moving codebase"'),
    source: z.string().describe('the exact quote from the excerpt the rule comes from, short'),
  })).max(6).describe(`only corrections ${OWNER} made or rules they stated; none already in the ledger given in the prompt`),
}, async (p) => text({ recorded: true, rules: p.rules.length }));

server.tool('propose_review_plan', `Submit the review plan for the PR under review. Nothing is posted: ${OWNER} reads it in cocopilot and accepts watch points one by one. Call it once, at the end, with the full plan; every changed file goes in exactly one step or in skim.`, {
  summary: z.string().describe('2-3 sentences, product effect first: what changes for users, then how'),
  surface: z.array(z.object({ area: z.string().describe('e.g. "Public API", "Settings page"'), entryPoints: z.string().describe('routes, MCP tools, methods, UI actions touched'), risk: z.enum(['high', 'medium', 'low']), note: z.string().describe('one sentence: why this risk level, callers outside the diff') })).describe('review surface, six areas at most'),
  personas: z.array(z.string()).describe('owner persona logins whose surfaces this PR touches'),
  steps: z.array(z.object({ title: z.string().describe('short, e.g. "Use-case: invoice dedupe"'), why: z.string().describe('one or two sentences: what question this step answers and why now'), files: z.array(z.object({ path: z.string(), focus: z.string().describe('what to check in this file, with line ranges when useful') })) })).describe('reading path in order, eight steps at most'),
  skim: z.array(z.object({ path: z.string(), reason: z.string().describe('a few words: why a glance is enough') })),
  watchPoints: z.array(z.object({ path: z.string(), startLine: z.number().int().describe('head line number, verified with git show <head>:<path>'), endLine: z.number().int(), body: z.string().describe(`the review comment as ${OWNER} would write it, markdown, short`), severity: z.enum(['blocking', 'major', 'minor', 'nit']).describe('blocking: wrong behaviour, security, data loss · major: real bug or gap to fix before merge · minor: worth fixing · nit: style, naming'), confidence: z.number().int().min(0).max(100).describe('how sure you are the finding is real, 0-100') })).describe('precise risks, eight at most'),
}, async (p) => text({ recorded: true, steps: p.steps.length, skim: p.skim.length, watchPoints: p.watchPoints.length }));

await server.connect(new StdioServerTransport());
