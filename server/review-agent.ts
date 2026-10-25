// Review handoff: turn open review comments into a brief, hand it to a Paseo agent, ingest the result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { branchOf, fileKey, isLocal, keyLabel, parseKey, rowKey } from './stack.ts';
import { UUID, createPaseoAgents, expandHome, launcherEnv, sameDir, worktreeFor as worktreeOf } from './paseo-agent.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import type { Config } from './config.ts';
import type { Comment, CommentsApi, Exec, LaunchInput, PaseoAgentInfo, ReadBody, Req, Res, ReviewPr, RowKey, Runner, Send, Work, Works } from './core-types.ts';

const MAX_COMMENTS = 30;
const SETTLE_MS = 15000;
const AGENT_ID = new RegExp(`^${UUID.source}$`);

type Run = {
  runId: string;
  number: RowKey;
  slug: string;
  startedAt: string;
  agentId: string;
  mode: string;
  cwd: string | null;
  commentIds: string[];
  commits: 'one' | 'squash';
  provider: string;
  status: string;
  remoteHeadBefore: string | null;
  prSha: string;
  briefPath: string;
  resultPath: string;
  finishedAt?: string;
  pushWarned?: boolean;
  pushedByUser?: boolean;
};
type StackPr = { number?: RowKey | null; state?: string; isDraft?: boolean };
type BriefPr = Partial<ReviewPr> & Pick<ReviewPr, 'number' | 'head' | 'base'>;
type BriefOptions = { commits?: string; resultPath?: string; runId?: string };
type ResultEntry = { id?: string; status?: string; commit?: string | null; note?: unknown };
type LaunchAgents = { start(opts: Record<string, unknown>): Promise<{ agentId: string; createdWorkspace?: string | null }> };
type Outcome = { status: 'fixed' | 'declined'; resolution: { commit?: string | null; note?: string } };
type StartInput = { commits?: unknown; commentIds?: unknown; provider?: string; requestedBy?: unknown };
type Deps = { DATA: string; REPO: string; config: Config; works: Pick<Works, 'get' | 'save'>; comments: Pick<CommentsApi, 'list' | 'update'>; PERSONAS?: string; exec?: Exec; agents?: LaunchAgents };

const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const fenceFor = (text: unknown) => '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));
export const fenced = (text: string, lang = '') => {
  const f = fenceFor(text);
  return `${f}${lang}\n${text}\n${f}`;
};
const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};
export const capitalize = (s: unknown) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
export const byFileThenLine = (a: Pick<Comment, 'path' | 'startLine' | 'endLine'>, b: Pick<Comment, 'path' | 'startLine' | 'endLine'>) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine;
export const listText = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] || '');
// a bare name is a skill ("the `x` skill"), anything else is quoted as written
export const commitConventionText = (cc: string | undefined) => (!cc ? '' : /^[\w-]+$/.test(cc) ? `the \`${cc}\` skill` : cc);
export const sharedRules = (config: { repo: { rules?: string[]; commitConvention?: string } }) => {
  const rules = listText((config.repo.rules || []).map((r) => `\`${r}\``));
  const commits = commitConventionText(config.repo.commitConvention);
  return [
    '- Commit locally. NEVER `git push`, NEVER `gh pr comment`, `gh pr review` or `gh pr edit`, NEVER post or send anything anywhere (Slack, Notion, GitHub, email).',
    `- ${rules ? `Read ${rules}, then follow the rules that match the files you touch` : 'Follow the repo conventions for the files you touch'}${commits ? `; commit messages follow ${commits}` : ''}.`,
    '- Before the last commit, run the lint, format and type checks the repo rules name. Fix what they report, never suppress it.',
    '- Touch only what a comment asks for. A comment you disagree with or cannot satisfy is declined with a one-line reason, not worked around.',
  ];
};
export const commentSection = (c: Pick<Comment, 'id' | 'path' | 'startLine' | 'endLine' | 'body'> & Partial<Pick<Comment, 'side' | 'snippet' | 'ctxBefore' | 'ctxAfter'>>, level = '###') => {
  const code = [...(c.ctxBefore || []).map((l) => `  ${l}`), ...String(c.snippet || '').split('\n').map((l) => `> ${l}`), ...(c.ctxAfter || []).map((l) => `  ${l}`)].join('\n');
  return [`${level} ${c.id} · ${c.path}:${c.startLine}-${c.endLine} (${c.side || 'head'})`, '', fenced(code), '', c.body, ''];
};

