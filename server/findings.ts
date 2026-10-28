// Findings board: every remark on a PR (review pages, coco's watch points, local comments, GitHub reviewers and bots, CI) in one list.
// A ledger keyed by (source, file, normalized claim) keeps a dismissed finding dismissed when the same reviewer raises it again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseFindings } from './review-import.ts';
import { fileKey, keyLabel, parseKey, rowKey } from './stack.ts';
import type { Jobs } from './jobs.ts';
import { cacheFile, swrCache } from './swr.ts';
import type { Block, Source } from './blocks.ts';
import type { AgentComment, Exec, PaseoAgentRow, ReadBody, Req, Res, Resolution, RowKey, Send, Work } from './core-types.ts';

const GH_TTL_MS = 120000;
const MAX_CLAIM = 200;

type Row = {
  key: string;
  n: RowKey | null;
  source: string;
  severity?: string | null;
  confidence?: number | null;
  path?: string | null;
  line?: number | null;
  endLine?: number | null;
  claim: string;
  body: string;
  url: string | null;
  ts?: string | null;
  file?: string;
  watchIndex?: number;
  sha?: string;
  commentId?: string | null;
  status?: string;
  accepted?: boolean;
  resolution?: Resolution | null;
  dismissed?: { at: string | null; reason: string } | null;
  summary?: string | null;
  category?: string | null;
  recommendation?: string | null;
  blocks?: Block[] | null;
  sources?: Source[] | null;
};
type LedgerEntry = { status: string; at?: string; reason?: string; commentId?: string | null };
type Ledger = Record<string, LedgerEntry>;
type BotGroups = Record<string, string>;
type WatchPoint = { path: string; startLine: number; endLine: number; body: string; severity?: string; confidence?: number | null };
type Board = { rows: (Row & { by: { group: string; name: string } })[]; errors: string[]; at?: string; stale?: boolean };
type StackRowInfo = { key: RowKey; number: number | null; branch: string | null; headSha: string | null; files: Set<string>; error?: string };
type InlineComment = { user: string; body: string; path: string; line: number | null; original_line: number | null; created_at: string; html_url: string };
type Review = { user: string; body: string; state: string; submitted_at: string; html_url: string };
type IssueComment = { user: string; body: string; created_at: string; html_url: string };
type Check = { name: string; bucket: string; link: string };
type ReviewFile = { file: string; source: string; mtime: string };
type FindingsOptions = {
  jobs?: Pick<Jobs, 'wrap'>;
  DATA: string;
  REPO: string;
  config: { owner: { login: string }; repo: { github: string; reviewsDir: string }; botGroups?: BotGroups | null };
  works: { get(slug: string): Work | null; remark(slug: string, remark: { n: RowKey; where: string; verdict: string; text: string }): unknown };
  comments: {
    list(slug: string, n: RowKey): { comments?: AgentComment[] };
    add(slug: string, n: RowKey, input: Record<string, unknown>): Promise<{ id: string }>;
    update(slug: string, n: RowKey, id: string, patch: Record<string, unknown>): Promise<unknown>;
  };
  code: { ensureRefs(n: RowKey): Promise<{ headSha: string }>; prFilesFromGit(n: RowKey, refs: { headSha: string }): Promise<{ filename: string }[]> };
  reviewPlan: {
    planState(slug: string, n: RowKey): { plan?: { watchPoints?: WatchPoint[]; createdAt: string | null; headSha: string } | null; watch?: Record<number, string | null | undefined> | null };
    watch(slug: string, n: RowKey, change: { index: number; state: string | null; note?: string }): unknown;
  };
  reviewAgent: { worktreeFor(branch: string): Promise<string | null>; rowPr(work: Work, index: number): Promise<{ head?: string | null }> };
  threads: { release(slug: string, key: string): Promise<{ key: string; outcome: string }> };
  exec?: Exec;
};
type ActBody = { action?: string; keys?: unknown; reason?: string; pr?: string | number | null };
const SEVERITY_WORDS: [RegExp, string][] = [
  [/\bnon-blocking\b/i, 'minor'],
  [/\b(blocking|critical)\b/i, 'blocking'],
  [/\b(high|major)\b/i, 'major'],
  [/\b(medium|minor)\b/i, 'minor'],
  [/\b(low|nit)\b/i, 'nit'],
];
const LEFT = ['new', 'open', 'sent', 'accepted'];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errStatus = (e: unknown) => (typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' && e.status ? e.status : 500);

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

export const normClaim = (text: unknown) =>
  String(text || '')
    .toLowerCase()
    .replace(/`[^`]*:\d+(-\d+)?`/g, ' ')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
export const findingKey = (source: string, file: string | null | undefined, claim: unknown) => crypto.createHash('sha1').update(`${source}|${file || ''}|${normClaim(claim)}`).digest('hex').slice(0, 12);

const clean = (line: string) =>
  line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`[\w@./-]+\.\w+(:\d+(-\d+)?)?`/g, '')
    .replace(/^(blocking|critical|high|major|medium|minor|low|nit)\s*·\s*/i, '')
    .replace(/^PR \d+\s*·\s*/i, '')
    .replace(/[\s,·:.-]+$/, '')
    .trim();

const META = /^(class|severity|confidence|recommendation|source|reviewer)\s*:/i;

// one line a reviewer would scan: the heading, plus the next line when the heading is only a label ("Check 2 (choke point)"); "Class: … · Severity: …" header lines are skipped
export function claimOf(body: unknown) {
  const all = String(body || '').split('\n').map(clean).filter(Boolean);
  const prose = all.filter((l) => !META.test(l));
  const lines = prose.length ? prose : all;
  const head = lines[0] || '';
  const claim = head.length < 40 && lines[1] ? `${head}: ${lines[1]}` : head;
  return claim.length > MAX_CLAIM ? `${claim.slice(0, MAX_CLAIM - 1)}…` : claim;
}
export const severityOf = (text: unknown) => SEVERITY_WORDS.find(([re]) => re.test(String(text || '').slice(0, 600)))?.[1] || null;
export const confidenceOf = (text: unknown) => {
  const m = String(text || '').match(/\bconfidence\W{0,6}(\d{1,3})\s*%|\b(\d{1,3})\s*% sure\b/i);
  const v = m ? Number(m[1] ?? m[2]) : NaN;
  return v <= 100 ? v : null;
};

// who raised it, for the board's reviewer strip: personas (persona reviews), me, agents (coco, review agents, bots), team (GitHub humans), each bot group of config.botGroups, ci
export const reviewerOf = (source: string, botGroups: BotGroups = {}) => {
  const [kind = '', name = kind] = String(source).split(/:(.*)/);
  const known: Record<string, string> = { 'review-as': 'personas', ci: 'ci', github: 'team' };
  const group = Object.hasOwn(botGroups, kind) ? kind : known[kind] || (source === 'local' ? 'me' : 'agents');
  return { group, name: source === 'local' ? 'me' : name };
};

// a GitHub login's source: the first bot group whose substring it contains, else bot:<name> or github:<login>
export const githubSourceOf = (login: string, botGroups: BotGroups = {}) => {
  const group = Object.entries(botGroups).find(([, sub]) => sub && String(login).toLowerCase().includes(String(sub).toLowerCase()));
  return group ? group[0] : /\[bot\]$/.test(login) ? `bot:${login.replace(/\[bot\]$/, '')}` : `github:${login}`;
};

// status of each raw row from the comment it became, coco's watch state, then the ledger; a comment with a row of its own is not listed twice
export function settle(raw: Row[], { comments = [], ledger = {}, watch = {}, me = 'me' }: { comments?: AgentComment[]; ledger?: Ledger; watch?: Record<number, string | null | undefined>; me?: string }): Row[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const byClaim = new Map(comments.map((c) => [`${c.path}|${normClaim(c.title || claimOf(c.body))}`, c]));
  const used = new Set<string>();
  const rows = raw.map((r): Row => {
    const entry = ledger[r.key];
    const c = byId.get(entry?.commentId ?? '') || (r.path ? byClaim.get(`${r.path}|${normClaim(r.claim)}`) : undefined);
    if (c) used.add(c.id);
    const watchState = r.watchIndex != null ? watch[r.watchIndex] : null;
    const status = c ? c.status : entry?.status || (watchState === 'dismissed' ? 'dismissed' : 'new');
    return { ...r, ...(c ? { ...richOf(c), claim: c.title || r.claim, severity: c.severity || r.severity, confidence: c.confidence ?? r.confidence } : {}), commentId: c?.id || null, status, accepted: entry?.status === 'accepted' || r.source === 'local', resolution: c?.resolution || null, dismissed: status === 'dismissed' ? { at: entry?.at || null, reason: entry?.reason || '' } : null };
  });
  const own = comments.filter((c) => !used.has(c.id)).map((c) => commentRow(c, null, me)).map((r) => ({ ...r, accepted: r.accepted || ledger[r.key]?.status === 'accepted' }));
  const seen = new Set();
  return [...rows, ...own].filter((r) => !seen.has(r.key) && seen.add(r.key));
}

// a structured finding's parts (coco-findings skill); the board renders them in place of the markdown body
const richOf = (c: AgentComment) => ({ summary: c.summary || null, category: c.category || null, recommendation: c.recommendation || null, blocks: c.blocks || null, sources: c.sources || null });

const commentRow = (c: AgentComment, n: RowKey | null, me: string): Row => {
  // author `as-<login>`: a persona posted through the coco-findings skill
  const source = !c.author || c.author === me ? 'local' : c.author.startsWith('as-') ? `review-as:${c.author.slice(3)}` : `local:${c.author}`;
  const claim = c.title || claimOf(c.body);
  return { key: findingKey(source, c.path, claim), n, source, severity: c.severity || severityOf(c.body), confidence: c.confidence ?? confidenceOf(c.body), path: c.path, line: c.startLine, endLine: c.endLine, claim, body: c.body, url: null, ts: c.createdAt, status: c.status, accepted: source === 'local', ...richOf(c), commentId: c.id, resolution: c.resolution || null, dismissed: null };
};

// a persona review page names its personas in the title ("# Review as Alice Doe (`alice`)"); anything else is a local review
export const reviewSource = (name: string, text = '') => {
  const title = (text.match(/^# (.*)$/m) || [])[1] || '';
  const logins: (string | undefined)[] = /^review\b/i.test(title) ? [...title.matchAll(/`([\w.-]+)`/g)].map((m) => m[1]) : [];
  if (!logins.length && /^review as /i.test(title)) logins.push(title.split(/\s+/)[2]);
  const named = name.match(/review-as-([\w.-]+?)(\.md)?$/i);
  if (!logins.length && named) logins.push(named[1]);
  return logins.length ? `review-as:${logins.join('+')}` : 'review-local';
};

export function createFindings({ DATA, REPO, config, works, comments, code, reviewPlan, reviewAgent, threads, exec = defaultExec, jobs }: FindingsOptions) {
  const GH = config.repo.github;
  const ME = config.owner.login;
  const BOTS = config.botGroups || {};
  const botSubs = Object.values(BOTS).filter(Boolean).map((s) => String(s).replace(/[^\w-]/g, ''));
  const ledgerFile = (slug: string) => path.join(DATA, 'works', slug, 'findings.json');
  const readLedger = (slug: string): Ledger => {
    try {
      return JSON.parse(fs.readFileSync(ledgerFile(slug), 'utf8'));
    } catch {
      return {};
    }
  };
  const writeLedger = (slug: string, ledger: Ledger) => {
    fs.mkdirSync(path.dirname(ledgerFile(slug)), { recursive: true });
    fs.writeFileSync(ledgerFile(slug), JSON.stringify(ledger, null, 1));
  };

  const ghCache = swrCache<unknown>(GH_TTL_MS, cacheFile(DATA, 'findings-gh'));
  const gh = <T>(args: string[], lines = true): Promise<T> =>
    ghCache(args.join(' '), () =>
      exec('gh', args).then((r) => {
        try {
          return lines ? r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(r.stdout);
        } catch {
          return lines ? [] : null;
        }
      }),
    ) as Promise<T>;

  // GitHub reviewers (inline comments and review bodies), bot groups and other bots, failed CI checks; the PR author's own remarks are not findings
  async function githubRows(n: number, headSha: string | null): Promise<Row[]> {
    const api = <T>(p: string, jq: string) => gh<T[]>(['api', '--paginate', `repos/${GH}/${p}?per_page=100`, '--jq', jq]);
    const [author, inline, reviews, issue, checks] = await Promise.all([
      gh<string | null>(['api', `repos/${GH}/pulls/${n}`, '--jq', '.user.login'], false).catch(() => null),
      api<InlineComment>(`pulls/${n}/comments`, '.[] | select(.in_reply_to_id == null) | {user: .user.login, body, path, line, original_line, created_at, html_url}'),
      api<Review>(`pulls/${n}/reviews`, '.[] | select(.body != "") | {user: .user.login, body, state, submitted_at, html_url}'),
      botSubs.length ? api<IssueComment>(`issues/${n}/comments`, `.[] | select(.user.login | test("${botSubs.join('|')}"; "i")) | {user: .user.login, body, created_at, html_url}`) : [],
      gh<Check[] | null>(['pr', 'checks', String(n), '--repo', GH, '--json', 'name,bucket,link'], false),
    ]);
    const sourceOf = (login: string) => githubSourceOf(login, BOTS);
    const row = (source: string, { path: p = null, line = null, body, ts, url, severity }: { path?: string | null; line?: number | null; body: string; ts?: string; url: string; severity?: string | null }): Row => {
      const claim = claimOf(body);
      return { key: findingKey(source, p, claim), n, source, severity: severity || severityOf(body), confidence: confidenceOf(body), path: p, line, endLine: line, claim, body, url, ts };
    };
    const human = (x: { user: string }) => x.user !== author;
    return [
      ...inline.filter(human).map((x) => row(sourceOf(x.user), { path: x.path, line: x.line || x.original_line, body: x.body, ts: x.created_at, url: x.html_url })),
      ...reviews.filter(human).map((x) => row(sourceOf(x.user), { body: x.body, ts: x.submitted_at, url: x.html_url, severity: x.state === 'CHANGES_REQUESTED' ? 'major' : null })),
      ...issue.map((x) => row(sourceOf(x.user), { body: x.body, ts: x.created_at, url: x.html_url })),
      // a CI failure is keyed per head: dismissing a flaky run does not hide the next real failure
      ...(Array.isArray(checks) ? checks : []).filter((c) => c.bucket === 'fail').map((c) => row('ci', { body: `${c.name} failed on ${String(headSha || '').slice(0, 7)}`, url: c.link, severity: 'major' })),
    ];
  }

  // review pages on disk: the work's review artifacts, the reviews dir of the PR worktrees, and the repo's ones that name a stack PR
  async function reviewFiles(work: Work, rows: StackRowInfo[]) {
    const out: ReviewFile[] = [];
    const add = (file: string, name: string) => out.push({ file, source: reviewSource(name, fs.readFileSync(file, 'utf8').slice(0, 400)), mtime: fs.statSync(file).mtime.toISOString() });
    const art = path.join(DATA, 'works', work.slug, 'artifacts');
    for (const name of fs.existsSync(art) ? fs.readdirSync(art).filter((x) => /review/i.test(x)) : []) {
      const full = path.join(art, name);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (st?.isFile()) add(full, name);
      if (st?.isDirectory()) for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.md'))) add(path.join(full, f), name);
    }
    for (const r of rows) {
      const wt = r.branch ? await reviewAgent.worktreeFor(r.branch) : null;
      const dir = wt ? path.join(wt, config.repo.reviewsDir) : null;
      if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) add(path.join(dir, f), f);
    }
    const repo = path.join(REPO, config.repo.reviewsDir);
    const numbers = rows.map((r) => r.number).filter(Boolean);
    for (const f of numbers.length && fs.existsSync(repo) ? fs.readdirSync(repo).filter((x) => x.endsWith('.md')) : []) {
      const head = fs.readFileSync(path.join(repo, f), 'utf8').slice(0, 600);
      if (numbers.some((num) => new RegExp(`#${num}\\b`).test(head))) add(path.join(repo, f), f);
    }
    return [...new Map(out.map((x) => [x.file, x])).values()];
  }

  async function stackRows(work: Work): Promise<StackRowInfo[]> {
    return Promise.all((work.stack || []).map(async (s, index): Promise<StackRowInfo | null> => {
      const key = rowKey(s);
      if (!key) return null;
      try {
        const refs = await code.ensureRefs(key);
        const files = new Set((await code.prFilesFromGit(key, refs)).map((f) => f.filename));
        const pr = s.number ? null : await reviewAgent.rowPr(work, index).catch(() => null);
        return { key, number: s.number || null, branch: s.planned?.branch || pr?.head || null, headSha: refs.headSha, files };
      } catch (e) {
        const notBuiltYet = !s.number && (e as { code?: number }).code === 404;
        return { key, number: s.number || null, branch: s.planned?.branch || null, headSha: null, files: new Set<string>(), error: notBuiltYet ? undefined : errText(e) };
      }
    })).then((x) => x.filter((r) => r !== null));
  }

  // only: one row key; the other rows still lend their files to place review findings
  async function collect(slug: string, only: RowKey | null = null): Promise<Board> {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const rows = await stackRows(work);
    const errors = rows.filter((r) => r.error).map((r) => `${keyLabel(r.key)}: ${r.error}`);
    const raw: Row[] = [];
    for (const f of await reviewFiles(work, rows)) {
      for (const x of parseFindings(fs.readFileSync(f.file, 'utf8'))) {
        const claim = claimOf(x.body);
        raw.push({ key: findingKey(f.source, x.path, claim), n: rows.findLast((r) => r.files.has(x.path))?.key ?? null, source: f.source, severity: severityOf(x.body), confidence: confidenceOf(x.body), path: x.path, line: x.startLine, endLine: x.endLine, claim, body: x.body, url: null, ts: f.mtime, file: f.file });
      }
    }
    raw.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const ledger = readLedger(slug);
    const out: Row[] = [];
    for (const r of rows.filter((x) => only === null || x.key === only)) {
      const { plan, watch } = reviewPlan.planState(slug, r.key);
      const coco = (plan?.watchPoints || []).map((w, index): Row => {
        const claim = claimOf(w.body);
        return { key: findingKey('coco', w.path, claim), n: r.key, source: 'coco', severity: w.severity || severityOf(w.body), confidence: w.confidence, path: w.path, line: w.startLine, endLine: w.endLine, claim, body: w.body, url: null, ts: plan?.createdAt, watchIndex: index, sha: plan?.headSha };
      });
      const gh = r.number ? await githubRows(r.number, r.headSha) : [];
      const mine = raw.filter((x) => x.n === r.key);
      const stored = comments.list(slug, r.key).comments || [];
      out.push(...settle([...mine, ...coco, ...gh], { comments: stored, ledger, watch: watch || {}, me: ME }).map((x) => ({ ...x, n: x.n ?? r.key })));
    }
    if (only === null) out.push(...settle(raw.filter((x) => x.n === null), { ledger, me: ME }));
    return { rows: out.map((r) => ({ ...r, by: reviewerOf(r.source, BOTS) })), errors };
  }

  // the last board of each view, in memory and on disk, so a reload or a restart shows it at once while GitHub is asked again
  const cache = new Map<string, { at: number; data: Board }>();
  const inflight = new Map<string, Promise<Board>>();
  const generation = new Map<string, number>();
  const snapFile = (slug: string, only: RowKey | null) => path.join(DATA, 'works', slug, 'findings-cache', `${only === null ? 'stack' : fileKey(only)}.json`);
  function refresh(slug: string, only: RowKey | null): Promise<Board> {
    const k = `${slug}|${only}`;
    const running = inflight.get(k);
    if (running) return running;
    const gen = generation.get(slug) || 0;
    const promise = collect(slug, only)
      .then((data) => {
        // a decision taken while this ran made it stale: keep it out of the caches
        if ((generation.get(slug) || 0) !== gen) return data;
        const at = Date.now();
        cache.set(k, { at, data });
        fs.mkdirSync(path.dirname(snapFile(slug, only)), { recursive: true });
        fs.writeFileSync(snapFile(slug, only), JSON.stringify({ at: new Date(at).toISOString(), data }));
        return data;
      })
      .finally(() => inflight.get(k) === promise && inflight.delete(k));
    inflight.set(k, promise);
    return promise;
  }
  async function rowsOf(slug: string, only: RowKey | null, fresh: boolean) {
    const hit = cache.get(`${slug}|${only}`);
    if (!fresh && hit && Date.now() - hit.at < 15000) return hit.data;
    // an asked refresh must see a comment posted within the GitHub cache's lifetime
    if (fresh) ghCache.drop();
    return refresh(slug, only);
  }
  function snapshot(slug: string, only: RowKey | null): Board | null {
    const hit = cache.get(`${slug}|${only}`);
    if (hit) return { ...hit.data, at: new Date(hit.at).toISOString() };
    try {
      const { at, data } = JSON.parse(fs.readFileSync(snapFile(slug, only), 'utf8'));
      return { ...data, at };
    } catch {
      return null;
    }
  }
  const forget = (slug: string) => {
    generation.set(slug, (generation.get(slug) || 0) + 1);
    for (const k of [...cache.keys(), ...inflight.keys()].filter((x) => x.startsWith(`${slug}|`))) {
      cache.delete(k);
      inflight.delete(k);
    }
  };

  // accept: the finding becomes an open local comment at the head (coco's keeps severity and confidence); a finding without a file is only marked accepted
  async function accept(slug: string, row: Row) {
    if (row.commentId) return row.commentId;
    const n = row.n;
    if (row.source === 'coco' && n !== null) {
      const c = await comments.add(slug, n, { path: row.path, side: 'head', sha: row.sha, startLine: row.line, endLine: row.endLine, body: row.body, author: 'coco', severity: row.severity, confidence: row.confidence });
      if (row.watchIndex !== undefined) reviewPlan.watch(slug, n, { index: row.watchIndex, state: 'accepted' });
      return c.id;
    }
    if (!row.path || !row.line || n === null) return null;
    const refs = await code.ensureRefs(n);
    const author = row.source.split(':')[1] || row.source;
    const c = await comments.add(slug, n, { path: row.path, side: 'head', sha: refs.headSha, startLine: row.line, endLine: Math.max(row.line, row.endLine || row.line), body: row.body, author: author.replace(/[^\w.-]/g, '').slice(0, 40) || 'reviewer', severity: row.severity || undefined });
    return c.id;
  }

  async function act(slug: string, { action, keys, reason = '', pr = null }: ActBody) {
    if (!action || !['accept', 'dismiss', 'reopen'].includes(action)) throw new HttpError(400, "action must be 'accept', 'dismiss' or 'reopen'");
    if (!Array.isArray(keys) || !keys.length) throw new HttpError(400, 'keys required');
    const only = pr === null ? null : parseKey(pr);
    const { rows } = await rowsOf(slug, only, false);
    const ledger = readLedger(slug);
    const at = new Date().toISOString();
    const done: string[] = [];
    const settled: string[] = [];
    for (const key of new Set<string>(keys)) {
      const row = rows.find((r) => r.key === key);
      if (!row) throw new HttpError(404, `no such finding ${key}`);
      if (action === 'accept') {
        const commentId = await accept(slug, row);
        ledger[key] = { status: 'accepted', at, commentId };
      } else if (action === 'dismiss') {
        if (row.commentId && row.n !== null && ['open', 'sent', 'outdated'].includes(row.status ?? '')) await comments.update(slug, row.n, row.commentId, { status: 'declined', ...(reason ? { resolution: { ...(row.resolution || {}), note: reason }, remark: reason } : {}) });
        else if (row.source === 'coco' && row.n !== null && row.watchIndex !== undefined && !row.commentId) reviewPlan.watch(slug, row.n, { index: row.watchIndex, state: 'dismissed', ...(reason ? { note: reason } : {}) });
        else if (reason) works.remark(slug, { n: row.n ?? 'stack', where: row.path ? `${row.path.split('/').pop()} L${row.line || '?'}` : `"${row.claim.slice(0, 60)}"`, verdict: `${row.source} finding dismissed`, text: reason });
        ledger[key] = { status: 'dismissed', at, reason: reason.trim(), commentId: row.commentId || undefined };
      } else {
        if (row.commentId && row.n !== null && row.status === 'declined') await comments.update(slug, row.n, row.commentId, { status: 'open' });
        if (row.source === 'coco' && row.n !== null && row.watchIndex !== undefined && !row.commentId) reviewPlan.watch(slug, row.n, { index: row.watchIndex, state: null });
        delete ledger[key];
      }
      done.push(key);
      if (action !== 'reopen' && row.commentId) settled.push(`c.${String(row.n).replaceAll(':', '~')}.${row.commentId}`);
    }
    writeLedger(slug, ledger);
    forget(slug);
    // a settled finding no longer needs its dispatched agent
    const pruned: { key: string; outcome: string; reason?: string }[] = [];
    for (const threadKey of settled) pruned.push(await threads.release(slug, threadKey).catch((e) => ({ key: threadKey, outcome: 'error', reason: errText(e) })));
    return { done, pruned: pruned.filter((p) => p.outcome !== 'none'), ...(await rowsOf(slug, only, false)), left: LEFT };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const slug = parts[1];
      if (!slug || !works.get(slug)) return send(res, 404, { error: 'no such work' });
      if (req.method === 'POST') return send(res, 200, await act(slug, JSON.parse((await readBody(req)) || '{}')));
      const url = new URL(req.url || '/', 'http://x');
      const pr = url.searchParams.get('pr');
      const only = pr ? parseKey(pr) : null;
      // stale=1: the saved board right away (`stale: true`), the refresh keeps running for the follow-up request to join
      const snap = url.searchParams.get('stale') === '1' && snapshot(slug, only);
      if (snap) {
        refresh(slug, only).catch(() => {});
        return send(res, 200, { ...snap, stale: true, left: LEFT });
      }
      const fresh = url.searchParams.get('fresh') === '1';
      const board = fresh && jobs ? await jobs.wrap({ work: slug, pr: only, action: 'findings-collect', label: `Collect findings${only === null ? '' : ` ${keyLabel(only)}`}`, kind: 'sync' }, () => rowsOf(slug, only, true), (b) => `${b.rows.length} findings`) : await rowsOf(slug, only, fresh);
      return send(res, 200, { ...board, left: LEFT });
    } catch (e) {
      return send(res, errStatus(e), { error: errText(e) });
    }
  }

  // a dispatched agent settles its own finding, on the owner's request
  async function actOnComment(slug: string, n: RowKey, commentId: string, { action, reason }: { action: string; reason: string }) {
    const { rows } = await rowsOf(slug, n, true);
    const row = rows.find((r) => r.commentId === commentId);
    if (!row) throw new HttpError(404, 'finding not on the board');
    return act(slug, { action, keys: [row.key], reason, pr: String(n) });
  }

  return { handle, collect, act, actOnComment, snapshot };
}
