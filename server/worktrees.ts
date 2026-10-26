// A work's PR worktrees outlive their merge: they go only when the work is archived and the owner ticks them; auto-archive leaves an Inbox notice with the same list.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rowKey } from './stack.ts';
import { defaultExec } from './placement.ts';
import type { Exec, PaseoProject } from './placement.ts';
import type { RepoConfig } from './config.ts';
import type { ReadBody, Req, Res, Send, Work } from './core-types.ts';

type WorkspaceEntry = { id: string; projectId?: string; workspaceDirectory?: string; archivingAt?: unknown };
type PrHead = { title?: string; head?: string | null; headOid?: string | null };
export type WorkWorktree = { path: string; branch: string; title: string; key: string | null; workspaceIds: string[]; dirty: number; unpushed: number; error?: string };
export type WorktreeNotice = { id: string; kind: 'worktrees'; slug: string; title: string; at: string; count: number };
export type RemoveResult = { removed: string[]; kept: { path: string; why: string }[]; unarchived: { workspaceId: string; why: string }[] };
type Deps = {
  DATA: string;
  exec?: Exec;
  listWorkspaces: () => Promise<WorkspaceEntry[]>;
  works: { get(slug: string): Work | null; prInfo(n: number): Promise<PrHead | null | undefined> };
  repoFor: (work: Work) => RepoConfig;
};

const samePath = (a: string | undefined, b: string | undefined) => Boolean(a && b) && path.resolve(a as string) === path.resolve(b as string);
const why = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().slice(0, 300);

// the repo's worktrees, its main checkout first
export async function gitWorktrees(exec: Exec, repoPath: string) {
  const r = await exec('git', ['-C', repoPath, 'worktree', 'list', '--porcelain']);
  return (r.ok ? r.stdout.split(/\n\s*\n/) : []).flatMap((block) => {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length).trim();
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length).trim();
    return wt ? [{ path: wt, branch: branch || '' }] : [];
  });
}

