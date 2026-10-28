// Screenshots of coco's own pages (and local dev servers) for agents and scripts: one headless Chrome, launched on first use and driven over CDP,
// a fresh tab per capture, closed after IDLE_MS without one and when the server exits. Paseo's browser tabs do not paint in the background.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Res, Send } from './core-types.ts';

const IDLE_MS = 5 * 60 * 1000;
const CMD_MS = 30_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_ERRORS = 30;

export type ShotOptions = { url: string; width?: number; height?: number; waitMs?: number; selector?: string; eval?: string; colorScheme?: 'light' | 'dark' };
export type Shot = { png: Buffer; url: string; width: number; height: number; errors: string[]; evalResult?: unknown };
type Msg = { id?: number; method?: string; sessionId?: string; params?: Record<string, any>; result?: Record<string, any>; error?: { message: string } };
type Browser = { proc: ChildProcess; dir: string; send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, any>>; on(fn: (m: Msg) => void): () => void; close(): void };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: unknown, min: number, max: number, dflt: number) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.min(max, Math.max(min, Math.round(Number(v)))) : dflt);

// a full URL, or a path on coco itself ("#/work/<slug>/<tab>", "/#/…"); only coco's origin, loopback hosts (any port, *.localhost) and the configured hosts
export function resolveTarget(target: string, origin: string, hosts: string[] = []): { url: string } | { error: string } {
  const t = String(target || '').trim();
  if (!t) return { error: 'url required: a full URL or a coco path like #/work/<slug>/<tab>' };
  let u: URL;
  try {
    u = new URL(t.startsWith('#') ? `/${t}` : t, origin);
  } catch {
    return { error: `not a url: ${t}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: `only http(s) pages: ${u.protocol}` };
  const host = u.hostname.toLowerCase();
  const allowed = LOOPBACK.has(host) || host.endsWith('.localhost') || u.host === new URL(origin).host || hosts.some((h) => h.toLowerCase() === host || h.toLowerCase() === u.host);
  return allowed ? { url: u.href } : { error: `host not allowed: ${u.host} (coco, localhost dev servers and screenshot.hosts only)` };
}

async function launch(chromePath: string): Promise<Browser> {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath}: install Google Chrome or set screenshot.chrome in coco.config.json`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-shot-'));
  const proc = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.on('exit', () => fs.rm(dir, { recursive: true, force: true }, () => {}));
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not open its DevTools port within 15s')), 15_000);
    const fail = (e: Error) => {
      clearTimeout(timer);
      proc.kill();
      reject(e);
    };
    proc.on('error', fail);
    proc.on('exit', (code) => fail(new Error(`Chrome exited (${code}) before DevTools: ${err.slice(-400)}`)));
    proc.stderr?.on('data', (c: Buffer) => {
      err += c;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cannot reach Chrome DevTools')), { once: true });
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (r: Record<string, any>) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(m: Msg) => void>();
  ws.addEventListener('message', (e) => {
    const m: Msg = JSON.parse(String(e.data));
    const p = m.id ? pending.get(m.id) : undefined;
    if (p) {
      pending.delete(m.id!);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result || {});
    } else if (m.method) listeners.forEach((fn) => fn(m));
  });
  ws.addEventListener('close', () => {
    pending.forEach((p) => p.reject(new Error('Chrome went away')));
    pending.clear();
  });
  return {
    proc,
    dir,
    send(method, params = {}, sessionId) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, CMD_MS);
        const done = <T>(fn: (v: T) => void) => (v: T) => {
          clearTimeout(timer);
          fn(v);
        };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      try {
        ws.close();
      } catch {}
      proc.kill();
    },
  };
}

function consoleLine(m: Msg): string | null {
  const p = m.params || {};
  if (m.method === 'Runtime.exceptionThrown') return `exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || ''}`;
  if (m.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) return `console.${p.type}: ${(p.args || []).map((a: { value?: unknown; description?: string }) => (typeof a.value === 'string' ? a.value : a.description ?? JSON.stringify(a.value))).join(' ')}`;
  if (m.method === 'Log.entryAdded' && p.entry?.level === 'error') return `${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`;
  return null;
}

export function createScreenshots({ chromePath, origin, hosts = [], idleMs = IDLE_MS }: { chromePath: string; origin: string; hosts?: string[]; idleMs?: number }) {
  let browser: Promise<Browser> | null = null;
  let live: Browser | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let busy = 0;
  let hooked = false;

  // synchronous, so it also runs from the exit hook
  function stop() {
    live?.close();
    live = null;
    browser = null;
  }
  function ensure() {
    if (!hooked) {
      hooked = true;
      process.once('exit', stop);
      // kill Chrome, then let the signal do what it does by default
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => (stop(), process.kill(process.pid, sig)));
    }
    if (!browser) {
      const p = launch(chromePath).then((b) => {
        live = b;
        b.proc.on('exit', () => live === b && stop());
        return b;
      });
      p.catch(() => browser === p && (browser = null));
      browser = p;
    }
    return browser;
  }

  async function capture(opts: ShotOptions): Promise<Shot> {
    const target = resolveTarget(opts.url, origin, hosts);
    if ('error' in target) throw new HttpError(400, target.error);
    const width = clamp(opts.width, 200, 4000, 1600);
    const height = clamp(opts.height, 200, 4000, 1000);
    const waitMs = clamp(opts.waitMs, 0, 30_000, 2000);
    busy++;
    if (idle) clearTimeout(idle);
    try {
      const b = await ensure();
      const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
      const errors: string[] = [];
      let off = () => {};
      try {
        const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
        off = b.on((m) => {
          const line = m.sessionId === sessionId ? consoleLine(m) : null;
          if (line && errors.length < MAX_ERRORS) errors.push(line.slice(0, 500));
        });
        const s = (method: string, params?: Record<string, unknown>) => b.send(method, params, sessionId);
        const evaluate = async (expression: string) => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
        const until = async (expression: string, ms: number) => {
          for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await evaluate(expression).catch(() => false)) return true;
          return false;
        };
        await Promise.all([s('Runtime.enable'), s('Log.enable'), s('Page.enable')]);
        await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        if (opts.colorScheme) await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.colorScheme }] });
        const nav = await s('Page.navigate', { url: target.url });
        if (nav.errorText) throw new Error(`cannot open ${target.url}: ${nav.errorText}`);
        await until('document.readyState === "complete"', 10_000);
        await sleep(waitMs);
        const sel = opts.selector ? JSON.stringify(opts.selector) : '';
        if (sel && !(await until(`!!document.querySelector(${sel})`, 15_000))) throw new HttpError(422, `selector ${opts.selector} not found within 15s`);
        let evalResult: unknown;
        if (opts.eval) {
          const r = await s('Runtime.evaluate', { expression: opts.eval, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) errors.push(`eval: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`.slice(0, 500));
          else evalResult = r.result?.value;
          await sleep(800);
        }
        const rect = sel ? await evaluate(`(() => { const r = document.querySelector(${sel}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`) : null;
        const clip = rect && rect.width > 0 && rect.height > 0 ? { ...rect, scale: 1 } : null;
        const { data } = await s('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
        return { png: Buffer.from(String(data), 'base64'), url: target.url, width: clip ? Math.round(clip.width) : width, height: clip ? Math.round(clip.height) : height, errors, ...(evalResult === undefined ? {} : { evalResult }) };
      } finally {
        off();
        b.send('Target.closeTarget', { targetId }).catch(() => {});
      }
    } finally {
      if (--busy === 0) idle = setTimeout(stop, idleMs).unref();
    }
  }

  // GET /api/screenshot?url=&w=&h=&waitMs=&selector=&eval=&colorScheme=  → image/png (X-Console-Errors: count); &json=1 → { png: base64, errors, … }
  async function handle(res: Res, url: URL, send: Send) {
    const q = url.searchParams;
    const scheme = q.get('colorScheme');
    try {
      const shot = await capture({ url: q.get('url') || '', width: Number(q.get('w') || q.get('width')) || undefined, height: Number(q.get('h') || q.get('height')) || undefined, waitMs: q.has('waitMs') ? Number(q.get('waitMs')) : undefined, selector: q.get('selector') || undefined, eval: q.get('eval') || undefined, colorScheme: scheme === 'dark' || scheme === 'light' ? scheme : undefined });
      if (q.has('json')) return send(res, 200, { ...shot, png: shot.png.toString('base64') });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Console-Errors': String(shot.errors.length) });
      return res.end(shot.png);
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { capture, handle, stop };
}
