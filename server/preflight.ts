// Preflight: before a kit-video dispatch starts its agent, cheap checks of what the demo needs (worktree deps, dev server, MCP endpoints, LLM key, fixture probes).
// It only reports: nothing is fixed or started here. The card shows the result, the brief names the red checks as known blockers. Cached 60 s per work and PR.
// A key's value is never read into the result: only whether the env var or settings path holds something.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { expandHome } from './paseo-agent.ts';
import { keyLabel } from './stack.ts';
import type { PreflightConfig, RepoConfig } from './config.ts';
import type { RowKey, Work } from './core-types.ts';

export type PreflightCheck = { name: string; ok: boolean; detail: string; fix: string };
export type PreflightResult = { checks: PreflightCheck[]; at: string };

export const isVideoEntry = (entry: string) => entry.startsWith('gate:kit-video:');

const TTL_MS = 60_000;
const NET_MS = 2500;
const PROBE_MS = 15_000;
const DETAIL_MAX = 200;
const LEMLIST: PreflightConfig = {
  mcp: [{ name: 'lemlist-dev MCP', url: 'http://localhost:8000/mcp', fix: 'start the local app (dev_server_start) so :8000/mcp answers, or point the MCP at the port the dev server uses' }],
  settingsFile: 'lemapp/settings-local.json',
  llmKey: { env: ['ANTHROPIC_API_KEY'], paths: ['anthropic.apiKey', 'services.anthropic.apiKey'], fix: 'set the LLM key on the local server (settings-local.json or the env it starts with); never paste it in a chat or a brief' },
};

type Probe = { http(url: string): Promise<string | null>; tcp(host: string, port: number): Promise<string | null>; exec(argv: string[], o: { cwd: string; timeoutMs: number }): Promise<{ ok: boolean; output: string }> };
type ServerView = { state?: string; lastError?: string; port?: number } | null;
type Deps = {
  config: { repo: { path: string; github: string } };
  repoOf?: (work: Work) => (Pick<RepoConfig, 'path' | 'github'> & { settings?: { preflight?: PreflightConfig | null } }) | null | undefined;
  preflightOf?: (work: Work) => PreflightConfig | null | undefined;
  works: { get(slug: string): Work | null | undefined };
  // the dev-servers plugin's view of the work: each row with its worktree and the server serving it
  devServers: { workView(work: Work): Promise<{ on: boolean; reason?: string; rows?: { key: RowKey; worktree: string | null; server: ServerView }[] }> };
  // coco's readiness of a worktree, read without starting an install
  worktrees: { prepare(root: string, o: { retrying: boolean; start: boolean }): Promise<{ state: string; error?: string; deps: { path: string; mode: string }[] }> };
  env?: Record<string, string | undefined>;
  probe?: Partial<Probe>;
  now?: () => number;
  ttlMs?: number;
};

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
const errCode = (e: unknown) => {
  const c = (e as { cause?: { code?: string } })?.cause?.code || (e as { code?: string })?.code;
  return c || (e instanceof Error && e.name === 'TimeoutError' ? `no answer within ${NET_MS} ms` : e instanceof Error ? e.message : String(e));
};

