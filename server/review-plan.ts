// Review plan: a coco Paseo agent that reads one PR head through git and proposes a reading path; coco's deterministic file categories fill what it leaves out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { branchOf, fileKey, isLocal, parseKey, rowKey } from './stack.ts';
import { capitalize } from './review-agent.ts';
import { createPaseoAgents, workCwd } from './paseo-agent.ts';
import type { Entry, Started } from './paseo-agent.ts';
import { writeReviewContext } from './review-context.ts';
import type { DismissedWatch } from './review-context.ts';
import { HttpError, errorMessage, errorStatus, isSeverity } from './core-types.ts';
import type { Config, FileLayers } from './config.ts';
import type { CodeApi, PrFile, ReadBody, Refs, Req, Res, Rule, RowKey, Send, Works } from './core-types.ts';

export const CATEGORIES = ['core', 'refactor', 'wiring', 'tests', 'other'];

type Pattern = [RegExp, string];
type Diffs = Record<string, { added: string[]; removed: string[] }>;
type Cat = { category: string; reason: string; layer: string; feature: string };
type Cats = Record<string, Cat>;
type RawFile = { path?: unknown; focus?: unknown } | null | undefined;
type RawStep = { title?: unknown; why?: unknown; files?: RawFile[] };
type RawSkim = { path?: unknown; reason?: unknown } | null | undefined;
type RawWatch = { path?: unknown; startLine?: unknown; endLine?: unknown; body?: unknown; severity?: unknown; confidence?: unknown } | null | undefined;
type RawSurface = { area?: unknown; entryPoints?: unknown; risk?: unknown; note?: unknown };
export type RawPlan = { summary?: unknown; steps?: RawStep[]; skim?: RawSkim[]; watchPoints?: RawWatch[]; surface?: RawSurface[]; personas?: unknown[] };
type PlanRun = { status: string; startedAt: string; finishedAt: string | null; headSha: string; error: string; cost: number | null | undefined; progress: string[]; log: { kind: string; text: string }[]; proposal: RawPlan | null; agentId?: string };
// dismissed outlives re-plans: the next plan reads it through get_pr_findings
type PlanData = { run: Omit<PlanRun, 'proposal' | 'log'> & { log?: PlanRun['log'] } | null; plan: (ReturnType<typeof normalizePlan> & { headSha: string; mergeBase: string; createdAt: string | null }) | null; ticks: Record<string, string[]>; watch: Record<string, string | undefined>; dismissed?: DismissedWatch[] };
type AgentResult = { agentId: string; cost?: number | null; submitted?: Record<string, unknown>; error?: string | null; status?: string };
type Agents = Pick<ReturnType<typeof createPaseoAgents>, 'run'>;
type Deps = { DATA: string; REPO: string; APP?: string | null; config: Config; code: Pick<CodeApi, 'ensureRefs' | 'prFilesFromGit'>; works: Pick<Works, 'get' | 'prInfo' | 'personasForPaths' | 'remark'>; rules?: { keptFor(work: unknown, index: number): Rule[] } | null; agents?: Agents; place?: (slug: string) => Promise<{ workspaceId: string; cwd: string }> };
const MAX_STEPS = 8;
const MAX_WATCH = 8;
export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'];
const MAX_PROGRESS = 40;
const MAX_LOG = 80;
const MAX_LOG_TEXT = 2000;
const KEEP_TICK_SHAS = 3;
const MAX_DISMISSED = 40;
const TIMEOUT_MS = 30 * 60 * 1000;

