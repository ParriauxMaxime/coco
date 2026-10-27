// Drift check: per work, what moved since the owner last looked, and the next steps that follow. Read only: every item carries an action the owner clicks.
// Unpushed commits, kit pieces older than the head (kit.ts), a GitHub stack that differs from the work's, and two suggestions: update the body after a newer video, review a pushed head.
import { cacheFile, swrCache } from './swr.ts';
import { sameSha } from './kit.ts';
import { gatesFor, skillName } from './gates.ts';
import { keyLabel, rowKey } from './stack.ts';
import { errorMessage, httpStatus } from './core-types.ts';
import type { Config } from './config.ts';
import type { Comment, Exec, PrInfo, ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';

const TTL_MS = 30000;

export type DriftAction = { type: 'dispatch'; entry: string; label: string; persona?: string } | { type: 'copy'; command: string; label: string } | { type: 'tab'; tab: string; label: string };
export type DriftItem = { id: string; key: RowKey | null; kind: string; text: string; action: DriftAction | null };
export type Drift = { drift: DriftItem[]; next: DriftItem[]; at: string };

type KitPiece = { id: string; label: string; state: string; madeFor: string | null; at: string | null; source: string | null };
type Rows = { key: RowKey; number: number | null; pr: PrInfo | null; branch: string | null; tip: string | null; personas: string[]; gates: Work['stack'][number]['gates'] };
type Deps = {
  config: Pick<Config, 'gateSkills' | 'kitKinds' | 'skillOverrides' | 'methodSkill'> & { repo: { path?: string; github?: string; defaultBranch?: string } };
  DATA?: string;
  works: { get(slug: string): Work | null; prInfo(n: number | null | undefined): Promise<PrInfo> };
  kit: { view(slug: string, key: string): Promise<{ pieces: KitPiece[] }> };
  reviewAgent: { exec: Exec; branchSha(branch: string): Promise<string | null> };
  comments: { list(slug: string, key: RowKey): { comments?: Pick<Comment, 'author' | 'sha'>[] } };
  reviewPlan: { planOf(slug: string, n: RowKey): { headSha?: string | null } | null | undefined };
};

export function createDrift({ config, DATA, works, kit, reviewAgent, comments, reviewPlan }: Deps) {
  const GATES = gatesFor(config);
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

  // local commits on top of GitHub's head; null when GitHub is level or ahead
  async function ahead(tip: string, remote: string) {
    if (sameSha(tip, remote)) return null;
    if ((await git(['merge-base', '--is-ancestor', remote, tip])).ok) return Number((await git(['rev-list', '--count', `${remote}..${tip}`])).stdout.trim()) || 0;
    return (await git(['merge-base', '--is-ancestor', tip, remote])).ok ? null : -1;
  }

  const skillEntry = (gate: string) => {
    const skill = skillName(GATES.find((g) => g.id === gate)?.skills?.[0]);
    return skill ? `gate:${gate}:${skill}` : null;
  };

  async function compute(slug: string): Promise<Drift> {
    const work = works.get(slug);
    if (!work) throw Object.assign(new Error('no such work'), { status: 404 });
    const rows: Rows[] = await Promise.all((work.stack || []).map(async (s) => {
      const pr = s.number ? await works.prInfo(s.number) : null;
      const branch = pr?.head || s.planned?.branch || null;
      return { key: rowKey(s) as RowKey, number: s.number || null, pr, branch, tip: branch ? await reviewAgent.branchSha(branch) : null, personas: s.personas || [], gates: s.gates };
    }));
    const drift: DriftItem[] = [];
    const next: DriftItem[] = [];
    const add = (list: DriftItem[], key: RowKey | null, kind: string, text: string, action: DriftAction | null) => list.push({ id: `${key ?? 'work'}:${kind}`, key, kind, text, action });

    for (const r of rows.filter((x) => x.number && x.pr?.state === 'OPEN')) {
      const pr = r.pr as PrInfo;
      const remote = pr.headOid || null;
      const count = r.tip && remote ? await ahead(r.tip, remote) : null;
      if (count) add(drift, r.key, 'unpushed', count > 0 ? `${count} local commit${count > 1 ? 's' : ''} not pushed` : 'local branch differs from GitHub (rebased?)', { type: 'copy', command: `git push ${count > 0 ? '' : '--force-with-lease '}origin ${r.branch}`, label: 'Copy push' });

      const pieces = await kit.view(slug, String(r.key)).then((v) => v.pieces, () => []);
      // a companion PR in another repo (a link) only has dates, too weak to call it stale
      const stale = pieces.filter((p) => p.state === 'stale' && p.id !== 'notion' && !/^https?:/.test(p.source || ''));
      for (const p of stale) {
        const entry = skillEntry(`kit-${p.id}`);
        add(drift, r.key, `kit-${p.id}`, `${p.label} is older than the head${p.madeFor ? ` (made for ${p.madeFor.slice(0, 7)})` : ''}`, entry ? { type: 'dispatch', entry, label: p.id === 'body' ? 'Update PR body' : `Redo ${p.id}` } : { type: 'tab', tab: 'artifacts', label: 'Artifacts' });
      }

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
      if (r.pr?.base && r.pr.base !== want) add(drift, r.key, 'stack', `GitHub bases ${keyLabel(r.key)} on ${r.pr.base}, the work stacks it on ${want}`, { type: 'copy', command: `gh pr edit ${r.number}${GH ? ` --repo ${GH}` : ''} --base ${want}`, label: 'Copy base fix' });
    }
    const mine = new Set(rows.map((r) => r.number));
    const heads = new Map(open.map((r) => [r.branch, r]));
    for (const p of open.length ? await listOpen().catch(() => []) : []) {
      const parent = heads.get(p.base);
      if (parent && !mine.has(p.number)) add(drift, p.number, 'stack-missing', `#${p.number} is stacked on ${keyLabel(parent.key)} on GitHub but not in this work`, { type: 'tab', tab: 'stack', label: 'Open stack' });
    }
    return { drift, next, at: new Date().toISOString() };
  }

  const view = (slug: string, fresh = false) => cached(slug, () => compute(slug), fresh);

  async function handle(_req: Req, res: Res, parts: string[], _readBody: ReadBody, send: Send) {
    try {
      const fresh = new URL(_req.url ?? '', 'http://x').searchParams.get('fresh') === '1';
      return send(res, 200, await view(parts[1], fresh));
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, view };
}
