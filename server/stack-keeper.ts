// Stack keeper: once a parent PR merged, rebase its children off the old base (bottom-up), point their Paseo worktree baseRef and
// refs/cocopilot/base at the new base. Local git only: the force-with-lease push and the GitHub base change are the user's, shown to copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { keyLabel, rowKey } from './stack.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import type { Config } from './config.ts';
import type { Jobs } from './jobs.ts';
import type { PaseoAgentInfo, ReadBody, Req, Res, ReviewAgentApi, RowKey, Send, Work, Works } from './core-types.ts';

type KeepRow = { key: RowKey | null; number: number | null; state: string; branch: string | null; tip?: string | null; headOid?: string | null; worktree?: string | null; keptFor?: number | null; containsParent?: boolean };
type Onto = { ref: string | null; name: string | null; full: string };
type KeepStep = { key: RowKey | null; number: number | null; branch: string | null; worktree: string | null; tipBefore: string | null; upstream: string | null; onto: Onto; skip: string | null; commands: string[]; push: string; ghBase: string | null };
type KeepResult = { key: RowKey | null; branch: string | null; skipped?: string; error?: string; conflict?: string[]; tipBefore?: string | null; tipAfter?: string; worktreeJson?: boolean; push?: string; ghBase?: string | null };

// rows in stack order → the children to rebase, bottom-up
export function keepPlan(rows: KeepRow[], { github = '', branch = 'main' } = {}): { parent: Pick<KeepRow, 'key' | 'number' | 'branch' | 'headOid'> | null; steps: KeepStep[] } {
  const first = rows.findIndex((r, i) => i > 0 && r.state !== 'MERGED' && r.state !== 'CLOSED' && rows[i - 1].state === 'MERGED' && r.keptFor !== rows[i - 1].number);
  if (first < 0) return { parent: null, steps: [] };
  const parent = rows[first - 1];
  const steps: KeepStep[] = [];
  for (const r of rows.slice(first)) {
    if (r.state === 'MERGED' || r.state === 'CLOSED') break;
    const prev = steps.at(-1);
    const onto: Onto = prev ? { ref: prev.branch, name: prev.branch, full: `refs/heads/${prev.branch}` } :{ ref: `origin/${branch}`, name: branch, full: `refs/remotes/origin/${branch}` };
    const upstream = prev ? prev.tipBefore : (parent.headOid ?? null);
    const skip = !prev && !r.containsParent ? `${r.branch} does not contain the merged head of #${parent.number}: already rebased` : !r.tip ? `branch ${r.branch} not found locally` : null;
    const where = r.worktree ? `git -C ${r.worktree}` : 'git';
    steps.push({
      key: r.key,
      number: r.number,
      branch: r.branch,
      worktree: r.worktree ?? null,
      tipBefore: r.tip ?? null,
      upstream,
      onto,
      skip,
      commands: [...(prev ? [] : [`${where} fetch origin ${branch}`]), `${where} rebase --onto ${onto.ref} ${upstream} ${r.branch}`],
      push: `git push --force-with-lease origin ${r.branch}`,
      ghBase: !prev && r.number ? `gh pr edit ${r.number}${github ? ` --repo ${github}` : ''} --base ${branch}` : null,
    });
    if (skip) break;
  }
  return { parent: { key: parent.key, number: parent.number, branch: parent.branch, headOid: parent.headOid }, steps };
}

type Deps = {
  REPO: string;
  config: { repo: { github: string; defaultBranch?: string } };
  works: Pick<Works, 'get' | 'save' | 'prInfo'>;
  reviewAgent: Pick<ReviewAgentApi, 'exec' | 'timeline' | 'worktreeFor' | 'branchSha' | 'sameDir' | 'agentsList'>;
  jobs?: Pick<Jobs, 'wrap'>;
};

