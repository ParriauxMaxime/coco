// Endpoints the Paseo plugins call: map a Paseo workspace to its work and PR, list a branch's stack in merge order, describe the cocopilot run an agent is on, link agents started by hand in a PR row workspace to that row and hand them its work brief on request, and, when an agent turn ends, settle its runs, read back its thread replies and refresh the refs of its work.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { keyLabel, parseKey, rowKey } from './stack.ts';
import type { Exec, PrInfo, ReadBody, Req, Res, RowKey, Send, StackRow, Work } from './core-types.ts';

const BRANCH_TTL_MS = 5 * 60 * 1000;
const RECENT_RUNS = 5;
const MAX_LINKS = 200;

type RunBase = { runId?: string; id?: string; status: string; agentId?: string | null; startedAt?: string; finishedAt?: string | null };
type Run = RunBase & { commentIds: string[] };
type StackRun = RunBase & { cwd?: string | null; rows: { key: RowKey; worktree?: string | null; commentIds: string[] }[] };
type TrackedComment = { id: string; status: string };
type Counts ={ total: number } & Record<string, number>;
type LinkWork = Work & { stack?: StackRow[] };
type RowRef = { work: LinkWork; key: RowKey };
type AgentLink = { agentId: string; slug: string; key: RowKey; workspaceId: string | null; title: string | null; linkedAt: string; briefAt: string | null };
type AgentInput = { agentId: string; workspaceId?: string | null; cwd?: string | null; title?: string | null };

type PaseoLinkOptions = {
  config?: { repo?: { github?: string } } | null;
  repoOf?: (work: Work | null | undefined) => { github: string };
  works: { list(): Work[]; prInfo?(n: number): Promise<PrInfo | null> };
  comments: { list(slug: string, key: RowKey): { comments?: TrackedComment[] }; follow(slug: string, key: RowKey, refs: { headSha: string }): Promise<unknown> };
  code: { ensureRefs(key: RowKey, opts?: { fresh?: boolean }): Promise<{ headSha: string }> };
  reviewAgent: { sameDir(a: string, b: string): boolean; list(slug: string, key: RowKey): Run[]; ingest(slug: string, key: RowKey): Promise<{ runs: Run[] }> };
  stackFix: { list(slug: string): StackRun[]; ingest(slug: string): Promise<{ runs: StackRun[] }> };
  threads?: { turnEnded(agentId: string): Promise<unknown> } | null;
  brief?: ((slug: string, key: RowKey) => Promise<string>) | null;
  file?: string | null;
  exec?: Exec;
  onArchived?: (agentId: string) => void;
  onTurnEnded?: (agentId: string) => void;
};

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const countBy = (items: { status: string }[]) => items.reduce<Record<string, number>>((acc, x) => ((acc[x.status] = (acc[x.status] || 0) + 1), acc), {});
const tally = (mine: { status: string }[]): Counts => ({ total: mine.length, ...countBy(mine) });
const pick = (stored: TrackedComment[] | undefined, ids: string[]) => (stored || []).filter((c) => ids.includes(c.id));

