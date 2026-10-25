// Navigation: one TypeScript language service worker (child process) for the last PR head used.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lang-worker.ts');
const SHA_RE = /^[0-9a-f]{40}$/;
const CRASH_COOLDOWN = 60000;

export function startWorker({ repo, sha, tsPath, tsconfig, maxOldSpaceMB = 4096 }) {
  const child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpaceMB}`, '--expose-gc', WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let exited = null;
  let stderr = '';
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
    p.resolve(msg.error ? { error: msg.error } : { result: msg.result });
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal, stderr: stderr.trim().split('\n').slice(-3).join('\n') };
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ error: `worker exited (${signal || code})` });
    }
    pending.clear();
  });
  const request = (op, args = {}, timeoutMs = 0) =>
    new Promise((resolve) => {
      if (exited) return resolve({ error: `worker exited (${exited.signal || exited.code})` });
      const id = ++seq;
      const timer = timeoutMs
        ? setTimeout(() => {
            pending.delete(id);
            resolve({ error: 'timeout' });
          }, timeoutMs)
        : null;
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  const ready = request('init', { sha, repo, tsPath, tsconfig });
  return { child, sha, ready, request, exited: () => exited, kill: () => child.kill('SIGKILL') };
}

export function createLang({ REPO, config, tsPath, tsconfig = config?.repo?.tsconfig, timeoutMs = 3000, idleMs = 15 * 60 * 1000, maxOldSpaceMB = 4096 }) {
  let w = null;
  let status = 'idle';
  let initResult = null;
  let lastError = null;
  let idleTimer = null;
  const crashed = new Map();

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

  function ensure(sha) {
    if (!SHA_RE.test(sha || '')) throw Object.assign(new Error('bad sha'), { code: 400 });
    if (!REPO) return Promise.resolve({ error: 'no repo configured (repo.path)' });
    touch();
    if (w && w.sha === sha && !w.exited()) return w.ready;
    const crash = crashed.get(sha);
    if (crash && Date.now() - crash.at < CRASH_COOLDOWN) return Promise.resolve({ error: crash.error });
    if (w) w.kill();
    const worker = startWorker({ repo: REPO, sha, tsPath, tsconfig, maxOldSpaceMB });
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
    return { ...base, ...(r.error ? { statsError: r.error } : r.result) };
  }

  async function handle(req, res, parts, readBody, send) {
    const url = new URL(req.url, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    if (parts[1] === 'lang' && parts[2] === 'stats') return send(res, 200, await stats());
    const [, scope, , op] = parts;
    if (scope !== 'pr' || !['definition', 'references', 'hover', 'open'].includes(op)) return send(res, 404, { error: 'no route' });
    if (!SHA_RE.test(q.sha || '')) return send(res, 400, { error: 'sha required' });
    if (!q.path || q.path.startsWith('/') || q.path.split('/').includes('..')) return send(res, 400, { error: 'bad path' });
    const ready = ensure(q.sha);
    if (status === 'indexing') return send(res, 202, { status: 'indexing' });
    const init = await ready;
    if (init.error) return send(res, 200, { error: init.error });
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
