// Agent worktrees: before every start or turn of an agent that writes code, coco readies its worktree. Dependency folders link to the main checkout's,
// or become the worktree's own copy (cloned, then installed) when its lockfile differs or the agent asks through own_deps; a hook refuses installs into a
// linked folder. After the agent commits, coco re-runs the repo's checks on the changed files. Settings: `agentWorktree` (docs/guide.md, "Agent worktrees").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expandHome, launcherEnv } from './paseo-agent.ts';
import { repoSetting } from './config.ts';
import type { AgentWorktreeConfig, CheckDef, Config, DepsEntry, RepoConfig } from './config.ts';
import type { Jobs } from './jobs.ts';

export type RunResult = { ok: boolean; output: string };
export type Run = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;
export type DepState = { path: string; mode: 'linked' | 'own' | 'installing' | 'missing'; note?: string };
export type CheckState = { id: string; label: string; command: string; fix?: string; available: boolean; why?: string };
export type Readiness = { state: 'off' | 'ready' | 'preparing' | 'failed'; root: string; deps: DepState[]; checks: CheckState[]; error?: string };
export type CheckResult = { id: string; label: string; state: 'passed' | 'failed' | 'skipped'; command?: string; output?: string; why?: string; ms?: number };
export type Verification = { state: 'passed' | 'failed' | 'unavailable'; at: string; head: string; files: string[]; results: CheckResult[]; why?: string };

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD = path.join(APP_ROOT, 'scripts/install-guard.mjs');
const MARKER = '.coco-deps.json';
const INSTALL_MS = 20 * 60 * 1000;
const CHECK_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 3000;
const RETRY_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