export function createReviewAgent({ DATA, REPO, config, works, comments, PERSONAS = config.personasDir, exec = defaultExec, agents = createPaseoAgents() }: Deps) {
  const GH = config.repo.github;
  const SHARED_RULES = sharedRules(config);
  const reviewsDir = (slug: string) => path.join(DATA, 'works', slug, 'reviews');
  const runFile = (slug: string, n: RowKey | null, runId: string) => path.join(reviewsDir(slug), `pr-${fileKey(n)}-run-${runId}.json`);
  const briefFile = (slug: string, n: RowKey | null, runId: string) => path.join(reviewsDir(slug), `pr-${fileKey(n)}-run-${runId}.md`);
  const resultFile = (slug: string, n: RowKey | null, runId: string) => path.join(reviewsDir(slug), `pr-${fileKey(n)}-run-${runId}-result.json`);

  const checkSlug = (slug: string) => {
    if (!/^[\w.-]+$/.test(String(slug)) || String(slug).startsWith('.')) throw new HttpError(400, 'bad slug');
  };
  const checkNumber = (n: unknown): RowKey => {
    const key = parseKey(n);
    if (!key) throw new HttpError(400, 'bad pr number or branch key');
    return key;
  };

  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  }

  const writeRun = (run: Run) => {
    fs.mkdirSync(reviewsDir(run.slug), { recursive: true });
    const target = runFile(run.slug, run.number, run.runId);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 1));
    fs.renameSync(tmp, target);
  };

  function list(slug: string, key: unknown): Run[] {
    checkSlug(slug);
    const n = checkNumber(key);
    const dir = reviewsDir(slug);
    if (!fs.existsSync(dir)) return [];
    const prefix = `pr-${fileKey(n)}-run-`;
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && /^[0-9a-f]+\.json$/.test(f.slice(prefix.length)))
      .flatMap((f) => {
        const run = parseJson<Run | null>(fs.readFileSync(path.join(dir, f), 'utf8'), null);
        return run ? [run] : [];
      })
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  function timeline(slug: string, kind: string, text: string) {
    const work = works.get(slug);
    if (!work) return;
    work.timeline = work.timeline || [];
    work.timeline.unshift({ ts: new Date().toISOString(), kind, text });
    works.save(work);
  }

  function personaExcerpt(login: string) {
    if (!/^[\w.-]+$/.test(String(login))) return null;
    const file = path.join(PERSONAS, `${login}.md`);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const start = lines.findIndex((l) => /^##\s+What (?:he|she|they) checks\b/i.test(l));
    if (start < 0) return null;
    let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end < 0) end = lines.length;
    const section = lines.slice(start + 1, end);
    while (section.length && !section[0].trim()) section.shift();
    return { heading: lines[start].replace(/^##\s+/, ''), text: section.slice(0, 20).join('\n').trimEnd() };
  }

  function stackLine(stackPrs: StackPr[], index: number, n: RowKey | null) {
    const total = stackPrs.length;
    const parts = stackPrs.map((p, i) => {
      if (i === index) return `**${keyLabel(n)}**`;
      if (!p?.number) return '(planned)';
      if (p.state === 'MERGED') return `#${p.number} ✓ merged`;
      if (p.state === 'CLOSED') return `#${p.number} closed`;
      return `#${p.number} ${p.isDraft ? 'draft' : 'open'}`;
    });
    return `PR ${index + 1} of ${total}: ${parts.join(' → ')}`;
  }

  function buildBrief({ work, pr, index = 0, stackPrs = [], comments: cs = [], personas = [], options = {} }: { work: Pick<Work, 'slug' | 'notes'>; pr: BriefPr; index?: number; stackPrs?: StackPr[]; comments?: Comment[]; personas?: string[]; options?: BriefOptions }) {
    if (cs.length > MAX_COMMENTS) throw new HttpError(400, `at most ${MAX_COMMENTS} comments per run (got ${cs.length})`);
    if (!cs.length) throw new HttpError(400, 'no comments to address');
    const commits = options.commits === 'squash' ? 'squash' : 'one';
    const result = options.resultPath || resultFile(work.slug, pr.number, options.runId || 'RUN');
    const sorted = [...cs].sort(byFileThenLine);
    const out: string[] = [];

    const local = isLocal(pr.number);
    out.push(`# Fix review comments — ${local ? `local branch ${pr.head}` : `PR #${pr.number}`}: ${pr.title || ''}`.trimEnd(), '');
    out.push(`Run ${options.runId || '?'} for work \`${work.slug}\`. You address ${sorted.length} review comment${sorted.length === 1 ? '' : 's'} left by the owner on this ${local ? 'branch (no PR yet)' : 'PR'}.`, '');

    out.push('## Hard rules', '');
    out.push(`- Work on branch \`${pr.head}\` only. \`git branch --show-current\` must print \`${pr.head}\`; if it does not, stop and report instead of switching.`, ...SHARED_RULES, '');

    out.push('## PR', '');
    out.push(...(local ? [] : [`- Number: #${pr.number}`]), `- Title: ${pr.title || ''}`, ...(local ? [] : [`- URL: ${pr.url || ''}`]), `- Base: \`${pr.base}\``, `- Head: \`${pr.head}\``, `- Head sha: \`${pr.sha || ''}\``, `- ${stackLine(stackPrs.length ? stackPrs : [{ number: pr.number }], stackPrs.length ? index : 0, pr.number)}`, '');

    out.push('## PR body', '');
    out.push(pr.body && pr.body.trim() ? fenced(pr.body, 'markdown') : '(empty)', '');

    out.push('## Work rules', '');
    out.push(work.notes && work.notes.trim() ? fenced(work.notes, 'markdown') : '(none)', '');

    out.push('## Owner personas', '');
    const excerpts = personas.flatMap((login) => {
      const ex = personaExcerpt(login);
      return ex ? [{ login, ex }] : [];
    });
    if (!excerpts.length) out.push('(none)', '');
    for (const { login, ex } of excerpts) out.push(`### ${login} — ${ex.heading}`, '', ex.text, '');

    out.push('## Comments to address', '');
    for (const c of sorted) out.push(...commentSection(c));

    out.push('## How to report', '');
    if (commits === 'one') out.push('- One commit per fixed comment. Each commit message ends with the trailer `Cc-Comment: <id>` of the comment it fixes.');
    else out.push('- One single commit for all fixed comments. Its message lists one `Cc-Comment: <id>` trailer per fixed comment.');
    out.push(
      '- A comment you decline gets no commit.',
      `- Last step, once everything is committed, write \`${result}\` as a JSON array with one entry per comment above:`,
      '',
      fenced('[{ "id": "<comment id>", "status": "fixed" | "declined", "commit": "<sha or null>", "note": "<one line>" }]', 'json'),
      '',
      '- `commit` is the full sha of the commit that fixes the comment (the squash commit when squashing), `null` when declined; `note` says what you did or why you declined.',
      `- Do not push. ${capitalize(config.owner.name)} reviews the commits and pushes them.`,
      '',
    );
    return out.join('\n');
  }

  const worktreeFor = (head: string) => worktreeOf(REPO, head, exec);

  const agentsList = async (): Promise<PaseoAgentInfo[]> => {
    const r = await exec('paseo', ['ls', '--json']);
    const list = r.ok ? parseJson<unknown>(r.stdout, []) : [];
    return Array.isArray(list) ? list : [];
  };

  async function pickRunner(pr: Pick<ReviewPr, 'head' | 'number'>): Promise<Runner> {
    const cwd = await worktreeFor(pr.head);
    if (!cwd) return { mode: isLocal(pr.number) ? 'checkout-branch' : 'checkout-pr' };
    const agent = (await agentsList()).find((a) => a.cwd && a.status !== 'closed' && a.status !== 'error' && sameDir(a.cwd, cwd));
    if (agent) return { mode: 'send', agentId: agent.id, cwd };
    return { mode: 'cwd', cwd };
  }

  // starts the brief on the runner, returns the agent id; labels tell the Paseo plugin which cocopilot run the agent is on
  async function launch(runner: Runner, { title, provider, prompt, labels, requestedBy, n, branch }: LaunchInput) {
    const all: Record<string, unknown> = { source: 'cocopilot', ...labels };
    if (runner.mode === 'send' && runner.agentId) {
      const opts = { env: launcherEnv() };
      await exec('paseo', ['agent', 'update', runner.agentId, ...Object.entries(all).flatMap(([k, v]) => ['--label', `${k}=${v}`])], opts);
      const r = await exec('paseo', ['send', runner.agentId, prompt, '--behavior', 'steer', '--no-wait'], opts);
      if (!r.ok) throw new HttpError(500, `paseo send failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
      return runner.agentId;
    }
    const worktrees: Record<string, Record<string, unknown>> = { 'branch-off': { mode: 'branch-off', newBranch: runner.newBranch, base: runner.base, slug: runner.slug }, 'checkout-branch': { mode: 'checkout-branch', branch }, 'checkout-pr': { mode: 'checkout-pr', prNumber: n } };
    const worktree = worktrees[runner.mode] || null;
    if (AGENT_ID.test(String(requestedBy || ''))) all['paseo.parent-agent-id'] = requestedBy;
    let started: Awaited<ReturnType<LaunchAgents['start']>>;
    try {
      started = await agents.start({ title, provider, thinking: 'high', prompt, labels: all, cwd: runner.mode === 'cwd' ? runner.cwd : REPO, worktree });
    } catch (e) {
      throw new HttpError(500, `paseo agent start failed: ${errorMessage(e).slice(0, 300)}`);
    }
    const workSlug = labels?.work;
    if (started.createdWorkspace && typeof workSlug === 'string' && workSlug) timeline(workSlug, 'agent', `${worktree ? `new ${runner.mode} worktree` : `no Paseo workspace was open on ${runner.cwd}`}: created workspace ${started.createdWorkspace}`);
    return started.agentId;
  }

  const remoteHead = async (n: RowKey) => {
    const r = await exec('git', ['-C', REPO, 'ls-remote', 'origin', isLocal(n) ? `refs/heads/${branchOf(n)}` : `refs/pull/${n}/head`]);
    if (!r.ok) return null;
    return r.stdout.trim().split(/\s+/)[0] || null;
  };

  async function fetchPr(n: unknown): Promise<ReviewPr> {
    const r = await exec('gh', ['pr', 'view', String(n), '--repo', GH, '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,body']);
    const d = r.ok ? parseJson<{ number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string; headRefOid?: string; body?: string } | null>(r.stdout, null) : null;
    if (!d) throw new HttpError(404, `cannot read PR #${n}: ${r.stderr.slice(0, 200)}`);
    return { number: d.number, title: d.title, url: d.url, state: d.state, isDraft: d.isDraft, head: d.headRefName, base: d.baseRefName, sha: d.headRefOid || '', body: d.body || '' };
  }
  const branchSha = async (branch: string) => {
    const r = await exec('git', ['-C', REPO, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    return r.ok ? r.stdout.trim() || null : null;
  };
  // the PR fields of a stack row; a local row reads them from its plan and its branch
  async function rowPr(work: Work, index: number): Promise<ReviewPr> {
    const row = work.stack[index];
    const key = rowKey(row);
    if (!isLocal(key)) return fetchPr(key);
    const planned = row.planned ?? {};
    const head = planned.branch ?? '';
    const sha = await branchSha(head);
    if (!sha) throw new HttpError(404, `branch ${head} not found locally`);
    const parent = work.stack[index - 1];
    const base = !parent ? config.repo.defaultBranch : parent.planned?.branch || (await fetchPr(parent.number)).head;
    return { number: key, title: planned.title || head, url: '', state: 'LOCAL', isDraft: true, head, base, sha, body: planned.scope || '' };
  }
  async function fetchStackState(number: RowKey | null | undefined): Promise<StackPr> {
    if (!number) return { number: null };
    const r = await exec('gh', ['pr', 'view', String(number), '--repo', GH, '--json', 'number,state,isDraft']);
    const d = r.ok ? parseJson<{ number: number; state: string; isDraft: boolean } | null>(r.stdout, null) : null;
    return d ? { number: d.number, state: d.state, isDraft: d.isDraft } : { number };
  }

  async function start(slug: string, key: unknown, input: StartInput = {}) {
    checkSlug(slug);
    const n = checkNumber(key);
    return withLock(`${slug}:${n}`, async () => {
      const work = works.get(slug);
      if (!work) throw new HttpError(404, 'no such work');
      const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
      if (index < 0) throw new HttpError(404, `${keyLabel(n)} is not in this work`);
      const commits = input.commits === undefined ? 'one' : input.commits;
      if (commits !== 'one' && commits !== 'squash') throw new HttpError(400, "commits must be 'one' or 'squash'");
      const ids = input.commentIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'commentIds required');
      const wanted = new Set(ids.filter((x): x is string => typeof x === 'string'));
      if (wanted.size > MAX_COMMENTS) throw new HttpError(400, `at most ${MAX_COMMENTS} comments per run (got ${wanted.size})`);

      const stored = comments.list(slug, n).comments || [];
      const runs = list(slug, n);
      const picked: Comment[] = [];
      for (const id of wanted) {
        const c = stored.find((x) => x.id === id);
        if (!c) throw new HttpError(400, `no such comment ${id}`);
        if (c.status === 'outdated') continue;
        if (c.status === 'fixed' || c.status === 'declined') throw new HttpError(400, `comment ${id} is already ${c.status}`);
        if (c.status === 'sent' && runs.some((r) => r.runId === c.runId && r.status === 'running')) throw new HttpError(400, `comment ${id} is already with a running agent`);
        picked.push(c);
      }
      if (!picked.length) throw new HttpError(400, 'no open comments to send (outdated ones are skipped)');

      const [pr, stackPrs] = await Promise.all([rowPr(work, index), Promise.all(work.stack.map((s) => fetchStackState(s.number)))]);
      if (!pr.head) throw new HttpError(400, `${keyLabel(n)} has no head branch`);
      const runner = await pickRunner(pr);
      const runId = crypto.randomBytes(4).toString('hex');
      const provider = input.provider || config.models.default;
      const brief = briefFile(slug, n, runId);
      const result = resultFile(slug, n, runId);
      const text = buildBrief({ work, pr, index, stackPrs, comments: picked, personas: work.stack[index].personas || [], options: { commits, runId, resultPath: result } });
      fs.mkdirSync(reviewsDir(slug), { recursive: true });
      fs.writeFileSync(brief, text);
      const remoteHeadBefore = await remoteHead(n);

      const prompt = `Read ${brief} and follow it end to end.`;
      const agentId = await launch(runner, { title: `Fix review ${keyLabel(n)} (${picked.length})`, provider, prompt, labels: { kind: 'review', run: runId, work: slug, pr: fileKey(n), comments: picked.length }, requestedBy: input.requestedBy, n, branch: pr.head });

      const run: Run = {
        runId,
        number: n,
        slug,
        startedAt: new Date().toISOString(),
        agentId,
        mode: runner.mode,
        cwd: runner.cwd || null,
        commentIds: picked.map((c) => c.id),
        commits,
        provider,
        status: 'running',
        remoteHeadBefore,
        prSha: pr.sha,
        briefPath: brief,
        resultPath: result,
      };
      writeRun(run);
      for (const c of picked) await comments.update(slug, n, c.id, { status: 'sent', runId });
      timeline(slug, 'agent', `review ${keyLabel(n)}: sent ${picked.length} comments to ${runner.mode} agent ${String(agentId || '').slice(0, 8) || '?'}`);
      return run;
    });
  }

  async function applyOutcome(slug: string, n: RowKey, run: Run, id: string, outcome: Outcome) {
    const current = (comments.list(slug, n).comments || []).find((c) => c.id === id);
    if (!current || current.status !== 'sent' || current.runId !== run.runId) return false;
    await comments.update(slug, n, id, { status: outcome.status, runId: run.runId, resolution: outcome.resolution });
    return true;
  }

  async function trailerFixes(run: Run) {
    if (!run.cwd || !run.prSha) return [];
    return trailersBetween(run.cwd, run.prSha, 'HEAD');
  }
  async function trailersBetween(cwd: string, from: string, to: string) {
    const r = await exec('git', ['-C', cwd, 'log', `${from}..${to}`, '--format=%H%n%B%x00']);
    if (!r.ok) return [];
    const found: { id: string; commit: string }[] = [];
    for (const rec of r.stdout.split('\0')) {
      const [hash, ...rest] = rec.replace(/^\n+/, '').split('\n');
      if (!/^[0-9a-f]{40}$/.test(hash || '')) continue;
      for (const m of rest.join('\n').matchAll(/^Cc-Comment:\s*([0-9a-f]+)\s*$/gm)) found.push({ id: m[1], commit: hash });
    }
    return found;
  }

  async function ingestRun(slug: string, n: RowKey, run: Run, running: PaseoAgentInfo[]) {
    let runChanged = false;
    const agent = run.agentId ? running.find((a) => a.id === run.agentId) : null;
    if (!run.cwd && agent?.cwd) {
      run.cwd = expandHome(agent.cwd);
      runChanged = true;
    }

    if (!run.pushWarned && !run.pushedByUser && run.remoteHeadBefore) {
      const now = await remoteHead(n);
      if (now && now !== run.remoteHeadBefore) {
        run.pushWarned = true;
        runChanged = true;
        timeline(slug, 'warning', `review ${keyLabel(n)}: remote head moved during run ${run.runId.slice(0, 8)}`);
      }
    }

    if (fs.existsSync(run.resultPath)) {
      const entries = parseJson<(ResultEntry | null)[] | null>(fs.readFileSync(run.resultPath, 'utf8'), null);
      if (Array.isArray(entries)) {
        let fixed = 0;
        let declined = 0;
        for (const e of entries) {
          if (!e?.id || !run.commentIds.includes(e.id)) continue;
          const note = typeof e.note === 'string' ? e.note : '';
          if (e.status === 'fixed' && (await applyOutcome(slug, n, run, e.id, { status: 'fixed', resolution: { commit: e.commit || null, note } }))) fixed++;
          else if (e.status === 'declined' && (await applyOutcome(slug, n, run, e.id, { status: 'declined', resolution: { note } }))) declined++;
        }
        run.status = 'done';
        run.finishedAt = new Date().toISOString();
        timeline(slug, 'agent', `review ${keyLabel(n)}: ${fixed} fixed, ${declined} declined (${run.runId.slice(0, 8)})`);
        writeRun(run);
        return;
      }
    }

    let fixed = 0;
    for (const t of await trailerFixes(run)) {
      if (!run.commentIds.includes(t.id)) continue;
      if (await applyOutcome(slug, n, run, t.id, { status: 'fixed', resolution: { commit: t.commit, note: 'found via Cc-Comment trailer' } })) fixed++;
    }
    if (fixed) timeline(slug, 'agent', `review ${keyLabel(n)}: ${fixed} fixed from commit trailers (${run.runId.slice(0, 8)})`);
    const settled = Date.now() - Date.parse(run.startedAt) > SETTLE_MS;
    if (settled && (!agent || agent.status !== 'running')) {
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      runChanged = true;
    }
    if (runChanged || fixed) writeRun(run);
  }

  async function ingest(slug: string, key: unknown) {
    checkSlug(slug);
    const n = checkNumber(key);
    return withLock(`${slug}:${n}`, async () => {
      const running = list(slug, n).filter((r) => r.status === 'running');
      if (running.length) {
        const live = await agentsList();
        for (const run of running) await ingestRun(slug, n, run, live);
      }
      return { runs: list(slug, n) };
    });
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , n, , runId, action] = parts;
      checkSlug(slug);
      checkNumber(n);
      if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
      const parseBody = async () => {
        try {
          return JSON.parse((await readBody(req)) || '{}') || {};
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      };
      if (!runId) {
        if (req.method === 'GET') return send(res, 200, await ingest(slug, n));
        if (req.method === 'POST') return send(res, 200, await start(slug, n, await parseBody()));
        return send(res, 400, { error: `unsupported ${req.method}` });
      }
      if (!/^[0-9a-f]+$/.test(runId)) throw new HttpError(400, 'bad run id');
      const run = list(slug, n).find((r) => r.runId === runId);
      if (!run) return send(res, 404, { error: 'no such run' });
      if (action === 'logs' && req.method === 'GET') {
        if (!run.agentId) return send(res, 200, { ok: false, out: 'no agent id recorded for this run' });
        const r = await exec('paseo', ['logs', run.agentId, '--tail', '60']);
        return send(res, 200, { ok: r.ok, out: r.stdout || r.stderr });
      }
      if (action === 'brief' && req.method === 'GET') {
        if (!run.briefPath || !fs.existsSync(run.briefPath)) return send(res, 404, { error: 'no brief' });
        return send(res, 200, fs.readFileSync(run.briefPath, 'utf8'), 'text/plain');
      }
      if (action === 'pushed' && req.method === 'POST') {
        const updated = await withLock(`${slug}:${n}`, async () => {
          const fresh = list(slug, n).find((r) => r.runId === runId);
          if (!fresh) throw new HttpError(404, 'no such run');
          fresh.pushedByUser = true;
          writeRun(fresh);
          return fresh;
        });
        return send(res, 200, updated);
      }
      if (!action && req.method === 'GET') return send(res, 200, run);
      return send(res, 400, { error: `unsupported ${req.method} ${action || ''}`.trim() });
    } catch (e) {
      return send(res, e instanceof HttpError ? e.status : 500, { error: errorMessage(e) });
    }
  }

  return { handle, buildBrief, pickRunner, launch, start, ingest, list, rowPr, fetchStackState, exec, branchSha, worktreeFor, agentsList, remoteHead, trailersBetween, personaExcerpt, sameDir, timeline };
}
