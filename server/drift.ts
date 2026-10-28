// Drift check: per work, what moved since the owner last looked, and the next steps that follow. Reads only, until the owner clicks an item's button.
// POST /api/works/<slug>/drift/run { id } runs a `run` action: the item is recomputed and the command rebuilt here, never taken from the page.
// Unpushed commits, kit pieces older than the head (kit.ts), a GitHub stack that differs from the work's, and two suggestions: update the body after a newer video, review a pushed head.
import { cacheFile, swrCache } from './swr.ts';
import { sameSha } from './kit.ts';
import { runSkill } from './gates.ts';
import { keyLabel, parseKey, rowKey } from './stack.ts';
import { conflictBody } from './jobs.ts';
import type { Jobs } from './jobs.ts';
import { gitWorktrees } from './worktrees.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Config } from './config.ts';
import type { Artifact, Comment, Exec, PrInfo, ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';
import type { Change } from './works.ts';

const TTL_MS = 30000;
const PUSH_MS = 600000;
const TAIL = 8000;
// more own commits than this asks for a history tidy
const TIDY_FROM = 5;
const BRANCH = /^[\w][\w./-]*$/;

export type DriftAction = { type: 'dispatch'; entry: string; label: string; persona?: string } | { type: 'copy'; command: string; label: string } | { type: 'run'; command: string; label: string } | { type: 'tab'; tab: string; label: string };
// what a `run` action does, kept as data: the command is built from it on the server
export type DriftRun = { type: 'push'; branch: string } | { type: 'base'; number: number; base: string };
export type DriftItem = { id: string; key: RowKey | null; kind: string; text: string; action: DriftAction | null; also?: DriftAction; run?: DriftRun };
// a PR's local branch tip against GitHub's head (remote: no local branch), and its own commits on top of its base
export type DriftHead = { key: RowKey; state: 'pushed' | 'ahead' | 'behind' | 'diverged' | 'remote'; count?: number; commits?: number };
export type Drift = { drift: DriftItem[]; next: DriftItem[]; heads: DriftHead[]; at: string };

type KitPiece = { id: string; label: string; state: string; expected?: boolean; madeFor: string | null; at: string | null; source: string | null };
type Rows = { key: RowKey; number: number | null; pr: PrInfo | null; branch: string | null; tip: string | null; personas: string[]; gates: Work['stack'][number]['gates'] };
type Deps = {
  config: Pick<Config, 'gateSkills' | 'kitKinds' | 'skillOverrides' | 'methodSkill'> & { repo: { path?: string; github?: string; defaultBranch?: string } };
  DATA?: string;
  works: { get(slug: string): Work | null; prInfo(n: number | null | undefined, fresh?: boolean): Promise<PrInfo>; listArtifacts?(slug: string): Artifact[]; changed?(slug: string, what?: Change): void; dropPr?(n: number): void };
  kit: { view(slug: string, key: string): Promise<{ pieces: KitPiece[] }> };
  reviewAgent: { exec: Exec; branchSha(branch: string): Promise<string | null>; worktreeFor?(branch: string): Promise<string | null> };
  comments: { list(slug: string, key: RowKey): { comments?: Pick<Comment, 'author' | 'sha'>[] } };
  reviewPlan: { planOf(slug: string, n: RowKey): { headSha?: string | null } | null | undefined };
  rowDir?(slug: string, key: RowKey): Promise<string | null>;  // the directory of the workspace remembered for a row
  jobs?: Pick<Jobs, 'start'>;
};

const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export function createDrift({ config, DATA, works, kit, reviewAgent, comments, reviewPlan, rowDir, jobs }: Deps) {
  const DEFAULT = config.repo.defaultBranch || 'main';
  const GH = config.repo.github || '';
  const cached = swrCache<Drift>(TTL_MS, cacheFile(DATA, 'drift'));
  const openPrs = swrCache<{ number: number; base: string; head: string }[]>(TTL_MS, cacheFile(DATA, 'open-prs'));
  const git = (args: string[]) => reviewAgent.exec('git', ['-C', config.repo.path || '.', ...args]);

  const listOpen = (): Promise<{ number: number; base: string; head: string }[]> =>
    openPrs('open', async () => {
      const r = await reviewAgent.exec('gh', ['pr', 'list', ...(GH ? ['--repo', GH] : []), '--state', 'open', '--limit', '100', '--json', 'number,baseRefName,headRefName']);
      try {
        return (JSON.parse(r.stdout) as { number: number; baseRefName: string; headRefName: string }[]).map((p) => ({ number: p.number, base: p.baseRefName, head: p.headRefName }));
      } catch {
        return [];
      }
    });

  const commits = async (range: string) => Number((await git(['rev-list', '--count', range])).stdout.trim()) || 0;
  async function headOf(tip: string | null, remote: string): Promise<Omit<DriftHead, 'key'>> {
    if (!tip) return { state: 'remote' };
    if (sameSha(tip, remote)) return { state: 'pushed' };
    if ((await git(['merge-base', '--is-ancestor', remote, tip])).ok) return { state: 'ahead', count: await commits(`${remote}..${tip}`) };
    if ((await git(['merge-base', '--is-ancestor', tip, remote])).ok) return { state: 'behind', count: await commits(`${tip}..${remote}`) };
    return { state: 'diverged' };
  }

  const skillEntry = (gate: string) => {
    const skill = runSkill(config, gate);
    return skill ? `gate:${gate}:${skill}` : null;
  };

  const shown = (r: DriftRun) => (r.type === 'push' ? `git push origin ${r.branch}` : `gh pr edit ${r.number}${GH ? ` --repo ${GH}` : ''} --base ${r.base}`);
  // never a force push: a diverged branch has no run
  const toRun = (r: DriftRun, label: string, copy: string): Pick<DriftItem, 'action' | 'also' | 'run'> => ({ action: { type: 'run', command: shown(r), label }, also: { type: 'copy', command: shown(r), label: copy }, run: r });

  async function compute(slug: string, fresh = false): Promise<Drift> {
    const work = works.get(slug);
    if (!work) throw Object.assign(new Error('no such work'), { status: 404 });
    const rows: Rows[] = await Promise.all((work.stack || []).map(async (s) => {
      const pr = s.number ? await works.prInfo(s.number, fresh) : null;
      const branch = pr?.head || s.planned?.branch || null;
      return { key: rowKey(s) as RowKey, number: s.number || null, pr, branch, tip: branch ? await reviewAgent.branchSha(branch) : null, personas: s.personas || [], gates: s.gates };
    }));
    const drift: DriftItem[] = [];
    const next: DriftItem[] = [];
    const heads: DriftHead[] = [];
    const add = (list: DriftItem[], key: RowKey | null, kind: string, text: string, action: DriftAction | null, more: Pick<DriftItem, 'also' | 'run'> = {}) => list.push({ id: `${key ?? 'work'}:${kind}`, key, kind, text, action, ...more });

    for (const r of rows.filter((x) => x.number && x.pr?.state === 'OPEN')) {
      const pr = r.pr as PrInfo;
      const remote = pr.headOid || null;
      const head = remote ? await headOf(r.tip, remote) : null;
      const own = pr.base && BRANCH.test(pr.base) ? await commits(`origin/${pr.base}..${r.tip || remote}`) : undefined;
      if (head) heads.push({ key: r.key, ...head, ...(own === undefined ? {} : { commits: own }) });
      const tidy = skillEntry('history');
      if (own && own > TIDY_FROM) add(drift, r.key, 'history', `${own} commits on top of ${pr.base}: tidy the history`, tidy ? { type: 'dispatch', entry: tidy, label: 'Tidy history' } : null);
      const count = head?.state === 'diverged' ? -1 : head?.state === 'ahead' ? head.count : 0;
      if (count) {
        const push = count > 0 && r.branch && BRANCH.test(r.branch) && !pr.isCrossRepository ? toRun({ type: 'push', branch: r.branch }, 'Push', 'Copy push') : null;
        const sync: DriftAction | null = count < 0 && r.branch ? { type: 'dispatch', entry: 'sync-remote', label: 'Rebase on GitHub' } : null;
        add(drift, r.key, 'unpushed', count > 0 ? `${count} local commit${count > 1 ? 's' : ''} not pushed` : 'local branch and GitHub diverged: rebase or reset it before pushing', push?.action ?? sync, push ? { also: push.also, run: push.run } : {});
      }

      const pieces = await kit.view(slug, String(r.key)).then((v) => v.pieces, () => []);
      // a companion PR in another repo (a link) only has dates, too weak to call it stale
      const stale = pieces.filter((p) => p.state === 'stale' && p.expected !== false && p.id !== 'notion' && !/^https?:/.test(p.source || ''));
      for (const p of stale) {
        const entry = skillEntry(`kit-${p.id}`);
        add(drift, r.key, `kit-${p.id}`, `${p.label} is older than the head${p.madeFor ? ` (made for ${p.madeFor.slice(0, 7)})` : ''}`, entry ? { type: 'dispatch', entry, label: p.id === 'body' ? 'Update PR body' : `Redo ${p.id}` } : { type: 'tab', tab: 'artifacts', label: 'Artifacts' });
      }
      // a piece in the kit scope not made yet, when a skill makes it
      for (const p of pieces.filter((x) => x.state === 'missing' && x.expected)) {
        const entry = skillEntry(`kit-${p.id}`);
        if (entry) add(next, r.key, `kit-${p.id}`, `${p.label} is in the kit scope and not made yet`, { type: 'dispatch', entry, label: `Make ${p.id}` });
      }

      const lastVideo = (works.listArtifacts?.(slug) || []).filter((a) => a.meta?.kind === 'video' && a.meta.pr === String(r.number)).sort((a, b) => (b.meta?.at ?? '').localeCompare(a.meta?.at ?? ''))[0];
      for (const [i, b] of (lastVideo?.meta?.blocked || []).entries()) add(drift, r.key, `video-blocked-${i}`, `Demo beat "${b.beat}" blocked: ${b.what}. Unblock: ${b.unblock}`, { type: 'tab', tab: 'artifacts', label: 'Artifacts' });

      // an imported video newer than the body: the body should show it
      const video = pieces.find((p) => p.id === 'video');
      const body = pieces.find((p) => p.id === 'body');
      const bodyEntry = skillEntry('kit-body');
      if (video?.at && video.source !== 'PR body' && body?.at && Date.parse(video.at) > Date.parse(body.at) && !stale.some((p) => p.id === 'body') && bodyEntry) add(next, r.key, 'body-after-video', `The demo video is newer than the PR body of ${keyLabel(r.key)}`, { type: 'dispatch', entry: bodyEntry, label: 'Update PR body' });

      // a pushed head with no persona review yet
      const done = ['done', 'skipped', 'running'].includes(r.gates?.['review-pr']?.state || '');
      const planned = sameSha(reviewPlan.planOf(slug, r.key)?.headSha, remote);
      const reviewed = (comments.list(slug, r.key).comments || []).some((c) => c.author?.startsWith('as-') && sameSha(c.sha, remote));
      const persona = r.personas[0] || work.personas?.[0];
      if (!count && !done && !planned && !reviewed && persona) add(next, r.key, 'persona-review', `${keyLabel(r.key)} is pushed and has no persona review at this head`, { type: 'dispatch', entry: 'persona-review', persona, label: `Persona review as ${persona}` });
    }

    // the GitHub base chain against the work's order: each open PR sits on the nearest open row below it, the first on the default branch
    const open = rows.filter((r) => r.number && r.pr?.state === 'OPEN');
    for (const [i, r] of open.entries()) {
      const below = open[i - 1];
      const want = below?.branch || DEFAULT;
      if (r.pr?.base && r.pr.base !== want) {
        const fix = r.number && BRANCH.test(want) ? toRun({ type: 'base', number: r.number, base: want }, 'Fix base', 'Copy base fix') : null;
        add(drift, r.key, 'stack', `GitHub bases ${keyLabel(r.key)} on ${r.pr.base}, the work stacks it on ${want}`, fix?.action ?? null, fix ? { also: fix.also, run: fix.run } : {});
      }
    }
    // a row's agents run in its remembered workspace: it must be the worktree on the PR's head branch (a branch is checked out in one worktree only, so two means a stale name)
    const withBranch = open.filter((r) => r.branch);
    const trees = rowDir && withBranch.length ? await gitWorktrees(reviewAgent.exec, config.repo.path || '.') : [];
    for (const r of rowDir ? withBranch : []) {
      const kept = await rowDir?.(slug, r.key);
      if (!kept) continue;
      const onHead = trees.find((t) => t.branch === r.branch);
      const keptTree = trees.find((t) => samePath(t.path, kept));
      if (onHead && !samePath(onHead.path, kept)) add(drift, r.key, 'worktrees', `two worktrees for ${keyLabel(r.key)}: ${kept}${keptTree?.branch ? ` (on ${keptTree.branch})` : ''}, ${onHead.path} (on ${r.branch})`, null);
      else if (!onHead && keptTree && keptTree.branch !== r.branch) add(drift, r.key, 'worktrees', `the worktree of ${keyLabel(r.key)}, ${kept}, is on ${keptTree.branch || 'no branch'}, not the PR head ${r.branch}`, null);
    }
    const mine = new Set(rows.map((r) => r.number));
    const byBranch = new Map(open.map((r) => [r.branch, r]));
    for (const p of open.length ? await listOpen().catch(() => []) : []) {
      const parent = byBranch.get(p.base);
      if (parent && !mine.has(p.number)) add(drift, p.number, 'stack-missing', `#${p.number} is stacked on ${keyLabel(parent.key)} on GitHub but not in this work`, { type: 'tab', tab: 'stack', label: 'Open stack' });
    }
    return { drift, next, heads, at: new Date().toISOString() };
  }

  const view = (slug: string, fresh = false) => cached(slug, () => compute(slug), fresh);

  const argvOf = async (r: DriftRun): Promise<[string, string[], Record<string, unknown>]> => {
    if (r.type === 'base') return ['gh', ['pr', 'edit', String(r.number), ...(GH ? ['--repo', GH] : []), '--base', r.base], {}];
    // in the branch's worktree when it has one, so the repo's pre-push hooks see that tree
    const cwd = (await reviewAgent.worktreeFor?.(r.branch)) || config.repo.path || '.';
    return ['git', ['-C', cwd, 'push', 'origin', r.branch], { timeout: PUSH_MS }];
  };
  const running = new Set<string>();

  // recompute the item now; run it only if it is still there with a run action, and `command` (what the page showed, required) still equals it
  async function runItem(slug: string, id: unknown, command: unknown) {
    if (typeof id !== 'string') throw new HttpError(400, 'id required');
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    if (work.archived) throw new HttpError(409, 'this work is archived: nothing was run');
    const at = `${slug}:${id}`;
    if (running.has(at)) throw new HttpError(409, 'already running');
    running.add(at);
    try {
      const item = (await cached(slug, () => compute(slug, true), true)).drift.find((i) => i.id === id);
      if (!item?.run || item.action?.type !== 'run') throw new HttpError(409, 'this item no longer applies: nothing was run');
      if (command !== item.action.command) throw new HttpError(409, `the item reads "${item.action.command}", not what was sent: nothing was run`);
      const [cmd, args, opts] = await argvOf(item.run);
      const r = await reviewAgent.exec(cmd, args, opts);
      if (r.ok) {
        cached.drop(slug);
        if (typeof item.key === 'number') works.dropPr?.(item.key);
        works.changed?.(slug, 'drift');
      }
      return { ok: r.ok, id, command: item.action.command, stdout: r.stdout.slice(-TAIL), stderr: r.stderr.slice(-TAIL) };
    } finally {
      running.delete(at);
    }
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      if (parts[3] === 'run') {
        if (req.method !== 'POST') throw new HttpError(405, 'POST only');
        let body: { id?: unknown; command?: unknown };
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        if (!jobs) return send(res, 200, await runItem(parts[1], body?.id, body?.command));
        return send(res, 200, { job: await enqueue(parts[1], body?.id, body?.command) });
      }
      const fresh = new URL(req.url ?? '', 'http://x').searchParams.get('fresh') === '1';
      return send(res, 200, await view(parts[1], fresh));
    } catch (e) {
      return send(res, httpStatus(e), conflictBody(e) ?? { error: errorMessage(e) });
    }
  }

  // a run as a command job: registered now, its output on the job; a failed command fails the job with its output tail
  async function enqueue(slug: string, id: unknown, command: unknown) {
    if (typeof id !== 'string' || !jobs) throw new HttpError(400, 'id required');
    const item = (await view(slug)).drift.find((i) => i.id === id);
    const pr = id.slice(0, id.lastIndexOf(':'));
    const label = `${item?.action?.label || 'Run'} ${pr === 'work' ? '' : keyLabel(parseKey(pr) ?? pr)}`.trim();
    return jobs.start({ work: slug, pr: pr === 'work' ? null : pr, action: `drift:${id}`, label, kind: 'command' }, async () => {
      const r = await runItem(slug, id, command);
      if (!r.ok) throw Object.assign(new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `${label} failed`), { output: `${r.stdout}\n${r.stderr}` });
      return { output: r.stdout };
    }).job;
  }

  return { handle, view, runItem, drop: (slug: string) => cached.drop(slug) };
}