const defaultRun: Run = (cmd, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024, env: { ...launcherEnv(), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout || ''}${stderr ? `\n${stderr}` : ''}${err && !stdout && !stderr ? err.message : ''}`.trim() });
    });
  });

const lstat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const realDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readOr = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const hashOf = (buf: Buffer | null) => (buf ? crypto.createHash('sha256').update(buf).digest('hex') : null);
const tail = (raw: string) => {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '');
  return text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text;
};
const shown = (argv: string[], from = '') => argv.map((a) => (a === '{files}' ? `<changed files${from}>` : a === '{tests}' ? '<tests next to them>' : /\s/.test(a) ? `'${a}'` : a)).join(' ');
const sameReal = (a: string, b: string) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

// the test files a change reaches: changed tests themselves, else x.test.ts or x.spec.ts beside a changed x.ts
export function nearbyTests(root: string, files: string[]) {
  const out = new Set<string>();
  for (const f of files) {
    if (TEST_FILE.test(f)) {
      out.add(f);
      continue;
    }
    const ext = path.extname(f);
    const stem = f.slice(0, -ext.length);
    for (const kind of ['test', 'spec']) if (fs.existsSync(path.join(root, `${stem}.${kind}${ext}`))) out.add(`${stem}.${kind}${ext}`);
  }
  return [...out];
}

// a check's command for these changed files (repo-relative); null when it has nothing to check
export function expandCheck(root: string, check: CheckDef, changed: string[]): { argv: string[]; cwd: string } | { skip: string } {
  const base = path.normalize(check.cwd || '.');
  const inBase = (f: string) => base === '.' || f.startsWith(`${base}/`);
  const matching = changed.filter((f) => inBase(f) && (!check.files || new RegExp(check.files).test(f)));
  if (check.files && !matching.length) return { skip: 'no changed file it checks' };
  const rel = (files: string[]) => files.map((f) => path.relative(base, f));
  const lists: Record<string, string[]> = { '{files}': rel(matching), '{tests}': rel(nearbyTests(root, matching)) };
  const used = check.command.filter((a) => a in lists);
  if (used.some((a) => !lists[a].length)) return { skip: used.includes('{tests}') ? 'no test file next to the changed files' : 'no changed file it checks' };
  return { argv: check.command.flatMap((a) => lists[a] ?? [a]), cwd: path.join(root, base) };
}

type Deps = {
  config: Pick<Config, 'repos'> & Partial<Pick<Config, 'agentWorktree' | 'devServers'>>;
  run?: Run;
  // the agent that asked for own deps, or waits on checks, hears when they work
  notify?: (agentId: string, text: string) => Promise<unknown>;
  log?: (text: string) => void;
  retryMs?: number[];
  platform?: NodeJS.Platform;
  registry?: Pick<Jobs, 'start'>;
  // the dev-servers plugin answers: a brief names its tools only then
  devServersUp?: () => Promise<boolean>;
  // what a dev server costs in this worktree right now (running, building, warm, cold), one brief line
  devServerLine?: (root: string) => Promise<string | null>;
};

const DEV_UP_TTL_MS = 30000;

export function createAgentWorktrees({ config, run = defaultRun, notify = async () => {}, log = () => {}, retryMs = RETRY_MS, platform = process.platform, registry, devServersUp, devServerLine }: Deps) {
  const devNow = new Map<string, string | null>();
  const devConfigured = Boolean(config.devServers && 'projects' in config.devServers);
  let devUp = { at: 0, on: false };
  const probeDev = async () => {
    if (devConfigured && devServersUp && Date.now() - devUp.at > DEV_UP_TTL_MS) devUp = { at: Date.now(), on: await devServersUp().catch(() => false) };
  };
  const jobs = new Map<string, Promise<void>>();
  const failures = new Map<string, string>();
  const attempts = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const waiters = new Map<string, Map<string, string>>();
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  };

  // the repo a worktree belongs to (by its git common dir) and that repo's settings; null when coco readies nothing there.
  // `marks` sits in the worktree's own git dir: an install that wipes node_modules cannot lose it
  async function settingsOf(root: string): Promise<{ cfg: AgentWorktreeConfig; main: string; marks: string } | null> {
    const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd: root, timeoutMs: 10000 });
    if (!r.ok) return null;
    const [gitDir, common] = r.output.split('\n').map((l) => l.trim());
    const repoPath = path.basename(common) === '.git' ? path.dirname(common) : common;
    const repo = config.repos.find((x) => x.path && sameReal(x.path, repoPath)) || null;
    const cfg = repoSetting(config as Config, repo as RepoConfig | null, 'agentWorktree');
    if (!cfg || (!cfg.deps?.length && !cfg.checks?.length)) return null;
    return { cfg: { deps: cfg.deps || [], checks: cfg.checks || [] }, main: expandHome(cfg.mainCheckout || repo?.path || repoPath), marks: path.join(gitDir, MARKER) };
  }

  const lockDiffers = (root: string, main: string, d: DepsEntry) => (d.lockfile ? hashOf(readOr(path.join(root, d.lockfile))) !== hashOf(readOr(path.join(main, d.lockfile))) : false);
  const readMarks = (marks: string): Record<string, string | null> => {
    try {
      return JSON.parse(fs.readFileSync(marks, 'utf8'));
    } catch {
      return {};
    }
  };
  const mark = (marks: string, rel: string, value: string | null) => fs.writeFileSync(marks, JSON.stringify({ ...readMarks(marks), [rel]: value }));

  // what a folder needs now: nothing, a link, or the worktree's own copy (a first one, a reinstall after its lockfile changed or an install cut short).
  // An optional folder the main checkout lacks gets installed in the worktree instead of staying missing
  function needOf(root: string, main: string, marks: string, d: DepsEntry): 'ok' | 'link' | 'own' | 'missing' {
    const target = path.join(root, d.path);
    const st = lstat(target);
    const differs = lockDiffers(root, main, d);
    const absent = d.optional && d.install?.length ? 'own' : 'missing';
    if (st?.isSymbolicLink()) return differs ? 'own' : realDir(target) ? 'ok' : realDir(path.join(main, d.path)) ? 'link' : absent;
    const installed = readMarks(marks)[d.path];
    if (installed !== undefined) return st && installed === (d.lockfile ? hashOf(readOr(path.join(root, d.lockfile))) : null) ? 'ok' : 'own';
    if (st) return 'ok';
    if (differs) return 'own';
    return realDir(path.join(main, d.path)) ? 'link' : absent;
  }

  async function copyTree(from: string, to: string) {
    const cp = platform === 'darwin' ? ['-c', '-R'] : platform === 'linux' ? ['-R', '--reflink=auto'] : null;
    if (cp && (await run('cp', [...cp, from, to], { cwd: path.dirname(to), timeoutMs: INSTALL_MS })).ok) return;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }

  // the worktree's own copy of each folder: a clone of the main checkout's, then the install command, then the marker naming the lockfile it matches
  async function own(root: string, main: string, marks: string, deps: DepsEntry[]) {
    for (const d of deps) {
      const target = path.join(root, d.path);
      const source = path.join(main, d.path);
      mark(marks, d.path, 'installing');
      if (lstat(target)?.isSymbolicLink()) fs.unlinkSync(target);
      const cut = `${path.basename(target)}.coco-`;
      for (const name of fs.existsSync(path.dirname(target)) ? fs.readdirSync(path.dirname(target)) : []) if (name.startsWith(cut)) fs.rmSync(path.join(path.dirname(target), name), { recursive: true, force: true });
      if (!lstat(target) && realDir(source)) {
        const tmp = `${target}.coco-${crypto.randomBytes(3).toString('hex')}`;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
          await copyTree(source, tmp);
          fs.renameSync(tmp, target);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      if (d.install?.length) {
        const r = await run(d.install[0], d.install.slice(1), { cwd: path.dirname(target), timeoutMs: INSTALL_MS });
        if (!r.ok) throw new Error(`${shown(d.install)} in ${path.dirname(d.path)} failed: ${tail(r.output).slice(-600)}`);
      }
      if (!realDir(target)) throw new Error(`${d.path} is still missing after the install`);
      mark(marks, d.path, d.lockfile ? hashOf(readOr(path.join(root, d.lockfile))) : null);
    }
  }

  function startOwn(root: string, main: string, marks: string, deps: DepsEntry[]) {
    if (jobs.has(root)) return;
    failures.delete(root);
    log(`agent worktree ${root}: own copy of ${deps.map((d) => d.path).join(', ')}`);
    const installing = own(root, main, marks, deps);
    try {
      registry?.start({ action: `deps:${root}`, label: `Install ${deps.map((d) => d.path).join(', ')} in ${path.basename(root)}`, kind: 'setup' }, () => installing.then(() => ({ output: '' })));
    } catch {}
    const job = installing
      .catch((e) => {
        failures.set(root, e instanceof Error ? e.message : String(e));
        log(`agent worktree ${root}: ${failures.get(root)}`);
      })
      .finally(() => {
        jobs.delete(root);
        settle(root, false).catch(() => {});
      });
    jobs.set(root, job);
  }

  // after a job or a retry: the waiting agents hear once checks work, else coco tries again later (a few times; the next start or turn tries anew)
  async function settle(root: string, start: boolean) {
    if ((await prepare(root, { retrying: true, start })).state === 'failed') retry(root);
  }
  function retry(root: string) {
    if (timers.has(root)) return;
    const n = attempts.get(root) ?? 0;
    if (n >= retryMs.length) return;
    attempts.set(root, n + 1);
    timers.set(root, setTimeout(() => {
      timers.delete(root);
      settle(root, true).catch(() => {});
    }, retryMs[n]).unref());
  }

  function wake(root: string, r: Readiness) {
    const waiting = waiters.get(root);
    if (!waiting?.size) return;
    waiters.delete(root);
    for (const [agentId, why] of waiting) notify(agentId, readyText(r, why)).catch(() => {});
  }

  // idempotent: links what can be linked, starts the own copies that are due in the background, writes the install guard, and says what works
  async function prepare(root: string, { retrying = false, start = true }: { retrying?: boolean; start?: boolean } = {}): Promise<Readiness> {
    root = path.resolve(expandHome(root));
    const s = await settingsOf(root);
    if (!s) return { state: 'off', root, deps: [], checks: [] };
    await probeDev();
    if (devUp.on && devServerLine) devNow.set(root, await devServerLine(root).catch(() => null));
    const { cfg, main, marks } = s;
    if (!retrying) attempts.delete(root);
    const atMain = sameReal(root, main);
    if (!atMain) guard(root, cfg.deps);
    const deps: DepState[] = [];
    const due: DepsEntry[] = [];
    let linkError = '';
    for (const d of atMain ? [] : cfg.deps) {
      const target = path.join(root, d.path);
      let need = needOf(root, main, marks, d);
      if (need === 'link') {
        try {
          fs.rmSync(target, { force: true });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(path.join(main, d.path), target);
          need = 'ok';
        } catch (e) {
          if (realDir(target)) need = 'ok';
          else linkError = `cannot link ${d.path}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      if (need === 'own') due.push(d);
      deps.push({
        path: d.path,
        mode: need === 'own' ? 'installing' : need === 'ok' ? (lstat(target)?.isSymbolicLink() ? 'linked' : 'own') : 'missing',
        ...(need === 'missing' || need === 'link' ? { note: linkError || `the main checkout ${main} has no ${d.path}` } : need === 'own' && lockDiffers(root, main, d) ? { note: `${d.lockfile} differs from the main checkout's` } : {}),
      });
    }
    if (due.length && start) startOwn(root, main, marks, due);
    const failure = due.length && !jobs.has(root) ? failures.get(root) || 'the own copy is not installed' : undefined;
    const missing = deps.filter((d) => d.mode === 'missing' && !cfg.deps.find((x) => x.path === d.path)?.optional);
    const state: Readiness['state'] = jobs.has(root) ? 'preparing' : failure || missing.length ? 'failed' : 'ready';
    const error = failure || (missing.length ? missing.map((d) => d.note).join('; ') : undefined);
    if (jobs.has(root)) for (const d of deps) if (due.some((x) => x.path === d.path)) d.mode = 'installing';
    else for (const d of deps) if (due.some((x) => x.path === d.path)) d.mode = 'missing';
    const r: Readiness = { state, root, deps, checks: cfg.checks.map((c) => checkState(root, c, state, error)), ...(error ? { error } : {}) };
    if (state === 'ready') wake(root, r);
    if (state === 'failed' && !retrying) retry(root);
    return r;
  }

  function checkState(root: string, c: CheckDef, state: Readiness['state'], error?: string): CheckState {
    const at = c.cwd && path.normalize(c.cwd) !== '.' ? `cd ${c.cwd} && ` : '';
    const from = at ? `, paths relative to ${path.normalize(c.cwd || '.')}` : '';
    const base = { id: c.id, label: c.label, command: `${at}${shown(c.command, from)}`, ...(c.fix ? { fix: `${at}${shown(c.fix, from)}` } : {}) };
    if (state !== 'ready') return { ...base, available: false, why: state === 'preparing' ? 'coco is installing the dependencies' : error || 'the dependencies are not ready' };
    const bin = c.command[0];
    if (bin.includes('/') && !fs.existsSync(path.join(root, c.cwd || '.', bin))) return { ...base, available: false, why: `${bin} is not in this worktree` };
    const lacking = (c.needs || []).find((p) => !fs.existsSync(path.join(root, p)));
    return lacking ? { ...base, available: false, why: `${lacking} is missing, in the main checkout too` } : { ...base, available: true };
  }

  // the agent hears once the checks work, or with the reason when it waits on its own copy
  function whenReady(root: string, agentId: string, why = 'checks') {
    root = path.resolve(expandHome(root));
    const waiting = waiters.get(root) ?? new Map<string, string>();
    waiting.set(agentId, why);
    waiters.set(root, waiting);
  }

  // own_deps: the linked folders (all, or the ones named) become the worktree's own copy; the agent hears when they are installed
  async function ownDeps(cwd: string, agentId: string | null, paths: string[] = []) {
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd: path.resolve(expandHome(cwd)), timeoutMs: 10000 });
    if (!top.ok) throw new Error(`${cwd} is not in a git worktree`);
    const root = top.output.split('\n')[0].trim();
    const s = await settingsOf(root);
    if (!s?.cfg.deps.length) throw new Error('coco readies no dependency folder in this repo');
    if (sameReal(root, s.main)) throw new Error('this is the main checkout: its folders are its own already');
    const asked = paths.length ? s.cfg.deps.filter((d) => paths.includes(d.path)) : s.cfg.deps;
    if (!asked.length) throw new Error(`unknown folder: pick among ${s.cfg.deps.map((d) => d.path).join(', ')}`);
    const linked = asked.filter((d) => !lstat(path.join(root, d.path)) || lstat(path.join(root, d.path))?.isSymbolicLink());
    const already = asked.filter((d) => !linked.includes(d)).map((d) => d.path);
    if (!linked.length) return { root, started: [], already, note: 'Already this worktree\'s own copy: install what you need.' };
    if (agentId) whenReady(root, agentId, 'own');
    const running = jobs.get(root);
    if (running) running.finally(() => startOwn(root, s.main, s.marks, linked));
    else startOwn(root, s.main, s.marks, linked);
    return { root, started: linked.map((d) => d.path), already, note: 'coco is cloning and installing them now; a message tells you when they are ready. Install nothing until then.' };
  }

  // the install guard: a PreToolUse hook in the worktree's .claude/settings.local.json, refusing installs while a folder is linked
  function guard(root: string, deps: DepsEntry[]) {
    if (!deps.length) return;
    const file = path.join(root, '.claude', 'settings.local.json');
    let settings: { hooks?: Record<string, { matcher?: string; hooks?: { type: string; command: string; timeout?: number }[] }[]> } = {};
    try {
      if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      log(`agent worktree ${root}: ${file} is not JSON, no install guard`);
      return;
    }
    const command = [process.execPath, GUARD, ...deps.map((d) => d.path)].map((a) => JSON.stringify(a)).join(' ');
    const pre = (settings.hooks?.PreToolUse || []).filter((e) => !e.hooks?.some((h) => h.command.includes(path.basename(GUARD))));
    const next = { ...settings, hooks: { ...settings.hooks, PreToolUse: [...pre, { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] }] } };
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  // coco's own run of the checks on an agent's change (base..head), one at a time per worktree
  function verify(root: string, { base, head, onCheck }: { base: string; head: string; onCheck?: (r: CheckResult) => void }): Promise<Verification | null> {
    root = path.resolve(expandHome(root));
    return serial(root, async () => {
      const at = new Date().toISOString();
      let r = await prepare(root);
      // an install started for this commit: checking right away would only say "unavailable"
      const installing = r.state === 'preparing' && jobs.get(root);
      if (installing) {
        await installing.catch(() => {});
        r = await prepare(root, { retrying: true, start: false });
      }
      if (r.state === 'off' || !r.checks.length) return null;
      const diff = await run('git', ['diff', '--name-only', '--diff-filter=d', base, head], { cwd: root, timeoutMs: 30000 });
      const files = diff.ok ? diff.output.split('\n').map((l) => l.trim()).filter(Boolean) : [];
      if (r.state !== 'ready') return { state: 'unavailable', at, head, files, results: [], why: r.error || 'coco is still installing the dependencies' };
      const s = await settingsOf(root);
      const results: CheckResult[] = [];
      for (const c of s?.cfg.checks || []) {
        const why = r.checks.find((x) => x.id === c.id && !x.available)?.why;
        if (why) {
          results.push({ id: c.id, label: c.label, state: 'skipped', why });
          onCheck?.(results[results.length - 1]);
          continue;
        }
        const plan = expandCheck(root, c, files);
        if ('skip' in plan) {
          results.push({ id: c.id, label: c.label, state: 'skipped', why: plan.skip });
          onCheck?.(results[results.length - 1]);
          continue;
        }
        const t0 = Date.now();
        const out = await run(plan.argv[0], plan.argv.slice(1), { cwd: plan.cwd, timeoutMs: (c.timeoutSeconds ?? CHECK_MS / 1000) * 1000 });
        results.push({ id: c.id, label: c.label, state: out.ok ? 'passed' : 'failed', command: shown(plan.argv), ms: Date.now() - t0, ...(out.ok ? {} : { output: tail(out.output) }) });
        onCheck?.(results[results.length - 1]);
      }
      return { state: results.some((x) => x.state === 'failed') ? 'failed' : 'passed', at, head, files, results };
    });
  }

  const head = async (cwd: string) => {
    const r = await run('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(expandHome(cwd)), timeoutMs: 10000 });
    return r.ok ? r.output.split('\n')[0].trim() : null;
  };

  // installing: coco is still installing this worktree's own dependencies
  return { prepare, whenReady, ownDeps, verify, head, installing: (root: string) => jobs.has(root), briefLines: (r: Readiness) => briefLines(r, devConfigured && (!devServersUp || devUp.on), devNow.get(r.root) ?? null) };
}
export type AgentWorktrees = ReturnType<typeof createAgentWorktrees>;