const defaultProbe: Probe = {
  http: async (url) => {
    try {
      await fetch(url, { method: 'GET', signal: AbortSignal.timeout(NET_MS) });
      return null;
    } catch (e) {
      return oneLine(String(errCode(e)));
    }
  },
  tcp: (host, port) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port, timeout: NET_MS });
      s.once('connect', () => (s.destroy(), resolve(null)));
      s.once('timeout', () => (s.destroy(), resolve(`no answer within ${NET_MS} ms`)));
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code || e.message));
    }),
  exec: (argv, { cwd, timeoutMs }) =>
    new Promise((resolve) => {
      execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${stdout || ''} ${stderr || ''} ${err && !stdout && !stderr ? err.message : ''}` });
      });
    }),
};

// does the dotted path of a JSON file hold a non-empty value; the value itself never leaves this function
const holds = (file: string, dotted: string) => {
  try {
    let v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of dotted.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    return v !== undefined && v !== null && v !== '' && v !== false;
  } catch {
    return false;
  }
};

export function createPreflight({ config, repoOf, preflightOf, works, devServers, worktrees, env = process.env, probe = {}, now = Date.now, ttlMs = TTL_MS }: Deps) {
  const net_ = { ...defaultProbe, ...probe };
  const cache = new Map<string, { at: number; run: Promise<PreflightResult> }>();

  const settingsFor = (work: Work): PreflightConfig => {
    const repo = repoOf?.(work);
    const set = preflightOf?.(work) ?? repo?.settings?.preflight ?? null;
    const github = repo?.github || config.repo.github;
    return set ?? (/^lemlist\//i.test(github) ? LEMLIST : {});
  };

  async function compute(work: Work, key: RowKey): Promise<PreflightResult> {
    const cfg = settingsFor(work);
    const repoPath = expandHome(repoOf?.(work)?.path || config.repo.path);
    const checks: PreflightCheck[] = [];
    const view = await devServers.workView(work).catch((e) => ({ on: false, reason: e instanceof Error ? e.message : String(e), rows: undefined }));
    const row = view.rows?.find((r) => r.key === key);
    const wt = row?.worktree || null;
    const base = wt || repoPath;

    let depsInstalling = false;
    if (!wt) checks.push({ name: 'Worktree deps', ok: true, detail: `${keyLabel(key)} has no worktree yet: coco creates and readies it on start`, fix: '' });
    else {
      const r = await worktrees.prepare(wt, { retrying: true, start: false }).catch((e) => ({ state: 'failed', error: e instanceof Error ? e.message : String(e), deps: [] }));
      depsInstalling = r.state === 'preparing' || r.deps.some((d) => d.mode === 'installing');
      checks.push(
        r.state === 'off' || r.state === 'ready'
          ? { name: 'Worktree deps', ok: true, detail: r.state === 'off' ? 'coco readies no dependency folder in this repo' : 'dependencies ready', fix: '' }
          : { name: 'Worktree deps', ok: false, detail: r.state === 'preparing' ? 'coco is still installing the worktree\'s own dependencies' : oneLine(r.error || 'dependencies are not ready'), fix: r.state === 'preparing' ? 'wait for the install to end, then re-run the preflight' : 'ask the PR agent to call own_deps, or install in the worktree yourself' },
      );
    }

    const server = row?.server || null;
    checks.push(
      !view.on
        ? { name: 'Dev server', ok: true, detail: `not checked: ${oneLine(view.reason || 'dev servers plugin off')}`, fix: '' }
        : !server
          ? { name: 'Dev server', ok: true, detail: 'none running for this worktree: the agent starts one with dev_server_start', fix: '' }
          : server.state === 'crashed'
            ? { name: 'Dev server', ok: false, detail: `crashed${server.lastError ? `: ${oneLine(server.lastError)}` : ''}`, fix: 'restart it from the dev servers panel once the dependencies are ready' }
            : depsInstalling
              ? { name: 'Dev server', ok: false, detail: `${server.state || 'running'} while the node_modules are being swapped: it will crash or serve half-installed code`, fix: 'wait for the install to end, then restart the dev server' }
              : { name: 'Dev server', ok: true, detail: server.state || 'running', fix: '' },
    );

    for (const m of cfg.mcp || []) {
      let err: string | null;
      try {
        const u = new URL(m.url);
        err = u.protocol === 'tcp:' ? await net_.tcp(u.hostname, Number(u.port)) : await net_.http(m.url);
      } catch {
        err = `bad url ${m.url}`;
      }
      checks.push({ name: m.name, ok: !err, detail: err ? `${m.url}: ${err}` : `${m.url} answers`, fix: err ? m.fix || `start the service behind ${m.url}` : '' });
    }

    if (cfg.settingsFile) {
      const file = path.resolve(base, cfg.settingsFile);
      const ok = fs.existsSync(file);
      checks.push({ name: path.basename(cfg.settingsFile), ok, detail: ok ? `${cfg.settingsFile} exists` : `${cfg.settingsFile} is missing in ${wt ? 'the worktree' : 'the repo'}`, fix: ok ? '' : 'start the dev server once (it writes the file), or copy it from the main checkout' });
    }

    if (cfg.llmKey && (cfg.llmKey.env?.length || cfg.llmKey.paths?.length)) {
      const { env: names = [], paths = [], fix } = cfg.llmKey;
      const inEnv = names.find((n) => (env[n] ?? '') !== '');
      const file = cfg.settingsFile ? path.resolve(base, cfg.settingsFile) : '';
      const inFile = file ? paths.find((p) => holds(file, p)) : undefined;
      const where = inEnv ? `env ${inEnv}` : inFile ? `${cfg.settingsFile} (${inFile})` : '';
      checks.push({
        name: 'LLM key',
        ok: Boolean(where),
        detail: where ? `set in ${where}` : `not set in the server env (${names.join(', ') || 'none named'})${cfg.settingsFile ? ` nor ${cfg.settingsFile} (${paths.join(', ') || 'no path named'})` : ''}`,
        fix: where ? '' : fix || 'give the local server its LLM key; never paste it in a chat or a brief',
      });
    }

    for (const p of cfg.probes || []) {
      if (!p.command?.length) continue;
      const r = await net_.exec(p.command, { cwd: p.cwd ? path.resolve(base, p.cwd) : base, timeoutMs: (p.timeoutSeconds ?? PROBE_MS / 1000) * 1000 });
      checks.push({ name: p.name, ok: r.ok, detail: oneLine(r.output) || (r.ok ? 'ok' : 'failed'), fix: r.ok ? '' : p.fix || 'seed the fixture in the local database' });
    }
    return { checks, at: new Date(now()).toISOString() };
  }

  // one run per work and PR for ttlMs; `fresh` re-runs. A run that throws is not cached.
  function run(slug: string, key: RowKey, { fresh = false }: { fresh?: boolean } = {}): Promise<PreflightResult> {
    const work = works.get(slug);
    if (!work) return Promise.reject(new Error('no such work'));
    const id = `${slug}/${key}`;
    const hit = cache.get(id);
    if (!fresh && hit && now() - hit.at < ttlMs) return hit.run;
    const p = compute(work, key);
    cache.set(id, { at: now(), run: p });
    p.catch(() => cache.get(id)?.run === p && cache.delete(id));
    return p;
  }

  // the known-blockers section of the agent's first message, or '' when everything is green
  function briefLines(result: PreflightResult, skill: string): string[] {
    const red = result.checks.filter((c) => !c.ok);
    if (!red.length) return [];
    return [
      '## Known blockers',
      '',
      `coco's preflight found these red at dispatch (${result.at}). Do not rediscover them: for each beat they block, go straight to the \`${skill || 'demo video'}\` skill's "When a beat is blocked" ladder (substitute a real path or drop the beat, record it with \`demo.blocked\`, list it under Blocked in your reply). Never fix a credential or a key yourself.`,
      '',
      ...red.map((c) => `- ${c.name}: ${c.detail}${c.fix ? ` (to unblock, the owner: ${c.fix})` : ''}`),
    ];
  }

  return { run, briefLines };
}
export type Preflight = ReturnType<typeof createPreflight>;
