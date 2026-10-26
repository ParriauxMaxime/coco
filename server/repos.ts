// Repos hold works: which repo a work belongs to, and the order the sidebar shows repos and works in.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

type BranchExists = (repo: RepoConfig, branch: string) => Promise<boolean>;
export type Layout = { repos: string[]; works: Record<string, string[]> };

const gitBranchExists: BranchExists = (repo, branch) =>
  new Promise((resolve) => {
    if (!repo.path) return resolve(false);
    execFile('git', ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], (err) => (err ? execFile('git', ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], (e2) => resolve(!e2)) : resolve(true)));
  });

// a GitHub link of the work names its repo; else the repo whose clone has one of its planned branches; else the default repo
export async function guessRepo(work: Pick<Work, 'links' | 'stack'>, repos: RepoConfig[], branchExists: BranchExists = gitBranchExists): Promise<string> {
  for (const l of work.links || []) {
    const m = /github\.com\/([^/]+\/[^/#?]+)/.exec(l.url || '');
    const hit = m && repos.find((r) => r.github && r.github.toLowerCase() === m[1].replace(/\.git$/, '').toLowerCase());
    if (hit) return hit.id;
  }
  const branches = (work.stack || []).map((s) => s.planned?.branch).filter((b): b is string => Boolean(b));
  for (const repo of repos) {
    for (const b of branches) if (await branchExists(repo, b)) return repo.id;
  }
  return repos[0].id;
}

export function createRepos({ DATA, repos }: { DATA: string; repos: RepoConfig[] }) {
  const layoutFile = path.join(DATA, 'layout.json');
  const byId = (id: string | null | undefined) => repos.find((r) => r.id === id) || null;
  const repoFor = (work: Pick<Work, 'repo'> | null | undefined) => byId(work?.repo) || repos[0];

  // gives every work without a repo its repo; returns what it would write, and writes it unless dryRun
  async function assign(works: Work[], save: (w: Work) => unknown, { dryRun = false, branchExists }: { dryRun?: boolean; branchExists?: BranchExists } = {}) {
    const changes: { slug: string; repo: string }[] = [];
    for (const w of works) {
      if (w.repo && byId(w.repo)) continue;
      const repo = await guessRepo(w, repos, branchExists);
      changes.push({ slug: w.slug, repo });
      if (!dryRun) save({ ...w, repo });
    }
    return changes;
  }

  const readLayout = (): Layout => {
    try {
      const l = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
      return { repos: Array.isArray(l.repos) ? l.repos : [], works: l.works && typeof l.works === 'object' ? l.works : {} };
    } catch {
      return { repos: [], works: {} };
    }
  };
  const writeLayout = (l: Layout) => fs.writeFileSync(layoutFile, JSON.stringify(l, null, 1));

  // ids in the saved order first, the rest in the order they come
  const ordered = <T>(items: T[], key: (x: T) => string, order: string[]) => {
    const rank = new Map(order.map((k, i) => [k, i]));
    return [...items].sort((a, b) => (rank.get(key(a)) ?? Infinity) - (rank.get(key(b)) ?? Infinity));
  };

  // repos in the sidebar's order, each with its works in theirs (works arrive most recently updated first)
  function grouped<W extends { slug: string; repo?: string }>(works: W[]) {
    const layout = readLayout();
    return ordered(repos, (r) => r.id, layout.repos).map((r) => ({
      id: r.id,
      name: r.name,
      github: r.github,
      works: ordered(works.filter((w) => repoFor(w).id === r.id), (w) => w.slug, layout.works[r.id] || []),
    }));
  }

  function saveOrder(body: { repos?: unknown; repo?: unknown; works?: unknown }) {
    const layout = readLayout();
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
    const repoOrder = strings(body.repos);
    if (repoOrder) layout.repos = repoOrder.filter((id) => byId(id));
    const workOrder = strings(body.works);
    if (workOrder && typeof body.repo === 'string' && byId(body.repo)) layout.works[body.repo] = workOrder;
    writeLayout(layout);
    return layout;
  }

  return { list: () => repos, byId, repoFor, assign, grouped, saveOrder, readLayout };
}