const readLinks = (file?: string | null): Record<string, AgentLink> => {
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

export function createPaseoLink({ config, repoOf = () => ({ github: config?.repo?.github || '' }), works, comments, code, reviewAgent, stackFix, threads, brief: briefFor, file, exec = defaultExec, onArchived, onTurnEnded }: PaseoLinkOptions) {
  const prByBranch = new Map<string, { at: number; number: number | null }>();
  const links = new Map(Object.entries(readLinks(file)));
  const activeWorks = (): LinkWork[] => works.list().filter((w) => !w.archived);
  const stackKeys = (work: LinkWork) => (work.stack || []).map(rowKey).filter((k): k is RowKey => Boolean(k));
  const persist = () => {
    if (file) fs.writeFileSync(file, JSON.stringify(Object.fromEntries(links), null, 1));
  };

  async function prIn(github: string, branch: string) {
    const cached = prByBranch.get(`${github} ${branch}`);
    if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.number;
    const r = await exec('gh', ['pr', 'list', '--repo', github, '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1']);
    const number: number | null = r.ok ? (JSON.parse(r.stdout || '[]')[0]?.number ?? null) : null;
    if (r.ok) prByBranch.set(`${github} ${branch}`, { at: Date.now(), number });
    return number;
  }
  // the PR of a branch in the first repo of the works (default repo first) that has one
  async function prForBranch(branch: string) {
    for (const github of new Set([repoOf(null).github, ...activeWorks().map((w) => repoOf(w).github)])) {
      const number = github ? await prIn(github, branch) : null;
      if (number) return { github, number };
    }
    return null;
  }
  const holdsPr = (pr: { github: string; number: number } | null) => (w: LinkWork) => Boolean(pr && repoOf(w).github === pr.github && (w.stack || []).some((s) => s.number === pr.number));

  const runView = (work: LinkWork, kind: string, pr: RowKey | null, run: RunBase, mine: { status: string }[]) => ({
    kind,
    slug: work.slug,
    title: work.title,
    pr,
    runId: run.runId || run.id,
    status: run.status,
    agentId: run.agentId || null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt || null,
    comments: tally(mine),
  });
  const reviewView = (work: LinkWork, n: RowKey, run: Run) => runView(work, 'review', n, run, pick(comments.list(work.slug, n).comments, run.commentIds));
  const stackView = (work: LinkWork, run: StackRun) =>
    runView(work, 'stack-fix', null, run, run.rows.flatMap((r) => pick(comments.list(work.slug, r.key).comments, r.commentIds)));
  const touches = (run: StackRun, cwd: string) => [run.cwd, ...run.rows.map((r) => r.worktree)].some((dir) => dir && reviewAgent.sameDir(dir, cwd));

  // the work row checked out in cwd: a PR row through `gh pr list --head`, else a local row on that branch
  async function rowAt(cwd?: string | null) {
    const active = activeWorks();
    const branchRun = cwd ? await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']) : { ok: false, stdout: '' };
    const branch = branchRun.ok ? branchRun.stdout.trim() : null;
    const pr = branch && branch !== 'HEAD' ? await prForBranch(branch) : null;
    const number = pr?.number ?? null;
    const byPr = pr ? active.find(holdsPr(pr)) : null;
    const localRow = (w: LinkWork) => (w.stack || []).find((s) => !s.number && branch && s.planned?.branch === branch);
    const byBranch = byPr ? null : active.find(localRow);
    return { branch, number, byPr, byBranch, localRow };
  }

  // the row whose Paseo workspace this is (remembered by placement), else the row checked out there
  const byWorkspace = (workspaceId?: string | null): RowRef | null => {
    if (!workspaceId) return null;
    for (const work of activeWorks()) {
      const key = rowKey((work.stack || []).find((s) => s.workspaceId === workspaceId));
      if (key) return { work, key };
    }
    return null;
  };
  const branchRow = ({ number, byPr, byBranch, localRow }: Awaited<ReturnType<typeof rowAt>>): RowRef | null => {
    if (byPr && number) return { work: byPr, key: number };
    const key = byBranch ? rowKey(localRow(byBranch)) : null;
    return byBranch && key ? { work: byBranch, key } : null;
  };
  const rowFor = async ({ workspaceId, cwd }: { workspaceId?: string | null; cwd?: string | null }) => byWorkspace(workspaceId) || branchRow(await rowAt(cwd));

  const linkView = (link: AgentLink) => ({ ...link, workTitle: works.list().find((w) => w.slug === link.slug)?.title || link.slug, label: keyLabel(link.key) });
  const briefedAt = ({ work, key }: RowRef) => [...links.values()].filter((l) => l.slug === work.slug && l.key === key && l.briefAt).map((l) => l.agentId);

  async function resolve({ cwd, projectId, workspaceId }: { cwd?: string | null; projectId?: string | null; workspaceId?: string | null }) {
    const at = await rowAt(cwd);
    const { branch, byPr, byBranch } = at;
    const row = byWorkspace(workspaceId) || branchRow(at);
    const work = row?.work || byPr || byBranch || (projectId ? activeWorks().find((w) => w.projectId === projectId) : null);
    if (!work) return { branch, work: null, pr: null, row: null, runs: [] };
    const key = row?.key ?? null;
    const runs = [
      ...(key ? reviewAgent.list(work.slug, key).slice(0, RECENT_RUNS).map((run) => reviewView(work, key, run)) : []),
      ...(cwd ? stackFix.list(work.slug).filter((run) => touches(run, cwd)).slice(0, RECENT_RUNS).map((run) => stackView(work, run)) : []),
    ].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return {
      branch,
      work: { slug: work.slug, title: work.title, stack: (work.stack || []).map((s) => s.number).filter(Boolean) },
      pr: typeof key === 'number' ? { number: key, comments: tally(comments.list(work.slug, key).comments || []) } : null,
      row: row ? { key: row.key, label: keyLabel(row.key), briefed: briefedAt(row) } : null,
      runs,
    };
  }

  async function linkAgent({ agentId, workspaceId, cwd, title }: AgentInput) {
    const row = await rowFor({ workspaceId, cwd });
    if (!row) return null;
    const kept = links.get(agentId);
    const same = kept?.slug === row.work.slug && kept.key === row.key;
    const link: AgentLink = {
      agentId,
      slug: row.work.slug,
      key: row.key,
      workspaceId: workspaceId || kept?.workspaceId || null,
      title: title || kept?.title || null,
      linkedAt: (same && kept?.linkedAt) || new Date().toISOString(),
      briefAt: (same && kept?.briefAt) || null,
    };
    links.delete(agentId);
    links.set(agentId, link);
    for (const id of [...links.keys()].slice(0, Math.max(0, links.size - MAX_LINKS))) links.delete(id);
    persist();
    return linkView(link);
  }

  // the brief text for the agent's row; the plugin sends it, then reports it sent
  async function brief(input: AgentInput) {
    if (!briefFor) return null;
    const link = await linkAgent(input);
    return link ? { ...link, text: await briefFor(link.slug, link.key) } : null;
  }

  function briefed(agentId: string) {
    const link = links.get(agentId);
    if (!link) return null;
    link.briefAt = new Date().toISOString();
    persist();
    return linkView(link);
  }

  function unlink(agentId: string) {
    if (!links.delete(agentId)) return false;
    persist();
    return true;
  }

  const linked = (slug?: string | null) => [...links.values()].filter((l) => !slug || l.slug === slug).reverse().map(linkView);

  // the rows of the work holding this branch, in merge order, each with its branch: the PR head, else the planned branch
  async function stack({ branch }: { branch: string }) {
    const pr = await prForBranch(branch);
    const holds = (s: StackRow) => (pr && s.number === pr.number) || s.planned?.branch === branch;
    const work = activeWorks().find(holdsPr(pr)) || activeWorks().find((w) => (w.stack || []).some((s) => s.planned?.branch === branch));
    if (!work) return { work: null, rows: [] };
    const headOf = async (s: StackRow) => (s.number ? (await works.prInfo?.(s.number))?.head : null) || s.planned?.branch || null;
    const rows = await Promise.all((work.stack || []).filter(rowKey).map(async (s) => ({ key: rowKey(s), branch: holds(s) ? branch : await headOf(s) })));
    return { work: { slug: work.slug, title: work.title }, rows };
  }

  function run({ kind, slug, runId, pr }: { kind?: string; slug: string; runId?: string; pr?: string | number | null }) {
    const work = activeWorks().find((w) => w.slug === slug);
    if (!work) return null;
    if (kind === 'stack-fix') {
      const found = stackFix.list(slug).find((r) => r.id === runId);
      return found ? stackView(work, found) : null;
    }
    const n = parseKey(String(pr || '').replaceAll('~', ':'));
    const found = n ? reviewAgent.list(slug, n).find((r) => r.runId === runId) : null;
    return n && found ? reviewView(work, n, found) : null;
  }

  // an agent may have committed, restacked or pushed any row: move every row's refs and re-anchor its comments
  const refreshing = new Map<string, Promise<unknown[]>>();
  function refreshWork(work: LinkWork) {
    const held = refreshing.get(work.slug);
    if (held) return held;
    const p = (async () => {
      const out: unknown[] = [];
      for (const key of stackKeys(work)) {
        try {
          const refs = await code.ensureRefs(key, { fresh: true });
          out.push({ key, headSha: refs.headSha, reanchored: await comments.follow(work.slug, key, refs) });
        } catch (e) {
          out.push({ key, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    })().finally(() => refreshing.delete(work.slug));
    refreshing.set(work.slug, p);
    return p;
  }

  async function turnEnded({ agentId, cwd }: { agentId: string; cwd?: string | null }) {
    if (cwd) {
      const { byPr, byBranch } = await rowAt(cwd);
      const work = byPr || byBranch;
      if (work) refreshWork(work).catch(() => {});
    }
    threads?.turnEnded(agentId).catch(() => {});
    onTurnEnded?.(agentId);
    const settled = [];
    const mine = (r: RunBase) => r.status === 'running' && r.agentId === agentId;
    for (const work of activeWorks()) {
      for (const n of stackKeys(work)) {
        const ids = reviewAgent.list(work.slug, n).filter(mine).map((r) => r.runId);
        if (!ids.length) continue;
        const { runs } = await reviewAgent.ingest(work.slug, n);
        for (const r of runs.filter((x) => ids.includes(x.runId))) settled.push(reviewView(work, n, r));
      }
      const stackIds = stackFix.list(work.slug).filter(mine).map((r) => r.id);
      if (!stackIds.length) continue;
      const { runs } = await stackFix.ingest(work.slug);
      for (const r of runs.filter((x) => stackIds.includes(x.id))) settled.push(stackView(work, r));
    }
    return { runs: settled };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, action] = parts;
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (action === 'resolve' && req.method === 'POST') return send(res, 200, await resolve(body));
      if (action === 'stack' && req.method === 'GET') {
        const branch = new URL(req.url || '/', 'http://local').searchParams.get('branch');
        if (!branch) return send(res, 400, { error: 'branch required' });
        return send(res, 200, await stack({ branch }));
      }
      if (action === 'run' && req.method === 'POST') return send(res, 200, { run: run(body) });
      if (action === 'agents' && req.method === 'GET') return send(res, 200, { agents: linked(new URL(req.url || '/', 'http://local').searchParams.get('work')) });
      const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null;
      const byAgent = ['turn-ended', 'agent', 'brief', 'briefed', 'unlink'];
      if (req.method !== 'POST' || !byAgent.includes(action)) return send(res, 404, { error: 'no route' });
      if (!agentId) return send(res, 400, { error: 'agentId required' });
      if (action === 'turn-ended') return send(res, 200, await turnEnded(body));
      if (action === 'agent') return send(res, 200, { link: await linkAgent(body) });
      if (action === 'briefed') return send(res, 200, { link: briefed(agentId) });
      if (action === 'unlink') {
        onArchived?.(agentId);
        return send(res, 200, { unlinked: unlink(agentId) });
      }
      const out = await brief(body);
      return out ? send(res, 200, out) : send(res, 404, { error: 'this workspace is not the workspace of a PR in a cocopilot work' });
    } catch (e) {
      return send(res, 500, { error: String(e instanceof Error ? e.message || e : e) });
    }
  }

  return { handle, resolve, stack, run, turnEnded, refreshWork, linkAgent, brief, briefed, unlink, linked };
}
