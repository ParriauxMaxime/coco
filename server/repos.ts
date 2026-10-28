// Repos hold works: which repo a work belongs to, the order the sidebar shows repos and works in, and adding a repo.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { DEFAULTS, addRepoToConfigFile, repoId } from './config.ts';
import type { Config, RepoConfig, RepoEntry } from './config.ts';
import type { RunResult, Work } from './core-types.ts';
import type { Jobs } from './jobs.ts';

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

type Exec = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<RunResult>;
const defaultExec: Exec = (cmd, args, { timeout = 60000 } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
const HOME = os.homedir();
const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);
const readOr = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const tilde = (p: string) => (p === HOME || p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p);

// the owner/name of a GitHub remote URL (https or ssh), '' for any other remote
export const githubSlug = (url: string) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())?.[1] || '';

// a GitHub slug or URL names a repo to find on disk or clone; an absolute or ~ path is a local folder
export function parseSource(source: string): { slug: string } | { dir: string } | null {
  const s = source.trim();
  if (/^(\/|~(\/|$))/.test(s)) return { dir: s.replace(/^~(?=\/|$)/, HOME) };
  const fromUrl = /^(https?:\/\/|git@)/.test(s) ? githubSlug(s) : '';
  if (fromUrl) return { slug: fromUrl };
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? { slug: s.replace(/\.git$/, '') } : null;
}

export type Clone = { path: string; github: string; defaultBranch: string };
export type AddRepoResult = {
  ok: boolean;
  error?: string;
  existing?: string;
  repo?: { id: string; name: string; path: string; github: string; defaultBranch: string };
  how?: 'folder' | 'found' | 'cloned';
  project?: { projectId?: string; name?: string; error?: string };
  setup?: { agentId?: string | null; error?: string };
};
type AdderDeps = {
  config: Pick<Config, 'repos' | 'cloneDir'>;
  APP: string;
  configFile: string;
  exec?: Exec;
  project?: (repo: RepoConfig) => Promise<{ projectId: string; name: string }>;
  setup?: (repo: RepoConfig) => Promise<{ agentId: string | null }>;
  jobs?: Pick<Jobs, 'wrap'>;
};

// adds a repo: its clone (a local folder, one found on disk by its origin remote, else `gh repo clone` into cloneDir), listed in the config file and live at once, then its Paseo project and a setup run
export function createRepoAdder({ config, APP, configFile, exec = defaultExec, project, setup, jobs }: AdderDeps) {
  async function cloneAt(dir: string): Promise<Clone | null> {
    const top = await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    if (!top.ok) return null;
    const root = top.stdout.trim();
    const [origin, head] = await Promise.all([exec('git', ['-C', root, 'remote', 'get-url', 'origin']), exec('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])]);
    const current = head.ok ? null : await exec('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD']);
    const defaultBranch = head.ok ? head.stdout.trim().replace(/^origin\//, '') : current?.ok ? current.stdout.trim() : 'main';
    return { path: root, github: origin.ok ? githubSlug(origin.stdout) : '', defaultBranch };
  }

  // a main clone (a .git folder, not a linked worktree) in cloneDir whose origin is the slug, <cloneDir>/<name> first
  async function findClone(slug: string) {
    const name = slug.split('/')[1];
    const children = fs.existsSync(config.cloneDir) ? fs.readdirSync(config.cloneDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    for (const dir of [name, ...children.filter((c) => c !== name)].map((c) => path.join(config.cloneDir, c))) {
      if (!fs.statSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory()) continue;
      if (!readOr(path.join(dir, '.git', 'config')).toLowerCase().includes(slug.toLowerCase())) continue;
      const c = await cloneAt(dir);
      if (c && c.github.toLowerCase() === slug.toLowerCase()) return c;
    }
    return null;
  }

  async function resolve(source: string): Promise<(Clone & { how: AddRepoResult['how'] }) | { error: string }> {
    const src = parseSource(source);
    if (!src) return { error: `${source} is neither a GitHub slug (owner/name) nor an absolute folder path` };
    if ('dir' in src) {
      const c = fs.existsSync(src.dir) ? await cloneAt(src.dir) : null;
      return c ? { ...c, how: 'folder' } : { error: `${src.dir} is not a git clone` };
    }
    const found = await findClone(src.slug);
    if (found) return { ...found, how: 'found' };
    const dest = path.join(config.cloneDir, src.slug.split('/')[1]);
    if (fs.existsSync(dest)) return { error: `${dest} exists and is not a clone of ${src.slug}` };
    fs.mkdirSync(config.cloneDir, { recursive: true });
    const r = await exec('gh', ['repo', 'clone', src.slug, dest], { timeout: 15 * 60 * 1000 });
    if (!r.ok) return { error: `gh repo clone ${src.slug} failed: ${r.stderr.trim().slice(0, 300)}` };
    const c = await cloneAt(dest);
    return c ? { ...c, github: c.github || src.slug, how: 'cloned' } : { error: `${dest} is not a git clone after gh repo clone` };
  }

  // a reload lists the config's repos first and coco's own folder last unless listed: the new one goes where a reload would put it
  function register(repo: RepoConfig) {
    const last = config.repos.at(-1);
    const appLast = last && samePath(last.path, APP) && config.repos.length > 1;
    config.repos.splice(appLast ? config.repos.length - 1 : config.repos.length, 0, repo);
  }

  async function add(source: string): Promise<AddRepoResult> {
    const found = await resolve(source);
    if ('error' in found) return { ok: false, error: found.error };
    const known = config.repos.find((r) => (r.path && samePath(r.path, found.path)) || (found.github && r.github.toLowerCase() === found.github.toLowerCase()));
    if (known) return { ok: false, error: `${known.name} is already a repo of coco`, existing: known.id };
    const id = repoId(found.path, new Set(config.repos.map((r) => r.id)));
    const entry: RepoEntry = { id, name: path.basename(found.path), path: tilde(found.path), github: found.github, defaultBranch: found.defaultBranch };
    const first = config.repos[0] && !samePath(config.repos[0].path, APP) ? { id: config.repos[0].id, name: config.repos[0].name, path: tilde(config.repos[0].path) } : null;
    addRepoToConfigFile(configFile, entry, first);
    const repo: RepoConfig = { ...DEFAULTS.repo, ...entry, path: found.path, github: found.github, defaultBranch: found.defaultBranch, settings: {} };
    register(repo);
    const failed = (e: unknown) => ({ error: e instanceof Error ? e.message : String(e) });
    const projectDone = project ? await project(repo).then((p) => ({ projectId: p.projectId, name: p.name }), failed) : undefined;
    const setupDone = setup ? await setup(repo).then((s) => ({ agentId: s.agentId }), failed) : undefined;
    return { ok: true, repo: { id, name: repo.name, path: repo.path, github: repo.github, defaultBranch: repo.defaultBranch }, how: found.how, project: projectDone, setup: setupDone };
  }

  // one add at a time: each reads the config file the previous one wrote
  let queue: Promise<unknown> = Promise.resolve();
  // as a job: a refused add (already known, not found) fails it with its reason
  const tracked = (source: string) => {
    if (!jobs) return add(source);
    let result: AddRepoResult | undefined;
    return jobs.wrap({ action: `repo-add:${source}`, label: `Add repo ${path.basename(source)}`, kind: 'setup' }, async () => {
      result = await add(source);
      if (!result.ok) throw new Error(result.error);
      return result;
    }).catch((e) => result ?? Promise.reject(e));
  };
  return {
    add: (source: string) => {
      const next = queue.then(() => tracked(source));
      queue = next.catch(() => {});
      return next;
    },
  };
}
