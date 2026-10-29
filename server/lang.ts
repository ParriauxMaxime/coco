// Navigation: one TypeScript language service worker (child process) for the last PR head used, in the repo that holds it.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lang-worker.ts');
const SHA_RE = /^[0-9a-f]{40}$/;
const CRASH_COOLDOWN = 60000;

type WorkerReply = { error?: string; result?: unknown };
type Pending = { resolve: (reply: WorkerReply) => void; timer: NodeJS.Timeout | undefined };
type Exited = { code: number | null; signal: NodeJS.Signals | null; stderr: string };
type WorkerOptions = { repo: string; sha: string; tsPath?: string; tsconfig?: string; maxOldSpaceMB?: number };
type Worker = ReturnType<typeof startWorker>;

export function startWorker({ repo, sha, tsPath, tsconfig, maxOldSpaceMB = 4096 }: WorkerOptions) {
  const child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpaceMB}`, '--expose-gc', WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, Pending>();
  let seq = 0;
  let exited: Exited | null = null;
  let stderr = '';
  // errors name files from the repo root, never by their absolute path
  const rel = (s: string) => s.replaceAll(`${path.resolve(repo)}${path.sep}`, '');
  child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg.error ? { error: rel(String(msg.error)) } : { result: msg.result });
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal, stderr: rel(stderr.trim().split('\n').slice(-3).join('\n')) };
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ error: `worker exited (${signal || code})` });
    }
    pending.clear();
  });
  const request = (op: string, args: Record<string, unknown> = {}, timeoutMs = 0) =>
    new Promise<WorkerReply>((resolve) => {
      if (exited) return resolve({ error: `worker exited (${exited.signal || exited.code})` });
      const id = ++seq;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            resolve({ error: 'timeout' });
          }, timeoutMs)
        : undefined;
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  const ready = request('init', { sha, repo, tsPath, tsconfig });
  return { child, sha, ready, request, exited: () => exited, kill: () => child.kill('SIGKILL') };
}

type Repo = { path: string; tsconfig?: string };
type LangOptions = { REPO: string; config?: Config; tsPath?: string; tsconfig?: string; timeoutMs?: number; idleMs?: number; maxOldSpaceMB?: number };

const hasCommit = (repo: string, sha: string) => new Promise<boolean>((resolve) => execFile('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], (err) => resolve(!err)));

export function createLang({ REPO, config, tsPath, tsconfig = config?.repo?.tsconfig, timeoutMs = 3000, idleMs = 15 * 60 * 1000, maxOldSpaceMB = 4096 }: LangOptions) {
  const main: Repo = { path: REPO, tsconfig };
  // the repo holding the sha: the default one first, then the other configured repos
  const shaRepos = new Map<string, Repo>();
  async function repoOfSha(sha: string): Promise<Repo> {
    const known = shaRepos.get(sha);
    if (known) return known;
    for (const r of [main, ...(config?.repos || []).filter((x) => x.path && x.path !== REPO)]) {
      if (!(await hasCommit(r.path, sha))) continue;
      shaRepos.set(sha, r);
      return r;
    }
    return main;
  }
  let w: Worker | null = null;
  let status = 'idle';
  let initResult: unknown = null;
  let lastError: string | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  const crashed = new Map<string, { at: number; error: string | undefined }>();

  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, idleMs);
    idleTimer.unref?.();
  };

  function shutdown() {
    clearTimeout(idleTimer);
    if (w) w.kill();
    w = null;
    status = 'idle';
    initResult = null;
  }

  function ensure(sha: string | undefined, repo: Repo = main): Promise<WorkerReply> {
    if (!sha || !SHA_RE.test(sha)) throw Object.assign(new Error('bad sha'), { code: 400 });
    if (!repo.path) return Promise.resolve({ error: 'no repo configured (repo.path)' });
    touch();
    if (w && w.sha === sha && !w.exited()) return w.ready;
    const crash = crashed.get(sha);
    if (crash && Date.now() - crash.at < CRASH_COOLDOWN) return Promise.resolve({ error: crash.error });
    if (w) w.kill();
    const worker = startWorker({ repo: repo.path, sha, tsPath, tsconfig: repo.tsconfig, maxOldSpaceMB });
    w = worker;
    status = 'indexing';
    initResult = null;
    worker.ready.then((r) => {
      if (w !== worker) return;
      if (r.error) {
        status = 'error';
        lastError = r.error;
        crashed.set(sha, { at: Date.now(), error: r.error });
        worker.kill();
        w = null;
      } else {
        status = 'ready';
        initResult = r.result;
      }
    });
    worker.child.on('exit', () => {
      if (w !== worker || status !== 'ready') return;
      const ex = worker.exited();
      if (!ex) return;
      lastError = `worker exited (${ex.signal || ex.code})${ex.stderr ? `: ${ex.stderr}` : ''}`;
      crashed.set(sha, { at: Date.now(), error: lastError });
      status = 'error';
      w = null;
    });
    return worker.ready;
  }

  async function stats() {
    const base = { status, sha: w?.sha ?? null, init: initResult, lastError };
    if (!w || status !== 'ready') return base;
    const r = await w.request('stats', {}, timeoutMs);
    return { ...base, ...(r.error ? { statsError: r.error } : r.result && typeof r.result === 'object' ? r.result : {}) };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const url = new URL(req.url || '/', 'http://x');
    const q = Object.fromEntries(url.searchParams);
    if (parts[1] === 'lang' && parts[2] === 'stats') return send(res, 200, await stats());
    const [, scope, , op] = parts;
    if (scope !== 'pr' || !['definition', 'references', 'hover', 'open'].includes(op)) return send(res, 404, { error: 'no route' });
    if (!SHA_RE.test(q.sha || '')) return send(res, 400, { error: 'sha required' });
    if (!q.path || q.path.startsWith('/') || q.path.split('/').includes('..')) return send(res, 400, { error: 'bad path' });
    const ready = ensure(q.sha, await repoOfSha(q.sha));
    if (status === 'indexing') return send(res, 202, { status: 'indexing' });
    const init = await ready;
    if (init.error) return send(res, 200, { error: init.error });
    if (!w) return send(res, 200, { error: 'worker not running' });
    if (op === 'open') {
      w.request('open', { path: q.path });
      return send(res, 202, { status: 'queued' });
    }
    const line = Number(q.line);
    const col = Number(q.col);
    if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) return send(res, 400, { error: 'line and col required (1-based)' });
    const r = await w.request(op, { path: q.path, line, col }, timeoutMs);
    if (r.error) return send(res, r.error.startsWith('unknown path') ? 404 : 200, { error: r.error });
    return send(res, 200, { result: r.result });
  }

  return { handle, ensure, stats, shutdown, status: () => status };
}
