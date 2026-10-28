// Works: long-term context tied to a Paseo project — PR stack, artifacts, links, personas, notes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { globToRegExp, surfaceGlobs } from './glob.ts';
import { createNotionSync } from './notion.ts';
import type { NotionAgents } from './notion.ts';
import type { Jobs } from './jobs.ts';
import { keyLabel, rowKey } from './stack.ts';
import { decisionBullet, decisionSummary, validChoice } from './decisions.ts';
import type { Decision } from './decisions.ts';
import { blocksToMarkdown, readSuggestionBefore, validateRich } from './blocks.ts';
import { validateNext } from './next.ts';
import { GITHUB_MIN_FRESH_MS, batcher, cacheFile, swrCache } from './swr.ts';
import type { Config } from './config.ts';
import { errorMessage } from './core-types.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import type { Artifact, ArtifactMeta, PrInfo, ReadBody, Req, Res, RunResult, Send, Work } from './core-types.ts';

// what a work change touched: the work itself, its stack, review plan, drift or artifacts
export type Change = 'work' | 'stack' | 'plan' | 'drift' | 'artifacts';

const HOME = os.homedir();
const run = (cmd: string, args: string[], opts: ExecFileOptions = {}) =>
  new Promise<RunResult>((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
const parseJson = <T>(r: RunResult, fallback: T): T => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fallback;
  }
};
const MIME: Record<string, string> = { '.html': 'text/html', '.md': 'text/plain', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.diff': 'text/plain', '.ts': 'text/plain' };

interface PaseoProject {
  name: string;
  projectId: string;
}
interface PaseoWorkspace {
  project: string;
  cwd: string;
}
interface PaseoAgent {
  cwd: string;
  status?: string;
}
interface GhCheck {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}
const PR_FIELDS = 'number title url state isDraft reviewDecision headRefName baseRefName headRefOid isCrossRepository additions deletions changedFiles mergedAt updatedAt body labels(first:20){nodes{name}} reviews(last:100){nodes{author{login} state}} reviewThreads(first:100){nodes{isResolved}} commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}';
interface GhPr {
  number: number;
  body?: string;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  headRefName: string;
  baseRefName: string;
  headRefOid?: string;
  isCrossRepository?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergedAt: string | null;
  updatedAt: string;
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: GhCheck[] } } | null } }[] };
  reviews?: { nodes: { author?: { login: string } | null; state: string }[] };
  reviewThreads?: { nodes: { isResolved: boolean }[] };
  labels?: { nodes: { name: string }[] };
}
interface GhPrNode {
  info: PrInfo;
  body: string;
}
interface PrFile {
  filename: string;
  additions: number;
  deletions: number;
  status: string;
}
interface Snapshot {
  state?: string;
  isDraft?: boolean;
  ci?: string;
  reviewDecision?: string | null;
  sha?: string;
  reviewers: Record<string, string>;
}
interface ArtifactSource {
  pr?: string | number | null;
  kind?: string | null;
  headSha?: string | null;
}
interface DecideInput {
  id: string;
  choice?: Decision['choice'];
  rationale?: string;
  status?: string;
  archived?: boolean;
}
interface NotionBody {
  action?: string;
  url?: string;
  force?: boolean;
  parentPageId?: string | null;
  mode?: string;
}

