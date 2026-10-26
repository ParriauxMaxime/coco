// Where coco's agents live in Paseo: a repo's own project, one project per work, one workspace per stack row that needs its branch.
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { RepoConfig } from './config.ts';
import type { Work } from './core-types.ts';

export type RunResult = { ok: boolean; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => Promise<RunResult>;
export type PaseoProject = { projectId: string; name: string; path: string };

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
const json = <T>(r: RunResult, fallback: T): T => {
  try {
    return r.ok ? JSON.parse(r.stdout) : fallback;
  } catch {
    return fallback;
  }
};
const samePath = (a: string, b: string) => Boolean(a && b) && path.resolve(a) === path.resolve(b);

export function createPlacement({ repos, exec = defaultExec }: { repos: RepoConfig[]; exec?: Exec }) {
  const projects = async (): Promise<PaseoProject[]> => json(await exec('paseo', ['project', 'ls', '--json']), []);
  // a project rooted at a repo clone is that repo's, never a work's: it keeps its name
  const isRepoProject = (p: PaseoProject) => repos.some((r) => samePath(r.path, p.path));

  // Paseo project names follow work titles; returns the renames, applied unless dryRun
  async function syncProjectNames(works: Work[], { dryRun = false } = {}) {
    const list = await projects();
    const renames: { slug: string; projectId: string; from: string; to: string; skipped?: string }[] = [];
    for (const w of works) {
      const p = w.projectId ? list.find((x) => x.projectId === w.projectId) : null;
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

  return { projects, isRepoProject, syncProjectNames };
}
