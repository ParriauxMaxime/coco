// Where coco's agents live in Paseo: a repo's own project, one project per work, one workspace per stack row that needs its branch.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rowKey } from './stack.ts';
import type { RepoConfig } from './config.ts';
import type { RowKey, StackRow, Work } from './core-types.ts';

export type RunResult = { ok: boolean; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => Promise<RunResult>;
export type PaseoProject = { projectId: string; name: string; path: string };
type WorkspaceEntry = { id: string; projectId?: string; workspaceDirectory?: string; archivingAt?: unknown };
export type Scope = { kind: 'global' } | { kind: 'repo'; repoId: string } | { kind: 'work'; slug: string } | { kind: 'row'; slug: string; key: RowKey; edits: boolean } | { kind: 'pr'; repoId: string; number: number; edits: boolean };
export type Placed = { workspaceId: string; cwd: string };
type Deps = {
  repos: RepoConfig[];
  APP: string;
  DATA: string;
  exec?: Exec;
  listWorkspaces?: () => Promise<WorkspaceEntry[]>;
  works?: { get(slug: string): Work | null; save(w: Work, opts?: { touch?: boolean }): unknown; prInfo(n: number): Promise<{ title?: string; head?: string | null; state?: string } | null | undefined> };
};

const AMBIENT_PASEO = ['PASEO_AGENT_ID', 'PASEO_AGENT_CWD', 'PASEO_WORKSPACE_ID'];
const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !AMBIENT_PASEO.includes(k)));
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 180000, env }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
const json = <T>(r: RunResult, fallback: T): T => {
  try {
    return r.ok ? JSON.parse(r.stdout) : fallback;
  } catch {
    return fallback;
  }
};
const samePath = (a: string | undefined, b: string | undefined) => Boolean(a && b) && path.resolve(a as string) === path.resolve(b as string);
const fail = (what: string, r: RunResult) => new Error(`${what}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);

// workspace titles coco gives where a scope has no title of its own
export const REPO_WORKSPACE_TITLE = 'cocopilot';
export const WORK_WORKSPACE_TITLE = 'Plan';

export function createPlacement({ repos, APP, DATA, exec = defaultExec, listWorkspaces = async () => [], works }: Deps) {
  const projects = async (): Promise<PaseoProject[]> => json(await exec('paseo', ['project', 'ls', '--json']), []);
  // a project rooted at a repo clone is that repo's, never a work's: it keeps its name
  const isRepoProject = (p: PaseoProject) => repos.some((r) => samePath(r.path, p.path));
  const repoById = (id: string | undefined) => repos.find((r) => r.id === id) || repos[0];
  const appRepo = () => repos.find((r) => samePath(r.path, APP)) || repos[repos.length - 1];
  const plansDir = path.join(DATA, 'worktrees');

  // Paseo project names follow work titles; returns the renames, applied unless dryRun
  async function syncProjectNames(list: Work[], { dryRun = false } = {}) {
    const known = await projects();
    const renames: { slug: string; projectId: string; from: string; to: string; skipped?: string }[] = [];
    for (const w of list) {
      const p = w.projectId ? known.find((x) => x.projectId === w.projectId) : null;
      if (!p || !w.title || p.name === w.title) continue;
      if (isRepoProject(p)) {
        renames.push({ slug: w.slug, projectId: p.projectId, from: p.name, to: w.title, skipped: 'the repo’s own project' });
        continue;
      }
      renames.push({ slug: w.slug, projectId: p.projectId, from: p.name, to: w.title });
      if (!dryRun) await exec('paseo', ['project', 'rename', p.projectId, w.title]);
    }
    return renames;
  }

  async function projectAt(dir: string): Promise<PaseoProject> {
    const hit = (await projects()).find((p) => samePath(p.path, dir));
    if (hit) return hit;
    const r = await exec('paseo', ['project', 'create', dir, '--json']);
    const made = json<PaseoProject | null>(r, null);
    if (!made?.projectId) throw fail(`cannot add a Paseo project on ${dir}`, r);
    return made;
  }

  // a repo's own project: the one already on its clone as it is, else a new one named after the repo
  async function repoProject(repo: RepoConfig): Promise<PaseoProject> {
    const hit = (await projects()).find((p) => samePath(p.path, repo.path));
    if (hit) return hit;
    const made = await projectAt(repo.path);
    if (made.name === repo.name) return made;
    const r = await exec('paseo', ['project', 'rename', made.projectId, repo.name]);
    return r.ok ? { ...made, name: repo.name } : made;
  }

  const live = async () => (await listWorkspaces()).filter((w) => !w.archivingAt);
  const createWorkspace = async (args: string[], what: string): Promise<Placed> => {
    const r = await exec('paseo', ['workspace', 'create', ...args, '--json']);
    const ws = json<{ workspaceId?: string; cwd?: string } | null>(r, null);
    if (!ws?.workspaceId || !ws.cwd) throw fail(`cannot create the Paseo workspace for ${what}`, r);
    return { workspaceId: ws.workspaceId, cwd: ws.cwd };
  };
  // the project's live workspace on dir, else a new one titled `title` (an existing folder is adopted as it is)
  async function workspaceOn(projectId: string, dir: string, title: string, entries?: WorkspaceEntry[]): Promise<Placed> {
    const hit = (entries || (await live())).find((w) => w.projectId === projectId && samePath(w.workspaceDirectory, dir));
    if (hit) return { workspaceId: hit.id, cwd: dir };
    return createWorkspace(['--isolation', 'local', '--path', dir, '--project', projectId, '--title', title], title);
  }

  // the clone usually has workspaces of its own already: coco keeps one of its own there, remembered by id
  const ownFile = path.join(DATA, 'placement.json');
  const readOwn = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(ownFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const keptOwn = (key: string, entries: WorkspaceEntry[]) => {
    const id = readOwn()[key];
    return id ? entries.find((w) => w.id === id) : undefined;
  };
  const keepOwn = (key: string, workspaceId: string) => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(ownFile, JSON.stringify({ ...readOwn(), [key]: workspaceId }, null, 1));
  };
  async function repoPlace(repo: RepoConfig) {
    const kept = keptOwn(`repo:${repo.id}`, await live());
    if (kept) return { workspaceId: kept.id, cwd: kept.workspaceDirectory || repo.path };
    const p = await projectAt(repo.path);
    const placed = await createWorkspace(['--isolation', 'local', '--path', repo.path, '--project', p.projectId, '--title', REPO_WORKSPACE_TITLE], REPO_WORKSPACE_TITLE);
    keepOwn(`repo:${repo.id}`, placed.workspaceId);
    return placed;
  }

  // a work without a project gets one, rooted at a detached plan worktree off the repo's default branch, named after the work
  async function ensureWorkProject(work: Work): Promise<PaseoProject> {
    const known = await projects();
    const p = work.projectId ? known.find((x) => x.projectId === work.projectId) : null;
    if (p) return p;
    const repo = repoById(work.repo);
    const dir = path.join(plansDir, repo.id, work.slug);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const base = (await exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `origin/${repo.defaultBranch}`])).ok ? `origin/${repo.defaultBranch}` : repo.defaultBranch;
      const r = await exec('git', ['-C', repo.path, 'worktree', 'add', '--detach', dir, base]);
      if (!r.ok) throw fail(`cannot make the plan worktree of ${work.slug}`, r);
    }
    const made = await projectAt(dir);
    if (made.name !== work.title) await exec('paseo', ['project', 'rename', made.projectId, work.title]);
    works?.save({ ...work, projectId: made.projectId, projectName: work.title }, { touch: false });
    return { ...made, name: work.title };
  }

  async function workPlace(work: Work) {
    const p = await ensureWorkProject(work);
    return workspaceOn(p.projectId, p.path, WORK_WORKSPACE_TITLE);
  }

  async function worktreeOf(repoPath: string, branch: string) {
    const r = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
    for (const block of r.ok ? r.stdout.split(/\n\s*\n/) : []) {
      const lines = block.split('\n');
      const wt = lines.find((l) => l.startsWith('worktree '));
      if (wt && lines.some((l) => l.trim() === `branch refs/heads/${branch}`)) return wt.slice('worktree '.length).trim();
    }
    return null;
  }

  // a row that needs its branch: the workspace remembered for it, an adopted worktree already on the branch, else a new worktree workspace in the work's project
  async function rowPlace(work: Work, key: RowKey) {
    const stack = work.stack || [];
    const i = stack.findIndex((s) => rowKey(s) === key);
    if (i < 0) throw new Error(`no row ${key} in ${work.slug}`);
    const row = stack[i];
    const entries = await live();
    const known = row.workspaceId ? entries.find((w) => w.id === row.workspaceId) : null;
    if (known?.workspaceDirectory) return { workspaceId: known.id, cwd: known.workspaceDirectory };
    const p = await ensureWorkProject(work);
    const fresh = works?.get(work.slug) || work;
    const repo = repoById(fresh.repo);
    const pr = row.number ? await works?.prInfo(row.number) : null;
    const title = pr?.title || row.planned?.title || String(key);
    const branch = row.planned?.branch || pr?.head || '';
    const adopted = branch ? await worktreeOf(repo.path, branch) : null;
    let placed: Placed;
    if (adopted) placed = await workspaceOn(p.projectId, adopted, title, entries);
    else if (row.number) placed = await createWorkspace(['--isolation', 'worktree', '--path', p.path, '--project', p.projectId, '--mode', 'checkout-pr', '--pr-number', String(row.number), '--title', title], title);
    else if (branch) placed = await createWorkspace(['--isolation', 'worktree', '--path', p.path, '--project', p.projectId, '--mode', 'branch-off', '--new-branch', branch, '--base', previousBranch(stack, i, repo) , '--title', title], title);
    else throw new Error(`row ${key} of ${work.slug} has neither a PR nor a planned branch`);
    remember(fresh.slug, key, placed.workspaceId);
    return placed;
  }

  const previousBranch = (stack: StackRow[], i: number, repo: RepoConfig) => {
    for (let j = i - 1; j >= 0; j--) if (stack[j].planned?.branch) return stack[j].planned?.branch as string;
    return repo.defaultBranch;
  };
  const remember = (slug: string, key: RowKey, workspaceId: string) => {
    const w = works?.get(slug);
    if (!w) return;
    works?.save({ ...w, stack: (w.stack || []).map((s) => (rowKey(s) === key ? { ...s, workspaceId } : s)) }, { touch: false });
  };

  // an editing agent on a PR no work stacks: the workspace remembered for it, an adopted worktree on its branch, else a PR checkout in the repo's project
  async function loosePrPlace(repo: RepoConfig, number: number) {
    const key = `pr:${repo.id}:${number}`;
    const entries = await live();
    const kept = keptOwn(key, entries);
    if (kept?.workspaceDirectory) return { workspaceId: kept.id, cwd: kept.workspaceDirectory };
    const p = await projectAt(repo.path);
    const pr = json<{ title?: string; headRefName?: string } | null>(await exec('gh', ['pr', 'view', String(number), '--repo', repo.github, '--json', 'title,headRefName']), null);
    const title = pr?.title || pr?.headRefName || String(number);
    const adopted = pr?.headRefName ? await worktreeOf(repo.path, pr.headRefName) : null;
    const placed = adopted
      ? await workspaceOn(p.projectId, adopted, title, entries)
      : await createWorkspace(['--isolation', 'worktree', '--path', repo.path, '--project', p.projectId, '--mode', 'checkout-pr', '--pr-number', String(number), '--title', title], title);
    keepOwn(key, placed.workspaceId);
    return placed;
  }

  // a scratch branch for an agent that proposes commits without touching the PR's branch (finding fixes), in the work's project
  async function sideWorkspace(slug: string, { branch, base, title }: { branch: string; base: string; title: string }) {
    const work = works?.get(slug);
    if (!work) throw new Error(`unknown work ${slug}`);
    const p = await ensureWorkProject(work);
    return createWorkspace(['--isolation', 'worktree', '--path', p.path, '--project', p.projectId, '--mode', 'branch-off', '--new-branch', branch, '--base', base, '--title', title], title);
  }

  // the Paseo workspace an agent of this scope runs in; read-only row agents share the work's, read-only agents on a PR outside any work the repo's
  async function place(scope: Scope): Promise<Placed> {
    if (scope.kind === 'global') return repoPlace(appRepo());
    if (scope.kind === 'repo') return repoPlace(repoById(scope.repoId));
    if (scope.kind === 'pr') return scope.edits ? loosePrPlace(repoById(scope.repoId), scope.number) : repoPlace(repoById(scope.repoId));
    const work = works?.get(scope.slug);
    if (!work) throw new Error(`unknown work ${scope.slug}`);
    if (scope.kind === 'row' && scope.edits) return rowPlace(work, scope.key);
    return workPlace(work);
  }

  return { projects, isRepoProject, syncProjectNames, place, sideWorkspace, repoProject };
}