// uncommitted files, and commits on HEAD that no remote ref nor the PR's last pushed head holds
export async function worktreeState(exec: Exec, dir: string, headOid?: string | null) {
  const status = await exec('git', ['-C', dir, 'status', '--porcelain']);
  if (!status.ok) return { dirty: 0, unpushed: 0, error: why(status) };
  const dirty = status.stdout.split('\n').filter(Boolean).length;
  const pushed = headOid && (await exec('git', ['-C', dir, 'cat-file', '-e', `${headOid}^{commit}`])).ok ? [headOid] : [];
  const ahead = await exec('git', ['-C', dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes', ...pushed]);
  if (!ahead.ok) return { dirty, unpushed: 0, error: why(ahead) };
  return { dirty, unpushed: Number(ahead.stdout.trim()) || 0 };
}

// git refuses a worktree with changes (never --force); its workspaces are archived only once it is gone
export async function removeWorktree(exec: Exec, repoPath: string, dir: string, workspaceIds: string[]) {
  const r = await exec('git', ['-C', repoPath, 'worktree', 'remove', dir]);
  if (!r.ok) return { ok: false as const, why: why(r), unarchived: [] };
  const unarchived: { workspaceId: string; why: string }[] = [];
  for (const id of workspaceIds) {
    const a = await exec('paseo', ['workspace', 'archive', id]);
    if (!a.ok) unarchived.push({ workspaceId: id, why: why(a) });
  }
  return { ok: true as const, unarchived };
}

export function createWorktrees({ DATA, exec = defaultExec, listWorkspaces, works, repoFor }: Deps) {
  const file = path.join(DATA, 'notices.json');
  const readNotices = (): WorktreeNotice[] => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };
  const writeNotices = (list: WorktreeNotice[]) => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 1));
  };
  const dropNotices = (slug: string) => writeNotices(readNotices().filter((n) => n.slug !== slug));
  // a notice outlives nothing: once its work is unarchived or gone, it is not shown
  const notices = () => readNotices().filter((n) => works.get(n.slug)?.archived);

  async function projectRoot(work: Work) {
    if (!work.projectId) return null;
    const r = await exec('paseo', ['project', 'ls', '--json']);
    try {
      return (JSON.parse(r.stdout) as PaseoProject[]).find((p) => p.projectId === work.projectId)?.path || null;
    } catch {
      return null;
    }
  }

  // the worktrees of a work: each row's (its remembered workspace, else the one on its branch) and any other workspace of the work's project; never the clone nor the project root
  async function list(slug: string): Promise<WorkWorktree[]> {
    const work = works.get(slug);
    if (!work) return [];
    const repo = repoFor(work);
    const [trees, all, root] = await Promise.all([gitWorktrees(exec, repo.path), listWorkspaces(), projectRoot(work)]);
    const spaces = all.filter((w) => !w.archivingAt);
    const found = new Map<string, { branch: string; title: string; key: string | null; headOid: string | null }>();
    const rows = await Promise.all((work.stack || []).map(async (row) => ({ row, pr: row.number ? await works.prInfo(row.number) : null })));
    for (const { row, pr } of rows) {
      const key = rowKey(row);
      const space = row.workspaceId ? spaces.find((w) => w.id === row.workspaceId) : null;
      const branch = row.planned?.branch || pr?.head || '';
      const tree = (space?.workspaceDirectory && trees.find((t) => samePath(t.path, space.workspaceDirectory))) || (branch ? trees.find((t) => t.branch === branch) : undefined);
      if (!tree || found.has(tree.path)) continue;
      found.set(tree.path, { branch: tree.branch, title: pr?.title || row.planned?.title || tree.branch || path.basename(tree.path), key: key === null ? null : String(key), headOid: pr?.headOid || null });
    }
    for (const w of spaces) {
      if (!work.projectId || w.projectId !== work.projectId) continue;
      const tree = trees.find((t) => samePath(t.path, w.workspaceDirectory));
      if (tree && !found.has(tree.path)) found.set(tree.path, { branch: tree.branch, title: tree.branch || path.basename(tree.path), key: null, headOid: null });
    }
    const keep = [...found].filter(([p]) => !samePath(p, repo.path) && !samePath(p, root || undefined));
    return Promise.all(
      keep.map(async ([p, f]) => ({
        path: p,
        branch: f.branch,
        title: f.title,
        key: f.key,
        workspaceIds: spaces.filter((w) => samePath(w.workspaceDirectory, p)).map((w) => w.id),
        ...(await worktreeState(exec, p, f.headOid)),
      })),
    );
  }

  // only the ticked paths of this work; git refuses a worktree with changes (no --force), and its workspaces are archived only once it is gone
  async function remove(slug: string, paths: string[]): Promise<RemoveResult> {
    const out: RemoveResult = { removed: [], kept: [], unarchived: [] };
    const work = works.get(slug);
    if (!work) return { ...out, kept: paths.map((p) => ({ path: p, why: 'no such work' })) };
    const repo = repoFor(work);
    const known = await list(slug);
    for (const p of paths) {
      const wt = known.find((w) => samePath(w.path, p));
      if (!wt) {
        out.kept.push({ path: p, why: 'not a worktree of this work' });
        continue;
      }
      const r = await removeWorktree(exec, repo.path, wt.path, wt.workspaceIds);
      if (!r.ok) {
        out.kept.push({ path: wt.path, why: r.why });
        continue;
      }
      out.removed.push(wt.path);
      out.unarchived.push(...r.unarchived);
    }
    return out;
  }

  async function noticeArchived(work: Work) {
    const found = await list(work.slug);
    if (!found.length) return null;
    const notice: WorktreeNotice = { id: randomUUID(), kind: 'worktrees', slug: work.slug, title: work.title, at: new Date().toISOString(), count: found.length };
    writeNotices([notice, ...readNotices().filter((n) => n.slug !== work.slug)]);
    return notice;
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b, c] = parts;
    if (root === 'notices' && !a) return send(res, 200, notices());
    if (root === 'notices' && a && b === 'dismiss' && req.method === 'POST') {
      writeNotices(readNotices().filter((n) => n.id !== a));
      return send(res, 200, { ok: true });
    }
    if (root === 'works' && a && b === 'worktrees' && !c) return send(res, 200, await list(a));
    if (root === 'works' && a && b === 'worktrees' && c === 'remove' && req.method === 'POST') {
      const body: { paths?: unknown } = JSON.parse((await readBody(req)) || '{}');
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === 'string') : [];
      const result = await remove(a, paths);
      if (!result.kept.length) dropNotices(a);
      return send(res, 200, result);
    }
    return send(res, 404, { error: 'no route' });
  }

  return { list, remove, noticeArchived, notices, handle };
}