export function createStackKeeper({ REPO, config, works, reviewAgent, jobs }: Deps) {
  const opts = { github: config.repo.github, branch: config.repo.defaultBranch || 'main' };
  const BASE = `origin/${opts.branch}`;
  const exec = (cmd: string, args: string[]) => reviewAgent.exec(cmd, args);
  const git = (cwd: string, args: string[]) => exec('git', ['-C', cwd, ...args]);
  const out = (r: { ok: boolean; stdout: string }) => (r.ok ? r.stdout.trim() : '');

  async function rows(work: Work): Promise<KeepRow[]> {
    return Promise.all((work.stack || []).map(async (s) => {
      const key = rowKey(s);
      const pr = s.number ? await works.prInfo(s.number) : null;
      const branch = pr?.head || s.planned?.branch || null;
      const headOid = pr?.state === 'MERGED' ? pr.headOid || null : null;
      const [tip, worktree] = branch ? await Promise.all([reviewAgent.branchSha(branch), reviewAgent.worktreeFor(branch)]) : [null, null];
      return { key, number: s.number || null, state: pr?.state || 'LOCAL', branch, tip, headOid, worktree, keptFor: s.keeper?.parent ?? null };
    }));
  }

  async function plan(slug: string) {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    if (!REPO) throw new HttpError(503, 'no repo configured (repo.path)');
    const all = await rows(work);
    const first = keepPlan(all, opts);
    if (first.parent) {
      const child = all.find((r) => r.key === first.steps[0].key);
      if (child) child.containsParent = Boolean(first.parent.headOid && child.tip && (await git(REPO, ['merge-base', '--is-ancestor', first.parent.headOid, child.tip])).ok);
    }
    return keepPlan(all, opts);
  }

  // the Paseo CLI cannot change a worktree's base, so its private <gitdir>/paseo/worktree.json is edited in place
  const movePaseoBase = (worktree: string | null, onto: Onto) => {
    const pointer = worktree && fs.existsSync(path.join(worktree, '.git')) ? fs.readFileSync(path.join(worktree, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1] : null;
    const file = pointer && path.join(pointer.trim(), 'paseo', 'worktree.json');
    if (!file || !fs.existsSync(file)) return false;
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), baseRefName: onto.name, baseRef: onto.full }, null, 2));
    return true;
  };

  async function busy(step: KeepStep, agents: PaseoAgentInfo[]) {
    const { worktree } = step;
    if (!worktree) return null;
    const st = await git(worktree, ['status', '--porcelain', '--untracked-files=no']);
    if (st.ok && st.stdout.trim()) return `${worktree} has uncommitted changes`;
    const agent = agents.find((a) => a.cwd && a.status === 'running' && reviewAgent.sameDir(a.cwd, worktree));
    return agent ? `agent ${agent.id.slice(0, 8)} is mid-turn in ${worktree}` : null;
  }

  // rebases in order; a conflict aborts that rebase and stops the run with the conflicting files
  async function apply(slug: string) {
    const { parent, steps } = await plan(slug);
    if (!parent) throw new HttpError(400, 'nothing to keep: no open child of a merged PR');
    if (steps[0].skip) throw new HttpError(409, steps[0].skip);
    const agents = await reviewAgent.agentsList();
    for (const s of steps) {
      const why = await busy(s, agents);
      if (why) throw new HttpError(409, why);
    }
    const fetched = await git(REPO, ['fetch', '--no-tags', 'origin', opts.branch]);
    if (!fetched.ok) throw new HttpError(500, `git fetch origin ${opts.branch}: ${fetched.stderr.slice(0, 200)}`);
    const results: KeepResult[] = [];
    let prev: { tipBefore: string | null; tipAfter: string } | null = null;
    for (const s of steps) {
      if (s.skip || !s.branch) {
        results.push({ key: s.key, branch: s.branch, skipped: s.skip ?? 'no branch' });
        break;
      }
      const cwd = s.worktree || path.join(os.tmpdir(), `cc-keep-${crypto.randomBytes(3).toString('hex')}`);
      const temp = s.worktree ? null : cwd;
      if (temp && !(await git(REPO, ['worktree', 'add', temp, s.branch])).ok) {
        results.push({ key: s.key, branch: s.branch, error: `cannot check out ${s.branch}` });
        break;
      }
      try {
        const onto = prev ? prev.tipAfter : out(await git(REPO, ['rev-parse', BASE]));
        const upstream = prev ? prev.tipBefore : s.upstream;
        if (!upstream) throw new HttpError(500, `no upstream sha to rebase ${s.branch} from`);
        const r = await git(cwd, ['rebase', '--onto', onto, upstream, s.branch]);
        if (!r.ok) {
          const files = out(await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
          await git(cwd, ['rebase', '--abort']);
          results.push({ key: s.key, branch: s.branch, conflict: files.length ? files : [r.stderr.slice(0, 300)] });
          break;
        }
        const tipAfter = out(await git(cwd, ['rev-parse', 'HEAD']));
        const moved = movePaseoBase(s.worktree, s.onto);
        if (s.number) await git(REPO, ['update-ref', `refs/cocopilot/base/${s.number}`, onto]);
        prev = { tipBefore: s.tipBefore, tipAfter };
        results.push({ key: s.key, branch: s.branch, tipBefore: s.tipBefore, tipAfter, worktreeJson: moved, push: s.push, ghBase: s.ghBase });
      } finally {
        if (temp) await git(REPO, ['worktree', 'remove', '--force', temp]);
      }
    }
    const done = results.flatMap((r) => (r.tipAfter ? [{ ...r, tipAfter: r.tipAfter }] : []));
    if (done.length) mark(slug, parent.number, done.map((r) => r.key));
    const stopped = results.find((r) => r.conflict || r.error);
    reviewAgent.timeline(slug, 'stack', `stack keeper after #${parent.number} merged: ${done.map((r) => `${keyLabel(r.key)} → ${r.tipAfter.slice(0, 10)}`).join(', ') || 'nothing rebased'}${stopped ? `; stopped at ${stopped.branch}: ${(stopped.conflict || [stopped.error]).join(', ')}` : ''}`);
    return { parent, results };
  }

  // the keeper marker hides the badge: set by apply, or by hand when the user restacked themselves
  function mark(slug: string, parentNumber: number | null | undefined, keys: (RowKey | null)[]) {
    const w = works.get(slug);
    if (!w) return;
    w.stack = w.stack.map((s) => (keys.includes(rowKey(s)) ? { ...s, keeper: { parent: parentNumber, at: new Date().toISOString() } } : s));
    works.save(w);
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , action] = parts;
      if (req.method === 'GET') return send(res, 200, await plan(slug));
      if (req.method === 'POST' && action === 'apply') return send(res, 200, jobs ? await jobs.wrap({ work: slug, action: 'restack', label: 'Restack', kind: 'command' }, () => apply(slug)) : await apply(slug));
      if (req.method === 'POST' && action === 'dismiss') {
        const { parent, steps } = await plan(slug);
        if (parent) {
          mark(slug, parent.number, steps.map((s) => s.key));
          reviewAgent.timeline(slug, 'stack', `stack keeper after #${parent.number}: marked as restacked by hand (${steps.map((s) => keyLabel(s.key)).join(', ')})`);
        }
        return send(res, 200, await plan(slug));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, plan };
}

// sidebar badge without a gh call: a row right after a PR the last snapshot saw merged, not kept yet
export const needsKeeping = (work: Pick<Work, 'stack'>, snap: Record<number, { state?: string } | undefined>) => (work.stack || []).some((s, i) => i > 0 && s.number && snap[s.number]?.state === 'OPEN' && snap[work.stack[i - 1].number ?? 0]?.state === 'MERGED' && s.keeper?.parent !== work.stack[i - 1].number);
