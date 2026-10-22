// Review plan: deterministic file categories, then a headless coco run that proposes a reading path for one PR head.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { branchOf, fileKey, isLocal, parseKey, rowKey } from './stack.mjs';
import { capitalize } from './review-agent.mjs';

export const CATEGORIES = ['core', 'refactor', 'wiring', 'tests', 'other'];
const MAX_PROMPT_DIFF = 160 * 1024;
const MAX_STEPS = 8;
const MAX_WATCH = 8;
export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'];
const MAX_PROGRESS = 40;
const MAX_LOG = 80;
const MAX_LOG_TEXT = 2000;
const KEEP_TICK_SHAS = 3;

const OTHER = [
  [/\.mdx?$|(^|\/)docs?\//, 'docs'],
  [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.snap$|(^|\/)__snapshots__\/|(^|\/)dist\/|\.min\.js$/, 'generated file'],
];
const TESTS = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\/e2e\/|\.page\.ts$|test-helpers|(^|\/)__mocks__\/|(^|\/)fixtures?\//;
const WIRING = [
  [/\.d\.ts$/, 'type declarations only'],
  [/(^|\/)index\.[cm]?[jt]sx?$/, 'index re-exports'],
];
const LAYERS = [
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

export const featureOf = (p) => (p.match(/^(.*?)\/(server|client)\//) || [null, path.dirname(p)])[1];
const squash = (l) => l.replace(/\s+/g, '');

// Unified diff text of a whole PR → { [path]: { added: string[], removed: string[] } }
export function splitDiff(text) {
  const out = {};
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n');
    const header = lines[0].match(/^a\/(.*) b\/(.*)$/);
    let p = header ? header[2] : null;
    const added = [];
    const removed = [];
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
export function createClassifier(fileLayers = null) {
  const compile = (list, fallback) => (Array.isArray(list) ? list.map(([src, label]) => [new RegExp(src), label]) : fallback);
  const other = compile(fileLayers?.other, OTHER);
  const wiringList = compile(fileLayers?.wiring, WIRING);
  const layers = compile(fileLayers?.layers, LAYERS);
  const layerRank = Object.fromEntries(layers.map(([, name], i) => [name, i]));
  const layerOf = (p) => (layers.find(([re]) => re.test(p)) || [null, 'other'])[1];

  // files from /refs, diffs from splitDiff → { [path]: { category, reason, layer, feature } }
  function classify(files, diffs) {
    const removedElsewhere = new Map();
    for (const [p, d] of Object.entries(diffs)) for (const l of d.removed) if (squash(l).length > 8) removedElsewhere.set(squash(l), p);
    const out = {};
    for (const f of files) {
      const p = f.filename;
      const d = diffs[p] || { added: [], removed: [] };
      const changed = [...d.added, ...d.removed].filter((l) => l.trim());
      const size = `+${f.additions} −${f.deletions}`;
      const put = (category, reason) => (out[p] = { category, reason, layer: layerOf(p), feature: featureOf(p) });
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
  function suggestedOrder(files, cats) {
    const churn = (f) => f.additions + f.deletions;
    const featureChurn = new Map();
    for (const f of files) if (cats[f.filename]?.category === 'core') featureChurn.set(cats[f.filename].feature, (featureChurn.get(cats[f.filename].feature) || 0) + churn(f));
    const key = (f) => {
      const c = cats[f.filename] || { category: 'core', layer: 'other', feature: '' };
      return [CATEGORIES.indexOf(c.category), c.category === 'core' ? -(featureChurn.get(c.feature) || 0) : 0, c.category === 'core' ? c.feature : '', layerRank[c.layer] ?? layers.length, -churn(f), f.filename];
    };
    const cmp = (a, b) => {
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
export function normalizePlan(raw, files, cats, lineCounts = {}) {
  const known = new Set(files.map((f) => f.filename));
  const seen = new Set();
  const take = (p) => known.has(p) && !seen.has(p) && seen.add(p);
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const steps = (raw.steps || []).slice(0, MAX_STEPS).map((s) => ({
    title: str(s.title, 120),
    why: str(s.why, 600),
    files: (s.files || []).filter((x) => take(x?.path)).map((x) => ({ path: x.path, focus: str(x.focus, 400) })),
  })).filter((s) => s.files.length);
  const skim = (raw.skim || []).filter((x) => take(x?.path)).map((x) => ({ path: x.path, reason: str(x.reason, 200) }));
  for (const f of files) if (take(f.filename)) skim.push({ path: f.filename, reason: cats[f.filename]?.reason || '' });
  const watchPoints = (raw.watchPoints || []).filter((w) => known.has(w?.path) && Number.isInteger(w.startLine) && str(w.body, 1)).slice(0, MAX_WATCH).map((w) => {
    const max = lineCounts[w.path] || Infinity;
    const startLine = Math.min(Math.max(1, w.startLine), max);
    const confidence = Number.isFinite(Number(w.confidence)) ? Math.round(Math.min(100, Math.max(0, Number(w.confidence)))) : null;
    return { path: w.path, startLine, endLine: Math.min(Math.max(startLine, Number(w.endLine) || startLine), max), body: str(w.body, 2000), severity: SEVERITIES.includes(w.severity) ? w.severity : 'minor', confidence };
  });
  const surface = (raw.surface || []).slice(0, 6).map((s) => ({ area: str(s.area, 80), entryPoints: str(s.entryPoints, 300), risk: ['high', 'medium', 'low'].includes(s.risk) ? s.risk : 'medium', note: str(s.note, 400) }));
  return { summary: str(raw.summary, 1500), surface, personas: (raw.personas || []).map((x) => str(x, 40)).filter(Boolean).slice(0, 6), steps, skim, watchPoints };
}

const systemPrompt = (owner, repo) => `You are coco, the review copilot inside cocopilot, ${owner}'s local review tool. ${capitalize(owner)} reviews a pull request and asks you for a review plan: where to look, in which order, and what to check.
Everything is a proposal: never edit, push, post or send. The working tree of ${repo} is on another branch: read PR code only through git at the given shas (git show <head>:<path>, git grep -n <term> <head> -- <pathspec>, git diff <mergeBase> <head> -- <path>, git log). Never use the working tree.
Method:
1. Read the PR body (github_pr) and, when a work slug is given, its notes and decisions (get_work). Owner personas come with the prompt; read_persona only for the main one.
2. Read the diff of the core files first. Evaluate the review surface: entry points touched (routes, MCP tools, RPC or server methods, UI actions), callers outside the diff (git grep at head), permission and validation checks, data writes.
3. Build the reading path: steps in the order a reviewer should read, usually entry point first then use-case, service, domain, repository, then client. Group files that answer one question. Tests that only mirror logic, registries, config entries and small call-site edits go to skim, each with a short reason.
4. Watch points: precise risks worth a review comment, anchored on head line numbers you verified with git show <head>:<path> (cat -n numbering). Eight at most, only real findings, phrased as the review comment ${owner} would leave. Each gets a severity (blocking: wrong behaviour, security or data loss; major: a real bug or gap to fix before merge; minor: worth fixing, not blocking; nit: style or naming) and a confidence from 0 to 100 that the finding is real, lower when you could not verify a caller or a runtime path.
Write for ${owner}: product effect first, short plain English, no filler, paths quoted exactly. End with exactly one propose_review_plan call carrying the full plan; every changed file goes in exactly one step or in skim.`;

const fenced = (text) => {
  const f = '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${f}diff\n${text}\n${f}`;
};

export function buildPrompt({ n, slug, refs, files, cats, diffText, personas, guidance = '', rules = [], owner = 'the user', order: orderOf = suggestedOrder }) {
  const byPath = {};
  for (const chunk of diffText.split(/^(?=diff --git )/m)) {
    const m = chunk.match(/^diff --git a\/.* b\/(.*)$/m);
    if (m) byPath[m[1]] = chunk.trimEnd();
  }
  const order = orderOf(files, cats);
  let budget = MAX_PROMPT_DIFF;
  const inline = [];
  const omitted = [];
  for (const p of order) {
    const d = byPath[p];
    if (d && d.length <= budget) {
      inline.push(d);
      budget -= d.length;
    } else omitted.push(p);
  }
  const rows = order.map((p) => {
    const f = files.find((x) => x.filename === p);
    return `| ${p} | ${f.status} | +${f.additions} −${f.deletions} | ${cats[p].category} | ${cats[p].reason} |`;
  });
  return [
    `Plan the review of ${isLocal(n) ? `local branch ${branchOf(n)} (no PR yet, skip github_pr)` : `PR #${n}`}${slug ? ` (work ${slug})` : ''}.`,
    `head ${refs.headSha} · merge-base ${refs.mergeBase} (diff base; a stacked PR shows its own slice).`,
    personas.length ? `Owner personas by surface: ${personas.map((p) => `${p.login} (${p.hits} files)`).join(', ')}.` : 'No owner persona matches these paths.',
    ...(guidance.trim() ? ['', `${capitalize(owner)}'s guidance for this plan (it overrides your defaults):`, '', guidance.trim()] : []),
    ...(rules.length ? ['', `${capitalize(owner)}'s rules (global, then work, then this PR); code breaking one is a watch point:`, '', ...rules.map((r) => `- ${r.text}`)] : []),
    '',
    `Changed files (${files.length}) with a deterministic category, a hint you may overrule:`,
    '',
    '| path | status | size | category | reason |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    omitted.length ? `Diff not inlined for: ${omitted.join(', ')}. Read them with git diff ${refs.mergeBase} ${refs.headSha} -- <path> when they matter.` : 'Full diff inlined below.',
    '',
    fenced(inline.join('\n')),
  ].join('\n');
}

export function createReviewPlan({ DATA, REPO, APP, config, code, works, rules = null }) {
  const MCP_CONFIG = path.join(APP, 'server/mcp-config.json');
  const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const OWNER = config.owner.name;
  const SYSTEM = systemPrompt(OWNER, REPO);
  const classifier = createClassifier(config.fileLayers);
  const git = (args) => new Promise((resolve) => execFile('git', ['-C', REPO, ...args], { env: ENV, maxBuffer: 64 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out))));
  const dir = (slug) => path.join(DATA, 'works', slug, 'reviews');
  const file = (slug, n) => path.join(dir(slug), `pr-${fileKey(n)}-plan.json`);
  const read = (slug, n) => {
    try {
      return JSON.parse(fs.readFileSync(file(slug, n), 'utf8'));
    } catch {
      return { run: null, plan: null, ticks: {}, watch: {} };
    }
  };
  const write = (slug, n, data) => {
    fs.mkdirSync(dir(slug), { recursive: true });
    const tmp = `${file(slug, n)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file(slug, n));
  };
  const mutate = (slug, n, fn) => {
    const data = read(slug, n);
    const out = fn(data);
    write(slug, n, data);
    return out;
  };
  const live = new Map();

  const catCache = new Map();
  async function categories(refs, files) {
    const key = `${refs.mergeBase}:${refs.headSha}`;
    if (!catCache.has(key)) {
      const diffText = await git(['diff', '-M', '--no-ext-diff', '--no-color', refs.mergeBase, refs.headSha]);
      catCache.set(key, { diffText, cats: classifier.classify(files, splitDiff(diffText)) });
      if (catCache.size > 20) catCache.delete(catCache.keys().next().value);
    }
    return catCache.get(key);
  }

  async function state(slug, n) {
    const refs = await code.ensureRefs(n);
    const files = await code.prFilesFromGit(n, refs);
    const { cats } = await categories(refs, files);
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

  async function start(slug, n, { guidance = '' } = {}) {
    const k = `${slug}:${n}`;
    if (live.get(k)?.status === 'running') return { ok: true, running: true };
    const refs = await code.ensureRefs(n, { fresh: true });
    const files = await code.prFilesFromGit(n, refs);
    const { cats, diffText } = await categories(refs, files);
    const personas = works.personasForPaths(files.map((f) => f.filename));
    const work = works.get(slug);
    const kept = rules && work ? rules.keptFor(work, (work.stack || []).findIndex((s) => rowKey(s) === n)) : [];
    const prompt = buildPrompt({ n, slug, refs, files, cats, diffText, personas, guidance: String(guidance).slice(0, 4000), rules: kept, owner: OWNER, order: classifier.suggestedOrder });
    const run = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, headSha: refs.headSha, error: '', cost: null, progress: [], log: [], proposal: null };
    live.set(k, run);
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', MCP_CONFIG, '--strict-mcp-config', '--permission-mode', 'default',
      '--allowedTools', 'mcp__cocopilot__get_work', 'mcp__cocopilot__github_pr', 'mcp__cocopilot__read_persona', 'mcp__cocopilot__propose_review_plan', 'Bash(git show *)', 'Bash(git grep *)', 'Bash(git diff *)', 'Bash(git log *)',
      '--append-system-prompt', SYSTEM, '--max-turns', '60', '--thinking-display', 'summarized', prompt];
    const child = spawn('claude', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDECODE: '' } });
    const note = (text) => {
      run.progress.push(text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1').slice(0, 160));
      if (run.progress.length > MAX_PROGRESS) run.progress.shift();
    };
    // what the popover on "coco is planning" shows: thinking summaries, what coco says, the tools it calls
    const log = (kind, text) => {
      run.log.push({ kind, text: text.slice(0, MAX_LOG_TEXT) });
      if (run.log.length > MAX_LOG) run.log.shift();
    };
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant') {
          for (const b of ev.message?.content || []) {
            if (b.type === 'tool_use' && b.name === 'mcp__cocopilot__propose_review_plan') run.proposal = b.input;
            if (b.type === 'tool_use') {
              const step = b.name === 'Bash' ? b.input?.command || 'Bash' : b.name.replace('mcp__cocopilot__', '');
              note(step);
              log('tool', step);
            }
            if (b.type === 'text' && b.text.trim()) {
              note(b.text.trim().split('\n')[0]);
              log('say', b.text.trim());
            }
            if (b.type === 'thinking' && b.thinking?.trim()) log('think', b.thinking.trim());
          }
        }
        if (ev.type === 'result') {
          run.cost = ev.total_cost_usd ?? null;
          if (ev.is_error) run.error = String(ev.result || 'claude run failed').slice(0, 500);
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('close', async (codeExit) => {
      run.finishedAt = new Date().toISOString();
      try {
        if (!run.proposal) throw new Error(run.error || err.trim().slice(0, 500) || `claude exited ${codeExit} without a plan`);
        const lineCounts = {};
        for (const w of run.proposal.watchPoints || []) {
          if (lineCounts[w?.path] !== undefined || !files.some((f) => f.filename === w?.path)) continue;
          lineCounts[w.path] = (await git(['show', `${refs.headSha}:${w.path}`])).split('\n').length;
        }
        const plan = { ...normalizePlan(run.proposal, files, cats, lineCounts), headSha: refs.headSha, mergeBase: refs.mergeBase, createdAt: run.finishedAt };
        run.status = 'done';
        mutate(slug, n, (data) => {
          data.plan = plan;
          data.watch = {};
        });
      } catch (e) {
        run.status = 'error';
        run.error = e.message;
      }
      const { proposal, log: _log, ...kept } = run;
      mutate(slug, n, (data) => {
        data.run = kept;
      });
      live.delete(k);
    });
    child.on('error', (e) => {
      run.error = e.message;
    });
    return { ok: true };
  }

  const tick = (slug, n, { headSha, path: p, on }) =>
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
  const watch = (slug, n, { index, state: st, note }) => {
    const out = mutate(slug, n, (data) => {
      const w = data.plan?.watchPoints?.[index];
      if (!w) throw Object.assign(new Error('no such watch point'), { status: 404 });
      data.watch[index] = st === 'accepted' || st === 'dismissed' ? st : undefined;
      return { watch: data.watch, point: w };
    });
    if (typeof note === 'string' && out.watch[index]) {
      const where = `${out.point.path.split('/').pop()} L${out.point.startLine}${out.point.endLine !== out.point.startLine ? `-${out.point.endLine}` : ''}`;
      works.remark(slug, { n, where, verdict: `watch point ${out.watch[index]}`, text: note });
    }
    return { watch: out.watch };
  };

  async function handle(req, res, parts, readBody, send) {
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
      return send(res, e.status || (typeof e.code === 'number' ? e.code : 500), { error: e.message });
    }
  }

  return { handle, state, start, watch, planOf: (slug, n) => read(slug, n).plan, planState: (slug, n) => read(slug, n) };
}