const OTHER: Pattern[] = [
  [/\.mdx?$|(^|\/)docs?\//, 'docs'],
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.snap$|(^|\/)__snapshots__\/|(^|\/)dist\/|\.min\.js$/, 'generated file'],
];
const TESTS = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\/e2e\/|\.page\.ts$|test-helpers|(^|\/)__mocks__\/|(^|\/)fixtures?\//;
const WIRING: Pattern[] = [
  [/\.d\.ts$/, 'type declarations only'],
  [/(^|\/)index\.[cm]?[jt]sx?$/, 'index re-exports'],
];
const LAYERS: Pattern[] = [
  [/(^|\/)(controllers?|routes|handlers?)\/|[-.]routes?\.[cm]?[jt]s$/, 'controller'],
  [/(^|\/)use-?cases?\//, 'use-case'],
  [/(^|\/)services?\//, 'service'],
  [/(^|\/)domain\//, 'domain'],
  [/(^|\/)repositor(y|ies)\/|-repository\.[cm]?[jt]s$/, 'repository'],
  [/(^|\/)server\//, 'server'],
  [/(^|\/)client\/.*\/(hooks?|stores?)\//, 'client hook'],
  [/(^|\/)client\//, 'client'],
];
const IMPORT_LINE = /^\s*(import\b|export\s+(\*|\{|type\s+\{)|\}\s*from\s+['"]|(type\s+)?[\w$]+(\s+as\s+[\w$]+)?,\s*$)/;

export const featureOf = (p: string): string => (p.match(/^(.*?)\/(server|client)\//) || [null, path.dirname(p)])[1] ?? '';
const squash = (l: string) => l.replace(/\s+/g, '');

// Unified diff text of a whole PR → { [path]: { added: string[], removed: string[] } }
export function splitDiff(text: string): Diffs {
  const out: Diffs = {};
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n');
    const header = lines[0].match(/^a\/(.*) b\/(.*)$/);
    let p = header ? header[2] : null;
    const added: string[] = [];
    const removed: string[] = [];
    let inHunk = false;
    for (const l of lines.slice(1)) {
      if (!inHunk && l.startsWith('rename to ')) p = l.slice(10);
      else if (!inHunk && l.startsWith('+++ b/')) p = l.slice(6);
      else if (!inHunk && l === '+++ /dev/null' && header) p = header[1];
      else if (l.startsWith('@@')) inHunk = true;
      else if (inHunk && l.startsWith('+')) added.push(l.slice(1));
      else if (inHunk && l.startsWith('-')) removed.push(l.slice(1));
    }
    if (p) out[p] = { added, removed };
  }
  return out;
}

// fileLayers ({ wiring, layers, other }: [regexSource, label][]) replaces the matching default list
export function createClassifier(fileLayers: FileLayers | null | undefined = null) {
  const compile = (list: [string, string][] | undefined, fallback: Pattern[]): Pattern[] => (Array.isArray(list) ? list.map(([src, label]): Pattern => [new RegExp(src), label]) : fallback);
  const other = compile(fileLayers?.other, OTHER);
  const wiringList = compile(fileLayers?.wiring, WIRING);
  const layers = compile(fileLayers?.layers, LAYERS);
  const layerRank = Object.fromEntries(layers.map(([, name], i) => [name, i]));
  const layerOf = (p: string): string => (layers.find(([re]) => re.test(p)) || [null, 'other'])[1];

  // files from /refs, diffs from splitDiff → { [path]: { category, reason, layer, feature } }
  function classify(files: PrFile[], diffs: Diffs): Cats {
    const removedElsewhere = new Map<string, string>();
    for (const [p, d] of Object.entries(diffs)) for (const l of d.removed) if (squash(l).length > 8) removedElsewhere.set(squash(l), p);
    const out: Cats = {};
    for (const f of files) {
      const p = f.filename;
      const d = diffs[p] || { added: [], removed: [] };
      const changed = [...d.added, ...d.removed].filter((l) => l.trim());
      const size = `+${f.additions} −${f.deletions}`;
      const put = (category: string, reason: string) => (out[p] = { category, reason, layer: layerOf(p), feature: featureOf(p) });
      const misc = other.find(([re]) => re.test(p));
      if (misc) { put('other', misc[1]); continue; }
      if (TESTS.test(p)) { put('tests', `test file, ${size}`); continue; }
      const wiring = wiringList.find(([re]) => re.test(p));
      if (wiring) { put('wiring', `${wiring[1]}, ${size}`); continue; }
      if (f.status === 'renamed' && f.additions + f.deletions <= 4) { put('refactor', `renamed from ${f.previous}`); continue; }
      if (changed.length && changed.every((l) => IMPORT_LINE.test(l))) { put('wiring', 'only import/export lines'); continue; }
      const a = d.added.map(squash).filter(Boolean).sort().join('\n');
      if (d.added.length && a === d.removed.map(squash).filter(Boolean).sort().join('\n')) { put('refactor', 'formatting only'); continue; }
      const meaty = d.added.filter((l) => squash(l).length > 8);
      const moved = meaty.filter((l) => removedElsewhere.has(squash(l))).length;
      if (meaty.length >= 3 && moved / meaty.length >= 0.6) { put('refactor', `${moved} of ${meaty.length} added lines moved from removed code`); continue; }
      if (f.additions && f.deletions && f.additions + f.deletions <= 3) { put('refactor', `${size} call-site edit`); continue; }
      put('core', `${layerOf(p)} logic, ${size}`);
    }
    return out;
  }

  // Deterministic reading order: core by feature (biggest first) then layer order (entry point inward), then the other categories
  function suggestedOrder(files: PrFile[], cats: Cats): string[] {
    const churn = (f: PrFile) => f.additions + f.deletions;
    const featureChurn = new Map<string, number>();
    for (const f of files) if (cats[f.filename]?.category === 'core') featureChurn.set(cats[f.filename].feature, (featureChurn.get(cats[f.filename].feature) || 0) + churn(f));
    const key = (f: PrFile) => {
      const c = cats[f.filename] || { category: 'core', layer: 'other', feature: '' };
      return [CATEGORIES.indexOf(c.category), c.category === 'core' ? -(featureChurn.get(c.feature) || 0) : 0, c.category === 'core' ? c.feature : '', layerRank[c.layer] ?? layers.length, -churn(f), f.filename];
    };
    const cmp = (a: PrFile, b: PrFile) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    };
    return [...files].sort(cmp).map((f) => f.filename);
  }

  return { classify, suggestedOrder, layerOf };
}

export const { classify, suggestedOrder, layerOf } = createClassifier();

// Keep only changed paths, each once; anything coco left out goes to skim with its category reason
export function normalizePlan(raw: RawPlan, files: PrFile[], cats: Cats, lineCounts: Record<string, number> = {}) {
  const known = new Set(files.map((f) => f.filename));
  const seen = new Set<string>();
  const take = (p: unknown): p is string => typeof p === 'string' && known.has(p) && !seen.has(p) && Boolean(seen.add(p));
  const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
  const steps = (raw.steps || []).slice(0, MAX_STEPS).map((s) => ({
    title: str(s.title, 120),
    why: str(s.why, 600),
    files: (s.files || []).flatMap((x) => {
      const p = x?.path;
      return take(p) ? [{ path: p, focus: str(x?.focus, 400) }] : [];
    }),
  })).filter((s) => s.files.length);
  const skim = (raw.skim || []).flatMap((x) => {
    const p = x?.path;
    return take(p) ? [{ path: p, reason: str(x?.reason, 200) }] : [];
  });
  for (const f of files) if (take(f.filename)) skim.push({ path: f.filename, reason: cats[f.filename]?.reason || '' });
  const watchPoints = (raw.watchPoints || []).flatMap((w) => {
    if (!w || typeof w.path !== 'string' || !known.has(w.path) || typeof w.startLine !== 'number' || !Number.isInteger(w.startLine) || !str(w.body, 1)) return [];
    const max = lineCounts[w.path] || Infinity;
    const startLine = Math.min(Math.max(1, w.startLine), max);
    const confidence = Number.isFinite(Number(w.confidence)) ? Math.round(Math.min(100, Math.max(0, Number(w.confidence)))) : null;
    return [{ path: w.path, startLine, endLine: Math.min(Math.max(startLine, Number(w.endLine) || startLine), max), body: str(w.body, 2000), severity: isSeverity(w.severity) ? w.severity : 'minor', confidence }];
  }).slice(0, MAX_WATCH);
  const surface = (raw.surface || []).slice(0, 6).map((s) => ({ area: str(s.area, 80), entryPoints: str(s.entryPoints, 300), risk: typeof s.risk === 'string' && ['high', 'medium', 'low'].includes(s.risk) ? s.risk : 'medium', note: str(s.note, 400) }));
  return { summary: str(raw.summary, 1500), surface, personas: (raw.personas || []).map((x) => str(x, 40)).filter(Boolean).slice(0, 6), steps, skim, watchPoints };
}

const systemPrompt = (owner: string, repo: string) => `You are coco, the review copilot inside cocopilot, ${owner}'s local review tool. ${capitalize(owner)} reviews a pull request and asks you for a review plan: where to look, in which order, and what to check.
Everything is a proposal: never edit, push, post or send. The working tree of ${repo} is on another branch: read PR code only through git at the given shas (git diff <mergeBase> <head>, git show <head>:<path>, git grep -n <term> <head> -- <pathspec>, git log). Never use the working tree.
Method:
1. Call get_review_context first: ${owner}'s guidance for this run overrides your defaults, code breaking one of their rules is a watch point, the owner personas tell whose surfaces the PR touches (read_persona only for the main one). Then call get_pr_findings: what is already raised on this PR, how ${owner} settled it, and the watch points ${owner} dismissed. Read the PR body (github_pr) and, when a work slug is given, its notes and decisions (get_work).
2. List the changed files yourself: git diff --name-status <mergeBase> <head>, with --stat for sizes. Read the diff of the core files first (behaviour: entry points, use-cases, services, domain, repositories, client logic), then glance at tests, wiring (re-exports, type declarations, registries, import-only edits), docs and generated files. Evaluate the review surface: entry points touched (routes, MCP tools, RPC or server methods, UI actions), callers outside the diff (git grep at head), permission and validation checks, data writes.
3. Build the reading path: steps in the order a reviewer should read, usually entry point first then use-case, service, domain, repository, then client. Group files that answer one question. Tests that only mirror logic, registries, config entries and small call-site edits go to skim, each with a short reason.
4. Watch points: precise risks worth a review comment, anchored on head line numbers you verified with git show <head>:<path> (cat -n numbering). Eight at most, only real findings, phrased as the review comment ${owner} would leave. Each gets a severity (blocking: wrong behaviour, security or data loss; major: a real bug or gap to fix before merge; minor: worth fixing, not blocking; nit: style or naming) and a confidence from 0 to 100 that the finding is real, lower when you could not verify a caller or a runtime path.
   Never raise again what get_pr_findings lists, even reworded or on moved lines: open and sent findings are already raised; declined findings and dismissed watch points are ${owner}'s call, their resolution, note or thread says why; fixed findings are settled. Raise one again only when the code it judged changed since in a way that reopens it, and say what changed and which finding it reopens.
Write for ${owner}: product effect first, short plain English, no filler, paths quoted exactly. End with exactly one propose_review_plan call carrying the full plan; every file --name-status lists goes in exactly one step or in skim.`;

type PromptInput = { n: RowKey; slug?: string; refs: Pick<Refs, 'headSha' | 'mergeBase'>; fileCount?: number };

export function buildPrompt({ n, slug, refs: { headSha: head, mergeBase: base }, fileCount }: PromptInput) {
  return [
    `Plan the review of ${isLocal(n) ? `local branch ${branchOf(n)} (no PR yet, skip github_pr)` : `PR #${n}`}${slug ? ` (work ${slug})` : ''}.`,
    `head ${head} · merge-base ${base} (diff base; a stacked PR shows its own slice)${fileCount === undefined ? '' : ` · ${fileCount} changed files`}.`,
    '',
    `Call get_review_context with pr "${n}"${slug ? ` and work "${slug}"` : ''} first, then get_pr_findings with the same arguments. The diff is not in this prompt: read it through git.`,
    '',
    '```bash',
    `git diff --stat ${base} ${head}`,
    `git diff --name-status ${base} ${head}`,
    `git diff ${base} ${head} -- <path>`,
    `git show ${head}:<path>`,
    `git grep -n <term> ${head} -- <pathspec>`,
    '```',
  ].join('\n');
}

export function createReviewPlan({ DATA, REPO, APP, config, code, works, rules = null, agents = createPaseoAgents({ APP }), place }: Deps) {
  const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const OWNER = config.owner.name;
  const SYSTEM = systemPrompt(OWNER, REPO);
  const classifier = createClassifier(config.fileLayers);
  const git = (args: string[]) => new Promise<string>((resolve) => execFile('git', ['-C', REPO, ...args], { env: ENV, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))));
  const dir = (slug: string) => path.join(DATA, 'works', slug, 'reviews');
  const file = (slug: string, n: RowKey) => path.join(dir(slug), `pr-${fileKey(n)}-plan.json`);
  const read = (slug: string, n: RowKey): PlanData => {
    try {
      return JSON.parse(fs.readFileSync(file(slug, n), 'utf8'));
    } catch {
      return { run: null, plan: null, ticks: {}, watch: {} };
    }
  };
  const write = (slug: string, n: RowKey, data: PlanData) => {
    fs.mkdirSync(dir(slug), { recursive: true });
    const tmp = `${file(slug, n)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file(slug, n));
  };
  const mutate = <T>(slug: string, n: RowKey, fn: (data: PlanData) => T): T => {
    const data = read(slug, n);
    const out = fn(data);
    write(slug, n, data);
    return out;
  };
  const live = new Map<string, PlanRun>();

  const catCache = new Map<string, Cats>();
  async function categories(refs: Pick<Refs, 'mergeBase' | 'headSha'>, files: PrFile[]) {
    const key = `${refs.mergeBase}:${refs.headSha}`;
    const hit = catCache.get(key);
    if (hit) return hit;
    const cats = classifier.classify(files, splitDiff(await git(['diff', '-M', '--no-ext-diff', '--no-color', refs.mergeBase, refs.headSha])));
    catCache.set(key, cats);
    if (catCache.size > 20) catCache.delete(catCache.keys().next().value ?? '');
    return cats;
  }

  async function state(slug: string, n: RowKey) {
    const refs = await code.ensureRefs(n);
    const files = await code.prFilesFromGit(n, refs);
    const cats = await categories(refs, files);
    const data = read(slug, n);
    const run = live.get(`${slug}:${n}`) || data.run;
    return {
      headSha: refs.headSha,
      categories: cats,
      suggested: classifier.suggestedOrder(files, cats),
      run: run && { status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, headSha: run.headSha, error: run.error, cost: run.cost, progress: run.progress.slice(-8), log: run.log || [] },
      plan: data.plan,
      stale: Boolean(data.plan && data.plan.headSha !== refs.headSha),
      ticks: data.ticks[refs.headSha] || [],
      watch: data.plan?.headSha === refs.headSha ? data.watch : {},
    };
  }

  async function start(slug: string, n: RowKey, { guidance = '' }: { guidance?: unknown } = {}) {
    const k = `${slug}:${n}`;
    if (live.get(k)?.status === 'running') return { ok: true, running: true };
    const refs = await code.ensureRefs(n, { fresh: true });
    const files = await code.prFilesFromGit(n, refs);
    const cats = await categories(refs, files);
    const work = works.get(slug);
    const kept = rules && work ? rules.keptFor(work, (work.stack || []).findIndex((s) => rowKey(s) === n)) : [];
    writeReviewContext(DATA, slug, n, { guidance: String(guidance).slice(0, 4000).trim(), rules: kept.map((r) => r.text), personas: works.personasForPaths(files.map((f) => f.filename)), headSha: refs.headSha, at: new Date().toISOString() });
    const prompt = buildPrompt({ n, slug, refs, fileCount: files.length });
    const run: PlanRun = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, headSha: refs.headSha, error: '', cost: null, progress: [], log: [], proposal: null };
    live.set(k, run);
    const note = (text: string) => {
      run.progress.push(text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1').slice(0, 160));
      if (run.progress.length > MAX_PROGRESS) run.progress.shift();
    };
    // what the popover on "coco is planning" shows: thinking summaries, what coco says, the tools it calls
    const log = (kind: string, text: string) => {
      run.log.push({ kind, text: text.slice(0, MAX_LOG_TEXT) });
      if (run.log.length > MAX_LOG) run.log.shift();
    };
    const onEntry = (e: Entry) => {
      if (e.type === 'tool') {
        const step = e.kind === 'shell' ? e.text || e.name || '' : (e.name ?? '').replace('mcp__cocopilot__', '');
        note(step);
        log('tool', step);
      }
      if (e.type === 'text') {
        note((e.text ?? '').split('\n')[0]);
        log('say', e.text ?? '');
      }
      if (e.type === 'think') log('think', e.text ?? '');
    };
    const finish = async (result: AgentResult | null, failure?: unknown) => {
      run.finishedAt = new Date().toISOString();
      try {
        if (failure) throw failure;
        if (!result) throw new Error('the agent returned no result');
        run.cost = result.cost;
        run.agentId = result.agentId;
        const proposed = result.submitted?.propose_review_plan;
        run.proposal = proposed && typeof proposed === 'object' ? proposed : null;
        if (!run.proposal) throw new Error(result.error || `the agent ended (${result.status}) without a plan`);
        const lineCounts: Record<string, number> = {};
        for (const w of run.proposal.watchPoints || []) {
          const wp = w?.path;
          if (typeof wp !== 'string' || lineCounts[wp] !== undefined || !files.some((f) => f.filename === wp)) continue;
          lineCounts[wp] = (await git(['show', `${refs.headSha}:${wp}`])).split('\n').length;
        }
        const plan = { ...normalizePlan(run.proposal, files, cats, lineCounts), headSha: refs.headSha, mergeBase: refs.mergeBase, createdAt: run.finishedAt };
        run.status = 'done';
        mutate(slug, n, (data) => {
          data.plan = plan;
          data.watch = {};
        });
      } catch (e) {
        run.status = 'error';
        run.error = errorMessage(e);
      }
      const { proposal, log: _log, ...kept } = run;
      mutate(slug, n, (data) => {
        data.run = kept;
      });
      live.delete(k);
    };
    const onStart = ({ agentId, createdWorkspace }: Started) => {
      run.agentId = agentId;
      if (!createdWorkspace) return;
      note(`created Paseo workspace ${createdWorkspace}`);
      log('say', `No Paseo workspace was open for this PR: created ${createdWorkspace}.`);
    };
    (work && place ? place(slug) : (work ? workCwd({ repo: REPO, work, key: n, prInfo: works.prInfo }) : Promise.resolve(REPO)).then((cwd) => ({ cwd, workspaceId: null })))
      .then((where) => agents.run({ title: `Plan review ${isLocal(n) ? branchOf(n) : `#${n}`}`, prompt, systemPrompt: SYSTEM, provider: config.models.fast || config.models.default, ...where, labels: { source: 'cocopilot', kind: 'review-plan', work: slug, pr: fileKey(n) }, timeoutMs: TIMEOUT_MS, onEntry, onStart }))
      .then((r) => finish(r), (e) => finish(null, e));
    return { ok: true };
  }

  const tick = (slug: string, n: RowKey, { headSha, path: p, on }: { headSha: string; path: string; on?: boolean }) =>
    mutate(slug, n, (data) => {
      const list = new Set(data.ticks[headSha] || []);
      if (on) list.add(p);
      else list.delete(p);
      data.ticks[headSha] = [...list];
      const shas = Object.keys(data.ticks);
      for (const s of shas.slice(0, Math.max(0, shas.length - KEEP_TICK_SHAS))) delete data.ticks[s];
      return { ticks: data.ticks[headSha] };
    });
  // a note on accept/dismiss lands in the work notes (coco's context) and the timeline
  const watch = (slug: string, n: RowKey, { index, state: st, note }: { index: number; state?: unknown; note?: unknown }) => {
    const out = mutate(slug, n, (data) => {
      const w = data.plan?.watchPoints?.[index];
      if (!w) throw new HttpError(404, 'no such watch point');
      data.watch[index] = st === 'accepted' || st === 'dismissed' ? st : undefined;
      const plan = data.plan?.createdAt ?? null;
      const others = (data.dismissed || []).filter((d) => d.plan !== plan || d.index !== index);
      data.dismissed = st === 'dismissed'
        ? [...others, { plan, index, headSha: data.plan?.headSha ?? '', path: w.path, startLine: w.startLine, endLine: w.endLine, body: w.body, ...(typeof note === 'string' && note ? { note: note.slice(0, 1000) } : {}), at: new Date().toISOString() }].slice(-MAX_DISMISSED)
        : others;
      return { watch: data.watch, point: w };
    });
    if (typeof note === 'string' && out.watch[index]) {
      const where = `${out.point.path.split('/').pop()} L${out.point.startLine}${out.point.endLine !== out.point.startLine ? `-${out.point.endLine}` : ''}`;
      works.remark(slug, { n, where, verdict: `watch point ${out.watch[index]}`, text: note });
    }
    return { watch: out.watch };
  };

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , raw, , action] = parts;
      const n = parseKey(raw);
      if (!/^[\w.-]+$/.test(slug || '') || slug.startsWith('.') || !n) return send(res, 400, { error: 'bad slug or pr number' });
      if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
      const body = async () => JSON.parse((await readBody(req)) || '{}');
      if (!action && req.method === 'GET') return send(res, 200, await state(slug, n));
      if (!action && req.method === 'POST') return send(res, 200, await start(slug, n, await body()));
      if (action === 'ticks' && req.method === 'PUT') return send(res, 200, tick(slug, n, await body()));
      if (action === 'watch' && req.method === 'PUT') return send(res, 200, watch(slug, n, await body()));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, state, start, watch, planOf: (slug: string, n: RowKey) => read(slug, n).plan, planState: (slug: string, n: RowKey) => read(slug, n) };
}