export function createWorks({ DATA, PERSONAS, REPO, config, agents, jobs }: { DATA: string; PERSONAS: string; REPO: string; config: Config; agents?: NotionAgents; jobs?: Pick<Jobs, 'start' | 'link' | 'wrap'> }) {
  const hooks: { onArchived?: (number: number) => unknown; onAutoArchived?: (work: Work) => unknown; onRetitled?: (work: Work) => unknown; placeWork?: (slug: string) => Promise<{ workspaceId: string; cwd: string }>; forgetWork?: (work: Work) => Promise<string[]>; drift?: (slug: string) => Promise<unknown> } = {};
  const GITHUB = config.repo.github;
  const noRepo: RunResult = { ok: false, stdout: '', stderr: 'no GitHub repo configured (repo.github)' };
  const gh = (args: string[]) => (GITHUB ? run('gh', args) : Promise.resolve(noRepo));
  const notion = createNotionSync({ DATA, REPO, config, jobs, ...(agents ? { agents } : {}), works: { get: (s) => get(s), save: (x) => save(x), listArtifacts: (s) => listArtifacts(s), detailPrs: (s) => Promise.all((get(s)?.stack || []).map((x) => prInfo(x.number))), prInfo: (n) => prInfo(n), place: (s) => hooks.placeWork?.(s) || null } });
  const ROOT = path.join(DATA, 'works');
  fs.mkdirSync(ROOT, { recursive: true });
  const file = (slug: string) => path.join(ROOT, `${slug}.json`);
  const artDir = (slug: string) => path.join(ROOT, slug, 'artifacts');
  const prCache = swrCache<GhPrNode>(60000, cacheFile(DATA, 'pr'), { minFreshMs: GITHUB_MIN_FRESH_MS });
  const freshAt = new Map<string, number>();

  const list = (): Work[] =>
    fs
      .readdirSync(ROOT)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.state.json'))
      .map((f): Work => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const get = (slug: string): Work | null => (fs.existsSync(file(slug)) ? JSON.parse(fs.readFileSync(file(slug), 'utf8')) : null);
  // listeners run in the order they were added
  const listeners = new Set<(slug: string, what: Change) => void>();
  const onChange = (fn: (slug: string, what: Change) => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };
  const changed = (slug: string, what: Change = 'work') => listeners.forEach((l) => l(slug, what));
  const save = (work: Work, { touch = true, what }: { touch?: boolean; what?: Change } = {}) => {
    if (touch) work.updatedAt = new Date().toISOString();
    const before = get(work.slug);
    if (before && before.title !== work.title) Promise.resolve(hooks.onRetitled?.(work)).catch(() => {});
    fs.writeFileSync(file(work.slug), JSON.stringify(work, null, 1));
    changed(work.slug, what ?? (before && JSON.stringify(before.stack) !== JSON.stringify(work.stack) ? 'stack' : 'work'));
    return work;
  };

  // topic `works`: the slug of each work changed, so open pages reload it
  function watch(sink: Sink) {
    sink.onClose(onChange((slug) => sink.send(JSON.stringify({ slug }))));
  }

  // topic `work:<slug>`: { slug, what } for each change of that work
  function watchWork(sink: Sink, slug: string) {
    sink.onClose(onChange((s, what) => s === slug && sink.send(JSON.stringify({ slug, what }))));
  }

  async function paseo() {
    const [p, w, a] = await Promise.all([run('paseo', ['project', 'ls', '--json']), run('paseo', ['workspace', 'ls', '--json']), run('paseo', ['ls', '--json'])]);
    const projects = parseJson<PaseoProject[]>(p, []);
    const workspaces = parseJson<PaseoWorkspace[]>(w, []);
    const paseoAgents = parseJson<PaseoAgent[]>(a, []).map((x) => ({ ...x, cwdAbs: x.cwd.replace(/^~/, HOME) }));
    const works = list();
    const tree = projects.map((pr) => {
      const ws = workspaces
        .filter((x) => x.project === pr.name)
        .map((x) => ({ ...x, agents: paseoAgents.filter((ag) => ag.cwdAbs === x.cwd) }));
      const work = works.find((wk) => wk.projectId === pr.projectId);
      return { ...pr, workspaces: ws, agentCount: ws.reduce((n, x) => n + x.agents.length, 0), running: ws.reduce((n, x) => n + x.agents.filter((ag) => ag.status === 'running').length, 0), work: work ? { slug: work.slug, title: work.title } : null };
    });
    const orphanAgents = paseoAgents.filter((ag) => !workspaces.some((x) => x.cwd === ag.cwdAbs));
    return { projects: tree, orphanAgents, error: p.ok ? null : p.stderr };
  }

  // one GraphQL call for every PR asked within the same few ms (a page load asks for the whole stack at once)
  const fetchPrs = batcher<number, GhPrNode>(async (numbers) => {
    if (!GITHUB) throw new Error(noRepo.stderr);
    const [owner, name] = GITHUB.split('/');
    const query = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${numbers.map((n) => `p${n}:pullRequest(number:${n}){...P}`).join(' ')}}} fragment P on PullRequest{${PR_FIELDS}}`;
    const r = await run('gh', ['api', 'graphql', '-f', `query=${query}`]);
    const repo = parseJson<{ data?: { repository?: Record<string, GhPr | null> } }>(r, {}).data?.repository;
    if (!repo) throw new Error(r.stderr.slice(0, 200));
    return new Map(numbers.flatMap((n) => {
      const d = repo[`p${n}`];
      return d ? [[n, { info: toPrInfo(d), body: d.body || '' }]] : [];
    }));
  });
  const prNode = (number: number, fresh = false) => prCache(String(number), () => fetchPrs(number), fresh);

  async function prInfo(number: number | null | undefined, fresh = false): Promise<PrInfo> {
    if (!number) return { number: null, state: 'PLANNED', isDraft: false, ci: 'none', checks: [], reviewers: [], additions: 0, deletions: 0, changedFiles: 0 };
    return prNode(number, fresh).then((n) => n.info, (e: Error) => ({ number, error: e.message }));
  }
  function toPrInfo(d: GhPr): PrInfo {
    const contexts = d.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes || [];
    // a status context has a state only: SUCCESS / FAILURE / ERROR are final, PENDING / EXPECTED run
    const checks = contexts.map((c) => {
      const final = c.state && !['PENDING', 'EXPECTED'].includes(c.state);
      return { name: c.name || c.context || '', status: c.status || (final ? 'COMPLETED' : c.state || ''), conclusion: c.conclusion || (final ? (c.state === 'SUCCESS' ? 'SUCCESS' : 'FAILURE') : ''), url: c.detailsUrl || c.targetUrl || '' };
    });
    return {
      number: d.number,
      title: d.title,
      url: d.url,
      state: d.state,
      isDraft: d.isDraft,
      reviewDecision: d.reviewDecision,
      head: d.headRefName,
      base: d.baseRefName,
      sha: (d.headRefOid || '').slice(0, 11),
      headOid: d.headRefOid || null,
      isCrossRepository: !!d.isCrossRepository,
      additions: d.additions,
      deletions: d.deletions,
      changedFiles: d.changedFiles,
      mergedAt: d.mergedAt,
      updatedAt: d.updatedAt,
      labels: (d.labels?.nodes || []).map((l) => l.name),
      ci: checks.length === 0 ? 'none' : checks.some((c) => c.conclusion === 'FAILURE') ? 'failure' : checks.some((c) => c.status !== 'COMPLETED') ? 'pending' : 'success',
      checks,
      unresolvedThreads: (d.reviewThreads?.nodes || []).filter((t) => !t.isResolved).length,
      reviewers: Object.entries((d.reviews?.nodes || []).reduce<Record<string, string>>((acc, rv) => ((acc[rv.author?.login || '?'] = rv.state), acc), {})).map(([login, state]) => ({ login, state })),
    };
  }

  // { [artifact name]: { pr, kind, headSha, at } }: which PR head a kit piece was made for
  const metaFile = (slug: string) => path.join(artDir(slug), '.meta.json');
  const readMeta = (slug: string): Record<string, ArtifactMeta> => (fs.existsSync(metaFile(slug)) ? JSON.parse(fs.readFileSync(metaFile(slug), 'utf8')) : {});
  function setArtifactMeta(slug: string, name: string, meta: Omit<ArtifactMeta, 'at'>) {
    fs.mkdirSync(artDir(slug), { recursive: true });
    fs.writeFileSync(metaFile(slug), JSON.stringify({ ...readMeta(slug), [name]: { ...meta, at: new Date().toISOString() } }, null, 1));
  }

  function listArtifacts(slug: string): Artifact[] {
    const dir = artDir(slug);
    if (!fs.existsSync(dir)) return [];
    const meta = readMeta(slug);
    // an entry can vanish or be a dangling link between readdir and stat
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).flatMap((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st) return [];
      const isDir = st.isDirectory();
      const entry = isDir && fs.existsSync(path.join(full, 'index.html')) ? `${name}/index.html` : name;
      return { name, isDir, size: st.size, mtime: st.mtime.toISOString(), url: `/works/${slug}/artifacts/${entry}`, files: isDir ? fs.readdirSync(full).slice(0, 50) : [], ...(meta[name] ? { meta: meta[name] } : {}) };
    });
  }

  // lem-demo-video writes <name>.report.json next to <name>.mp4 (or in the imported folder)
  function blockedBeats(abs: string): NonNullable<ArtifactMeta['blocked']> {
    const dir = fs.statSync(abs).isDirectory();
    const report = dir ? fs.readdirSync(abs).find((f) => f.endsWith('.report.json')) : `${abs.replace(/(\.draft)?\.mp4$/, '')}.report.json`;
    const file = report && (dir ? path.join(abs, report) : report);
    try {
      const list = file ? JSON.parse(fs.readFileSync(file, 'utf8'))?.lint?.blocked : null;
      return Array.isArray(list) ? list.slice(0, 20).map((b) => ({ beat: String(b.beat ?? '').slice(0, 120), what: String(b.what ?? '').slice(0, 400), unblock: String(b.unblock ?? '').slice(0, 300) })) : [];
    } catch {
      return [];
    }
  }

  async function importArtifact(slug: string, src: string, label: string | undefined, { pr, kind, headSha }: ArtifactSource = {}) {
    const abs = path.resolve(src.replace(/^~/, HOME));
    if (!config.importRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) throw new Error(`source outside allowed roots: ${abs}`);
    if (!fs.existsSync(abs)) throw new Error(`not found: ${abs}`);
    fs.mkdirSync(artDir(slug), { recursive: true });
    const name = (label || path.basename(abs)).replace(/[^\w.-]+/g, '-');
    const dest = path.join(artDir(slug), name);
    fs.cpSync(abs, dest, { recursive: true });
    const sha = pr && !headSha && /^\d+$/.test(String(pr)) ? (await prInfo(Number(pr))).sha : headSha;
    const blocked = kind === 'video' ? blockedBeats(abs) : [];
    if (pr || kind) setArtifactMeta(slug, name, { pr: pr ? String(pr) : null, kind: kind && config.kitKinds.includes(kind) ? kind : null, headSha: sha || null, ...(blocked.length ? { blocked } : {}) });
    const work = get(slug);
    if (!work) throw new Error('no such work');
    work.timeline = work.timeline || [];
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'artifact', text: `imported ${name} from ${abs}${pr ? ` for #${pr}${sha ? ` at ${String(sha).slice(0, 10)}` : ''}` : ''}` });
    save(work, { what: 'artifacts' });
    return { name, dest, headSha: sha || null };
  }

  function personasForPaths(paths: string[]) {
    if (!fs.existsSync(PERSONAS)) return [];
    const out: { login: string; hits: number }[] = [];
    for (const f of fs.readdirSync(PERSONAS).filter((x) => x.endsWith('.md'))) {
      const globs = surfaceGlobs(fs.readFileSync(path.join(PERSONAS, f), 'utf8'));
      if (!globs.length) continue;
      const hits = paths.filter((p) => globs.some((g) => matchGlob(g, p)));
      if (hits.length) out.push({ login: f.replace(/\.md$/, ''), hits: hits.length });
    }
    return out.sort((a, b) => b.hits - a.hits);
  }
  const matchGlob = (glob: string, p: string) => globToRegExp(glob).test(p);

  const filesCache = swrCache<PrFile[]>(120000, cacheFile(DATA, 'pr-files'));
  const prFiles = (number: number): Promise<PrFile[]> =>
    filesCache(String(number), async () => {
      const r = await gh(['api', '--paginate', `repos/${GITHUB}/pulls/${number}/files?per_page=100`, '--jq', '.[] | {filename,additions,deletions,status}']);
      return r.ok ? r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    });
  const prBody = (number: number): Promise<string> => prNode(number).then((n) => n.body, () => '');
  const stackInfo = (work: Work, fresh?: boolean) => Promise.all((work.stack || []).map(async (s) => ({ ...(await prInfo(s.number, fresh)), key: rowKey(s), personas: s.personas || [] })));

  async function plan(work: Work) {
    const prs = await stackInfo(work);
    recordChanges(work.slug, prs);
    const extras = await Promise.all((work.stack || []).map(async (s) => ({ body: s.number ? await prBody(s.number) : '', files: s.number ? await prFiles(s.number) : [], personas: s.personas || [], planned: s.planned || null })));
    return prs.map((pr, i) => ({ ...pr, ...extras[i] }));
  }

  async function stackFiles(work: Work) {
    const prs = work.stack || [];
    if (!prs.length) return [];
    const results = await Promise.all(prs.filter((s) => s.number).map((s) => gh(['pr', 'diff', String(s.number), '--repo', GITHUB, '--name-only'])));
    return [...new Set(results.flatMap((r) => (r.ok ? r.stdout.split('\n').filter(Boolean) : [])))];
  }

  const SNAPS = path.join(ROOT, '.snapshots');
  fs.mkdirSync(SNAPS, { recursive: true });
  const snapFile = (slug: string) => path.join(SNAPS, `${slug}.json`);
  function recordChanges(slug: string, prs: PrInfo[]) {
    const prev: Record<string, Snapshot> = fs.existsSync(snapFile(slug)) ? JSON.parse(fs.readFileSync(snapFile(slug), 'utf8')) : {};
    const next: Record<string, Snapshot> = {};
    const events: string[] = [];
    for (const pr of prs) {
      if (pr.error || !pr.number) continue;
      const cur: Snapshot = { state: pr.state, isDraft: pr.isDraft, ci: pr.ci, reviewDecision: pr.reviewDecision, sha: pr.sha, reviewers: Object.fromEntries((pr.reviewers || []).map((r) => [r.login, r.state])) };
      next[pr.number] = cur;
      const old = prev[pr.number];
      if (!old) continue;
      if (old.state !== cur.state) events.push(`#${pr.number} ${cur.state?.toLowerCase()}${cur.state === 'MERGED' ? ' 🎉' : ''}`);
      if (old.isDraft && !cur.isDraft) events.push(`#${pr.number} marked ready for review`);
      if (!old.isDraft && cur.isDraft) events.push(`#${pr.number} back to draft`);
      if (old.sha !== cur.sha) events.push(`#${pr.number} new head ${cur.sha}`);
      if (old.ci !== cur.ci && cur.ci !== 'pending') events.push(`#${pr.number} CI ${cur.ci}`);
      for (const [login, st] of Object.entries(cur.reviewers)) if (old.reviewers?.[login] !== st && st !== 'COMMENTED') events.push(`#${pr.number} ${login} ${st.toLowerCase().replace('_', ' ')}`);
    }
    fs.writeFileSync(snapFile(slug), JSON.stringify(next));
    if (events.length) {
      const work = get(slug);
      if (!work) return events;
      work.timeline = work.timeline || [];
      for (const text of events.reverse()) work.timeline.unshift({ ts: new Date().toISOString(), kind: 'github', text });
      save(work);
    }
    return events;
  }

  const isDone = (work: Work, prs: PrInfo[]) => !(work.stack || []).some((s) => !s.number) && prs.length > 0 && prs.every((p) => p.state === 'MERGED' || p.state === 'CLOSED') && prs.some((p) => p.state === 'MERGED');

  function setArchived(slug: string, archived: boolean, reason: string) {
    const work = get(slug);
    if (!work) return null;
    work.timeline = work.timeline || [];
    if (archived) {
      work.archived = { at: new Date().toISOString(), reason };
      work.timeline.unshift({ ts: work.archived.at, kind: 'archive', text: reason === 'auto' ? 'archived: every PR merged or closed' : 'archived by hand' });
      for (const s of work.stack || []) if (s.number) hooks.onArchived?.(s.number);
    } else {
      delete work.archived;
      work.autoArchive = false;
      work.timeline.unshift({ ts: new Date().toISOString(), kind: 'archive', text: 'unarchived by hand; auto-archive off for this work' });
    }
    const saved = save(work);
    if (archived && reason === 'auto') hooks.onAutoArchived?.(saved);
    return saved;
  }

  async function sweepArchive() {
    for (const work of list()) {
      if (work.archived || work.autoArchive === false || !(work.stack || []).length) continue;
      const prs = await Promise.all(work.stack.map((s) => prInfo(s.number)));
      if (isDone(work, prs)) setArchived(work.slug, true, 'auto');
    }
  }

  async function detail(slug: string, fresh = false) {
    const work = get(slug);
    if (!work) return null;
    const prs = await stackInfo(work, fresh);
    const events = recordChanges(slug, prs);
    const artifacts = listArtifacts(slug);
    if (!work.archived && work.autoArchive !== false && isDone(work, prs)) setArchived(slug, true, 'auto');
    const current = (events.length || get(slug)?.archived !== work.archived ? get(slug) : work) ?? work;
    return { ...current, prs, artifacts, drift: (await hooks.drift?.(slug)) ?? null, notionStatus: notion.status({ ...current, artifacts }, prs), fetchedAt: new Date().toISOString() };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, a, b, c] = parts;
    const query = () => new URL(req.url ?? '', 'http://x').searchParams;
    if (!a) {
      if (req.method === 'POST') {
        const body: Partial<Work> = JSON.parse(await readBody(req));
        if (!body.slug || !body.title) return send(res, 400, { error: 'slug and title required' });
        if (get(body.slug)) return send(res, 409, { error: 'exists' });
        return send(res, 200, save({ stack: [], links: [], personas: [], notes: '', timeline: [{ ts: new Date().toISOString(), kind: 'created', text: 'work created' }], createdAt: new Date().toISOString(), ...body, slug: body.slug, title: body.title }));
      }
      return send(res, 200, list());
    }
    if (a === 'events' && req.method === 'GET') {
      const sink = sseSink(req, res);
      res.write(': open\n\n');
      return watch(sink);
    }
    const work = get(a);
    if (!work) return send(res, 404, { error: 'no such work' });
    if (b === 'artifacts' && req.method === 'POST') {
      const body: { path: string; label?: string } & ArtifactSource = JSON.parse(await readBody(req));
      try {
        return send(res, 200, await importArtifact(a, body.path, body.label, { pr: body.pr, kind: body.kind, headSha: body.headSha }));
      } catch (e) {
        return send(res, 400, { error: errorMessage(e) });
      }
    }
    if (b === 'personas-suggest') {
      const pr = query().get('pr');
      const files = pr ? (await prFiles(Number(pr))).map((f) => f.filename) : await stackFiles(work);
      return send(res, 200, { files: files.length, personas: personasForPaths(files) });
    }
    if (b === 'plan') return send(res, 200, { ...work, prs: await plan(work) });
    if (b === 'timeline' && req.method === 'POST') {
      const body: { kind?: string; text: string } = JSON.parse(await readBody(req));
      work.timeline = work.timeline || [];
      work.timeline.unshift({ ts: new Date().toISOString(), kind: body.kind || 'note', text: body.text });
      return send(res, 200, save(work));
    }
    if (b === 'decisions' && c && req.method === 'PUT') {
      const card = { ...JSON.parse(await readBody(req)), id: decodeURIComponent(c) };
      try {
        return send(res, 200, await upsertDecision(a, card));
      } catch (e) {
        return send(res, 400, { error: errorMessage(e) });
      }
    }
    if (b === 'decisions' && req.method === 'POST') {
      const body: DecideInput = JSON.parse(await readBody(req));
      const next = decide(a, body);
      return next ? send(res, 200, next) : send(res, 400, { error: 'unknown decision or option' });
    }
    if (b === 'archive' && req.method === 'POST') {
      const body: { archived?: boolean } = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, setArchived(a, body.archived !== false, 'manual'));
    }
    if (b === 'notion' && req.method === 'POST') {
      const body: NotionBody = JSON.parse((await readBody(req)) || '{}');
      if (body.action === 'link') return send(res, 200, notion.link(a, body.url ?? ''));
      if (body.action === 'unlink') return send(res, 200, notion.unlink(a));
      if (body.action === 'discard-preview') return send(res, 200, notion.discardPreview(a));
      return send(res, 200, await notion.sync(a, { force: Boolean(body.force), parentPageId: body.parentPageId || null, mode: body.mode || 'apply' }));
    }
    if (b === 'notion' && req.method === 'GET') return send(res, 200, notion.status({ ...work, artifacts: listArtifacts(a) }, await Promise.all((work.stack || []).map((s) => prInfo(s.number)))));
    if (req.method === 'PUT') {
      const body: Partial<Work> = JSON.parse(await readBody(req));
      try {
        if ('next' in body) body.next = validateNext(body.next);
      } catch (e) {
        return send(res, 400, { error: errorMessage(e) });
      }
      return send(res, 200, save({ ...work, ...body, slug: work.slug }));
    }
    if (req.method === 'DELETE') {
      // full=1: also its folder (threads, artifacts, findings) and what coco made for it in Paseo and git
      const full = query().get('full') === '1';
      const done = full ? await Promise.resolve(hooks.forgetWork?.(work)).catch((e) => [`cleanup failed: ${errorMessage(e)}`]) || [] : [];
      fs.rmSync(file(a));
      if (full) fs.rmSync(path.join(ROOT, a), { recursive: true, force: true });
      return send(res, 200, { ok: true, done: full ? [...done, 'work folder removed'] : [] });
    }
    // a refresh asked again within the floor serves what the last one fetched, with no job of its own
    const fresh = query().get('fresh') === '1' && Date.now() - (freshAt.get(a) || 0) >= GITHUB_MIN_FRESH_MS;
    if (fresh) freshAt.set(a, Date.now());
    if (fresh && jobs) return send(res, 200, await jobs.wrap({ work: a, action: 'github-refresh', label: 'GitHub refresh', kind: 'sync' }, () => detail(a, true)));
    return send(res, 200, await detail(a, fresh));
  }

  function serveArtifact(res: Res, urlPath: string, send: Send) {
    const rel = decodeURIComponent(urlPath.replace(/^\/works\//, ''));
    const [slug, ...rest] = rel.split('/');
    const base = artDir(slug);
    const full = path.resolve(base, rest.slice(1).join('/'));
    if (!full.startsWith(base) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  }

  // a review remark (watch point or comment verdict) goes to the notes under "## Review remarks" and to the timeline
  const remark = (slug: string, { n, where, verdict, text }: { n: number | string; where: string; verdict: string; text: string }) => {
    const work = get(slug);
    if (!work || !text?.trim()) return null;
    const line = `- ${keyLabel(n)} ${where} ${verdict}: ${text.trim()}`;
    const notes = (work.notes || '').trimEnd();
    work.notes = `${notes}${notes.includes('## Review remarks') ? '' : '\n\n## Review remarks'}\n${line}\n`;
    work.timeline = work.timeline || [];
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'review', text: `${keyLabel(n)} ${where} ${verdict}: ${text.trim()}` });
    return save(work);
  };

  // appends a bullet at the end of a "## heading" section, creating the section at the end when missing
  const appendUnder = (notes: string | undefined, heading: string, line: string) => {
    const lines = (notes || '').trimEnd().split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) return `${lines.join('\n')}\n\n${heading}\n${line}\n`;
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, line);
    return `${lines.join('\n')}\n`;
  };

  // a decision taken, reopened or archived on a work: the card state, a bullet under "## Decisions taken", a timeline entry
  const decide = (slug: string, { id, choice, rationale, status, archived }: DecideInput) => {
    const work = get(slug);
    const decision = (work?.decisions || []).find((d) => d.id === id);
    if (!work || !decision) return null;
    const ts = new Date().toISOString();
    work.timeline = work.timeline || [];
    if (typeof archived === 'boolean') {
      decision.archivedAt = archived ? ts : null;
      work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: ${archived ? 'archived' : 'unarchived'}` });
      return save(work);
    }
    if (status === 'pending') {
      Object.assign(decision, { status: 'pending', choice: null, rationale: '', decidedAt: null });
      work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: reopened` });
      return save(work);
    }
    if (!validChoice(decision, choice)) return null;
    Object.assign(decision, { status: 'taken', choice, rationale: (rationale || '').trim(), decidedAt: ts });
    work.notes = appendUnder(work.notes, '## Decisions taken', decisionBullet(decision));
    work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: ${decisionSummary(decision)}` });
    return save(work);
  };

  // one card added or updated by id; fields left out (e.g. the user's choice) stay as they are.
  // Typed blocks as on findings: `details` becomes their markdown twin, a suggestion's `before` is read at the card's `sha`.
  const upsertDecision = async (slug: string, input: Partial<Decision> & { id: string }) => {
    const work = get(slug);
    if (!work) throw new Error('no such work');
    work.decisions = work.decisions || [];
    const decision = work.decisions.find((d) => d.id === input.id);
    const card = { ...input, ...validateRich(input) };
    if (card.blocks) {
      const sha = card.sha || decision?.sha;
      if (sha) await readSuggestionBefore(card.blocks, (p) => run('git', ['-C', REPO, 'show', `${sha}:${p}`]).then((r) => (r.ok ? r.stdout.replace(/\n$/, '').split('\n') : null)));
      card.details = blocksToMarkdown({ summary: card.summary ?? decision?.summary, blocks: card.blocks, sources: card.sources ?? decision?.sources });
    }
    if (decision) Object.assign(decision, card);
    else work.decisions.push({ status: 'pending', ...card } as Decision);
    return save(work);
  };

  const dropPr = (number: number) => prCache.drop(String(number));
  return { paseo, handle, watch, watchWork, onChange, changed, dropPr, serveArtifact, list, get, save, remark, decide, upsertDecision, sweepArchive, personasForPaths, prInfo, prBody, listArtifacts, setArtifactMeta, hooks, notion };
}