const listPaths = (deps: DepState[]) => deps.map((d) => `\`${d.path}\``).join(', ');

// what a code-writing agent's brief says of its worktree: which folders are shared, the check commands that work, the dev server when it is worth one
export function briefLines(r: Readiness, devServers = false, devNow: string | null = null): string[] {
  if (r.state === 'off') return [];
  const linked = r.deps.filter((d) => d.mode === 'linked');
  const own = r.deps.filter((d) => d.mode === 'own');
  const installing = r.deps.filter((d) => d.mode === 'installing');
  const usable = r.checks.filter((c) => c.available);
  const unusable = r.checks.filter((c) => !c.available);
  return [
    '## Your worktree and its checks',
    '',
    ...(linked.length ? [`- ${listPaths(linked)}: linked to the main checkout, shared. Never run \`npm install\`, \`npm ci\`, \`npm add\` or \`npm uninstall\` here (a hook refuses them): call the cocopilot \`own_deps\` tool first; it gives this worktree its own copy and a message tells you when it is ready.`] : []),
    ...(own.length ? [`- ${listPaths(own)}: this worktree's own copy.`] : []),
    ...(installing.length ? [`- ${listPaths(installing)}: coco is installing this worktree's own copy (${installing.map((d) => d.note).filter(Boolean).join('; ') || 'asked for'}).`] : []),
    ...(usable.length ? ['- Before you commit, run these on your changes and fix what they report. Always from the worktree root, exactly as written (a `cd` inside a command is part of it): never `cd` into a subfolder first, and give files as the command says (repo-relative):', ...usable.map((c) => `  - ${c.label}: \`${c.command}\`${c.fix ? ` (fix with \`${c.fix}\`)` : ''}`), '- After your commit coco runs them again; a failure comes back to you once.'] : []),
    ...(unusable.length ? [`- Not available yet: ${unusable.map((c) => c.label).join(', ')} (${unusable[0].why}). coco keeps preparing the worktree and a message tells you once they work. Never borrow tools from another checkout or \`npx\` a package in the meantime; commit, and coco checks your commit once it can.`] : []),
    ...(devServers ? ['- Dev server: only when the change has UI or runtime behavior to see. Use the dev-servers tools: `dev_server_start`, then `dev_server_status` until ready, `dev_server_login` to open it logged in, `dev_server_logs` when it misbehaves, `dev_server_stop` once done. At most 3 run at once: never start one for what lint, types and tests show.', ...(devNow ? [`  ${devNow}`] : [])] : []),
    '',
  ];
}

export function readyText(r: Readiness, why = 'checks') {
  const usable = r.checks.filter((c) => c.available);
  return [
    why === 'own' ? `[coco] This worktree's own dependency folders are installed (${listPaths(r.deps.filter((d) => d.mode === 'own'))}): installs work now.` : '[coco] checks are available now in your worktree.',
    ...(usable.length ? ['Run them on your changes before your next commit, from the worktree root, never after a `cd`:', ...usable.map((c) => `- ${c.label}: \`${c.command}\``)] : []),
  ].join('\n');
}

// what an agent reads when coco's run of the checks on its commit failed
export function failureText(v: Verification, what: string, then = 'Fix them and commit again.') {
  const failed = v.results.filter((x) => x.state === 'failed');
  return [
    `coco re-ran the checks on ${what} (${v.head.slice(0, 7)}): ${failed.map((x) => x.label).join(', ')} failed.`,
    '',
    ...failed.flatMap((x) => [`### ${x.label}: \`${x.command}\``, '', '```', x.output || '(no output)', '```', '']),
    then,
  ].join('\n');
}
