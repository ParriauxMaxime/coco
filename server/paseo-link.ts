// Endpoints the Paseo plugins call: map a Paseo workspace to its work and PR, list a branch's stack in merge order, describe the cocopilot run an agent is on, and, when an agent turn ends, settle its runs, read back its thread replies and refresh the refs of its work.
import { execFile } from 'node:child_process';
import { parseKey, rowKey } from './stack.ts';

const BRANCH_TTL_MS = 5 * 60 * 1000;
const RECENT_RUNS = 5;

const defaultExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const countBy = (items, key) => items.reduce((acc, x) => ((acc[x[key]] = (acc[x[key]] || 0) + 1), acc), {});
const tally = (mine) => ({ total: mine.length, ...countBy(mine, 'status') });
const pick = (stored, ids) => (stored || []).filter((c) => ids.includes(c.id));

export function createPaseoLink({ config, works, comments, code, reviewAgent, stackFix, threads, exec = defaultExec }) {
  const GITHUB = config?.repo?.github || '';
  const prByBranch = new Map();
  const activeWorks = () => works.list().filter((w) => !w.archived);
  const stackKeys = (work) => (work.stack || []).map(rowKey).filter(Boolean);

  async function prForBranch(branch) {
    const cached = prByBranch.get(branch);
    if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return cached.number;
    if (!GITHUB) return null;
    const r = await exec('gh', ['pr', 'list', '--repo', GITHUB, '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1']);
    const number = r.ok ? (JSON.parse(r.stdout || '[]')[0]?.number ?? null) : null;
    if (r.ok) prByBranch.set(branch, { at: Date.now(), number });
    return number;
  }

  const runView = (work, kind, pr, run, mine) => ({
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
  const reviewView = (work, n, run) => runView(work, 'review', n, run, pick(comments.list(work.slug, n).comments, run.commentIds));
  const stackView = (work, run) =>
    runView(work, 'stack-fix', null, run, run.rows.flatMap((r) => pick(comments.list(work.slug, r.key).comments, r.commentIds)));
  const touches = (run, cwd) => [run.cwd, ...run.rows.map((r) => r.worktree)].some((dir) => dir && reviewAgent.sameDir(dir, cwd));

  // the work row checked out in cwd: a PR row through `gh pr list --head`, else a local row on that branch
  async function rowAt(cwd) {
    const active = activeWorks();
    const branchRun = cwd ? await exec('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']) : { ok: false };
    const branch = branchRun.ok ? branchRun.stdout.trim() : null;
    const number = branch && branch !== 'HEAD' ? await prForBranch(branch) : null;
    const byPr = number ? active.find((w) => (w.stack || []).some((s) => s.number === number)) : null;
    const localRow = (w) => (w.stack || []).find((s) => !s.number && branch && s.planned?.branch === branch);
    const byBranch = byPr ? null : active.find(localRow);
    return { branch, number, byPr, byBranch, localRow };
  }

  async function resolve({ cwd, projectId }) {
    const { branch, number, byPr, byBranch, localRow } = await rowAt(cwd);
    const work = byPr || byBranch || (projectId ? activeWorks().find((w) => w.projectId === projectId) : null);
    if (!work) return { branch, work: null, pr: null, runs: [] };
    const key = byPr ? number : byBranch ? rowKey(localRow(byBranch)) : null;
    const runs = [
      ...(key ? reviewAgent.list(work.slug, key).slice(0, RECENT_RUNS).map((run) => reviewView(work, key, run)) : []),
      ...(cwd ? stackFix.list(work.slug).filter((run) => touches(run, cwd)).slice(0, RECENT_RUNS).map((run) => stackView(work, run)) : []),
    ].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return {
      branch,
      work: { slug: work.slug, title: work.title, stack: (work.stack || []).map((s) => s.number).filter(Boolean) },
      pr: byPr ? { number, comments: tally(comments.list(work.slug, number).comments || []) } : null,
      runs,
    };
  }

  // the rows of the work holding this branch, in merge order, each with its branch: the PR head, else the planned branch
  async function stack({ branch }) {
    const number = await prForBranch(branch);
    const holds = (s) => (number && s.number === number) || s.planned?.branch === branch;
    const work = activeWorks().find((w) => (w.stack || []).some(holds));
    if (!work) return { work: null, rows: [] };
    const headOf = async (s) => (s.number ? (await works.prInfo?.(s.number))?.head : null) || s.planned?.branch || null;
    const rows = await Promise.all((work.stack || []).filter(rowKey).map(async (s) => ({ key: rowKey(s), branch: holds(s) ? branch : await headOf(s) })));
    return { work: { slug: work.slug, title: work.title }, rows };
  }

  function run({ kind, slug, runId, pr }) {
    const work = activeWorks().find((w) => w.slug === slug);
    if (!work) return null;
    if (kind === 'stack-fix') {
      const found = stackFix.list(slug).find((r) => r.id === runId);
      return found ? stackView(work, found) : null;
    }
    const n = parseKey(String(pr || '').replaceAll('~', ':'));
    const found = n ? reviewAgent.list(slug, n).find((r) => r.runId === runId) : null;
    return found ? reviewView(work, n, found) : null;
  }

  // an agent may have committed, restacked or pushed any row: move every row's refs and re-anchor its comments
  const refreshing = new Map();
  function refreshWork(work) {
    if (refreshing.has(work.slug)) return refreshing.get(work.slug);
    const p = (async () => {
      const out = [];
      for (const key of stackKeys(work)) {
        try {
          const refs = await code.ensureRefs(key, { fresh: true });
          out.push({ key, headSha: refs.headSha, reanchored: await comments.follow(work.slug, key, refs) });
        } catch (e) {
          out.push({ key, error: e.message });
        }
      }
      return out;
    })().finally(() => refreshing.delete(work.slug));
    refreshing.set(work.slug, p);
    return p;
  }

  async function turnEnded({ agentId, cwd }) {
    if (cwd) {
      const { byPr, byBranch } = await rowAt(cwd);
      const work = byPr || byBranch;
      if (work) refreshWork(work).catch(() => {});
    }
    threads?.turnEnded(agentId).catch(() => {});
    const settled = [];
    const mine = (r) => r.status === 'running' && r.agentId === agentId;
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

  async function handle(req, res, parts, readBody, send) {
    try {
      const [, action] = parts;
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (action === 'resolve' && req.method === 'POST') return send(res, 200, await resolve(body));
      if (action === 'stack' && req.method === 'GET') {
        const branch = new URL(req.url, 'http://local').searchParams.get('branch');
        if (!branch) return send(res, 400, { error: 'branch required' });
        return send(res, 200, await stack({ branch }));
      }
      if (action === 'run' && req.method === 'POST') return send(res, 200, { run: run(body) });
      if (action === 'turn-ended' && req.method === 'POST') {
        if (typeof body.agentId !== 'string' || !body.agentId) return send(res, 400, { error: 'agentId required' });
        return send(res, 200, await turnEnded(body));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  return { handle, resolve, stack, run, turnEnded, refreshWork };
}
