// Spare worktrees: a code agent takes a ready-made worktree (deps linked, warm-up commands run) and switches it to its branch in a fraction of a second,
// instead of a `git worktree add` (~15 s on a big repo). `agentWorktree.spares` per repo; refilled in the background after each claim (docs/guide.md, "Spare worktrees").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { launcherEnv } from './paseo-agent.ts';
import { repoSetting } from './config.ts';
import type { Config, RepoConfig } from './config.ts';
import type { Readiness } from './agent-worktree.ts';
import type { Jobs } from './jobs.ts';

export type Spare = { id: string; repo: string; path: string; state: 'creating' | 'warming' | 'ready'; createdAt: string };
type Ran = { ok: boolean; output: string };
export type SpareRun = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<Ran>;
type Deps = {
  DATA: string;
  config: Pick<Config, 'repos'> & Partial<Pick<Config, 'agentWorktree'>>;
  prepare: (root: string, opts?: { retrying?: boolean; start?: boolean }) => Promise<Readiness>;
  run?: SpareRun;
  registry?: Pick<Jobs, 'start'>;
  log?: (text: string) => void;
  pollMs?: number;
};

const WARM_MS = 15 * 60 * 1000;
const defaultRun: SpareRun = (cmd, args, { cwd, timeoutMs, signal }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, signal, maxBuffer: 50 * 1024 * 1024, env: { ...launcherEnv(), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout || ''}${stderr ? `\n${stderr}` : ''}${err && !stdout && !stderr ? err.message : ''}`.trim() });
    });
  });

export function createSpares({ DATA, config, prepare, run = defaultRun, registry, log = () => {}, pollMs = 2000 }: Deps) {
  const file = path.join(DATA, 'spares.json');
  const read = (): Spare[] => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
  };
  let pool = read();
  const save = () => fs.writeFileSync(file, JSON.stringify(pool, null, 1));
  const warming = new Map<string, AbortController>();
  const filling = new Map<string, Promise<void>>();
  const repoOf = (id: string) => config.repos.find((r) => r.id === id) || null;
  // each spare costs a checkout of disk: a top-level count serves the default repo only, any other repo sets its own
  const wanted = (repo: RepoConfig) => Math.max(0, (repo.settings.agentWorktree ?? (repo === config.repos[0] ? config.agentWorktree : null))?.spares ?? 0);
  const git = (cwd: string, args: string[]) => run('git', args, { cwd, timeoutMs: 120_000 });
  const pooled = (s: Spare) => pool.some((x) => x.id === s.id);
  // a worktree's .git file goes first when something removes it by hand
  const intact = (s: Spare) => fs.existsSync(path.join(s.path, '.git'));

  async function discard(repo: RepoConfig | null, s: Spare) {
    pool = pool.filter((x) => x.id !== s.id);
    save();
    warming.get(s.id)?.abort();
    if (repo) await git(repo.path, ['worktree', 'remove', '--force', s.path]);
    fs.rmSync(s.path, { recursive: true, force: true });
    if (repo) await git(repo.path, ['worktree', 'prune']);
  }

  // a detached worktree at the default branch, its deps readied, then the warm-up commands; a claim cuts the warm-up short
  async function make(repo: RepoConfig) {
    const id = crypto.randomBytes(3).toString('hex');
    const s: Spare = { id, repo: repo.id, path: path.join(DATA, 'spares', repo.id, id), state: 'creating', createdAt: new Date().toISOString() };
    pool.push(s);
    save();
    try {
      fs.mkdirSync(path.dirname(s.path), { recursive: true });
      const remote = `origin/${repo.defaultBranch}`;
      const base = (await git(repo.path, ['rev-parse', '--verify', '--quiet', remote])).ok ? remote : repo.defaultBranch;
      const added = await git(repo.path, ['worktree', 'add', '-q', '--detach', s.path, base]);
      if (!added.ok) throw new Error(`git worktree add: ${added.output.slice(-300)}`);
      let r = await prepare(s.path);
      while (r.state === 'preparing' && pooled(s)) {
        await new Promise((ok) => setTimeout(ok, pollMs));
        r = await prepare(s.path, { retrying: true, start: false });
      }
      if (!pooled(s)) return;
      s.state = 'warming';
      save();
      const abort = new AbortController();
      warming.set(id, abort);
      for (const w of repoSetting(config as Config, repo, 'agentWorktree')?.warm ?? []) {
        if (abort.signal.aborted) break;
        const done = await run(w.command[0], w.command.slice(1), { cwd: path.join(s.path, w.cwd || ''), timeoutMs: (w.timeoutSeconds ?? WARM_MS / 1000) * 1000, signal: abort.signal });
        if (!done.ok && !abort.signal.aborted) log(`spare ${s.path}: ${w.label} failed, kept anyway: ${done.output.slice(-300)}`);
      }
      warming.delete(id);
      if (!pooled(s)) return;
      s.state = 'ready';
      save();
    } catch (e) {
      log(`spare ${s.path}: ${e instanceof Error ? e.message : String(e)}`);
      await discard(repo, s);
      throw e;
    }
  }

  // tops a repo's pool up, one spare at a time; a failure stops the round, the next claim or restart tries again
  function fill(repo: RepoConfig) {
    const going = filling.get(repo.id);
    if (going) return going;
    const round = (async () => {
      while (pool.filter((s) => s.repo === repo.id).length < wanted(repo)) {
        const making = make(repo);
        try {
          registry?.start({ action: `spare:${repo.id}:${crypto.randomUUID()}`, label: `Spare worktree for ${repo.name}`, kind: 'setup' }, () => making.then(() => ({ output: '' })));
        } catch {}
        await making;
      }
    })()
      .catch(() => {})
      .finally(() => filling.delete(repo.id));
    filling.set(repo.id, round);
    return round;
  }

  // a spare of the repo on `branch` (created or reset at `base`), null when none is ready: the caller makes its own worktree
  async function claim(repoId: string, { branch, base }: { branch: string; base: string }): Promise<string | null> {
    const repo = repoOf(repoId);
    if (!repo || !wanted(repo)) return null;
    const s = pool.find((x) => x.repo === repo.id && x.state !== 'creating' && intact(x));
    if (!s) {
      void fill(repo);
      return null;
    }
    pool = pool.filter((x) => x.id !== s.id);
    save();
    warming.get(s.id)?.abort();
    const moved = await git(s.path, ['checkout', '-q', '-B', branch, base]);
    void fill(repo);
    if (moved.ok) return s.path;
    log(`spare ${s.path}: checkout ${branch} failed: ${moved.output.slice(-300)}`);
    await discard(repo, s);
    return null;
  }

  // after a restart: spares cut short go, extras beyond the wanted count go, then each repo fills up
  async function start() {
    for (const s of [...pool]) {
      const repo = repoOf(s.repo);
      const extra = !repo || pool.filter((x) => x.repo === s.repo).indexOf(s) >= wanted(repo);
      if (s.state !== 'ready' || extra || !intact(s)) await discard(repo, s);
    }
    await Promise.all(config.repos.filter((r) => wanted(r) > 0).map((r) => fill(r)));
  }

  return { claim, start, fill, list: () => pool.map((s) => ({ ...s })) };
}

export type Spares = ReturnType<typeof createSpares>;
