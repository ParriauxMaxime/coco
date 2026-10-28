// The plan page's dev servers: the dev-servers plugin's HTTP API proxied same-origin, each stack row mapped to the worktree that has its branch,
// the server serving it, and a coco holder of its own ({ kind: 'coco', id: '<work>/<row>' }). The plugin being down reads as "off", never as an error.
import { execFile } from 'node:child_process';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { keyLabel, rowKey } from './stack.ts';
import type { Jobs } from './jobs.ts';

type RowKey = number | string;
type StackRow = { number?: number | null; planned?: { branch?: string } };
type Work = { slug: string; title?: string; stack?: StackRow[] };
type ExecResult = { ok: boolean; stdout: string; stderr: string };
type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;
type DevServersConfig = { devServers?: { api?: { bind?: string; port?: number }; projects?: { warm?: { clone?: string[] } }[] } } | null;
type Lease = { kind: string; holderId: string | null };
type PluginServer = { running: boolean; state?: string; buildSeconds?: number; lastError?: string; leases: Lease[]; worktree: { path: string; branch?: string | null } };
type Placement = { mode: string; servedFrom: string; because: string[] };
type ApiBody = { servers?: PluginServer[]; prebuilds?: { worktree: string }[]; placement?: Placement; error?: { code?: string; message?: string; details?: Record<string, unknown> } };
type Reply = { status: number; body?: ApiBody } | { down: string };
type Holder = { kind: 'coco'; id: string; title: string };
type Row = { key: RowKey; label: string; branch: string | null; worktree: string | null; holder: Holder };
type Send = (res: ServerResponse, status: number, body: unknown) => unknown;

const LOOPBACK = new Set<string | null>(['127.0.0.1', 'localhost', '[::1]', '::1']);
const READ_TIMEOUT_MS = 2500;
const BOARD_FRESH_MS = 3000;
const BOARD_KEEP_MS = 60000;
const PLACEMENT_FRESH_MS = 10000;
// a start may first stop another server (its grace period), and a login waits for the project's provider (60 s by default)
const ACTION_TIMEOUT_MS = 65000;
const MAX_LOG_LINES = 200;
const SERVER_ID = /^[\w-]{1,80}$/;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const hostnameOf = (value: string, withScheme: boolean) => {
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
};

// coco itself has no auth: refuse what a web page on another site, a rebound DNS name or a form post could send through it
export function refusal(req: { headers: IncomingHttpHeaders; method?: string }) {
  if (!LOOPBACK.has(hostnameOf(req.headers.host || '', false))) return 'Host is not a loopback address';
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK.has(hostnameOf(origin, true))) return `Origin ${origin} is not a loopback origin`;
  if (req.method === 'POST' && (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return 'send the body as Content-Type: application/json';
  return null;
}

export const apiBase = (config?: DevServersConfig) => {
  const { bind = '127.0.0.1', port = 8779 } = config?.devServers?.api || {};
  return `http://${bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind}:${port}`;
};

export function parseWorktrees(porcelain: string) {
  const byBranch = new Map<string, string>();
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const wt = lines.find((l: string) => l.startsWith('worktree '));
    const br = lines.find((l: string) => l.startsWith('branch refs/heads/'));
    if (wt && br) byBranch.set(br.slice('branch refs/heads/'.length).trim(), wt.slice('worktree '.length).trim());
  }
  return byBranch;
}

const samePath = (a?: string | null, b?: string | null) => !!a && !!b && path.resolve(a) === path.resolve(b);

type DevServersOptions = {
  REPO?: string;
  config?: DevServersConfig;
  works: { get(slug: string): Work | null | undefined; prInfo(number: number): Promise<{ head?: string | null } | null> };
  exec?: Exec;
  fetchImpl?: typeof fetch;
  timeouts?: { read?: number; action?: number };
  jobs?: Pick<Jobs, 'wrap'>;
};

export function createDevServers({ REPO, config, works, exec = defaultExec, fetchImpl = fetch, timeouts = {}, jobs }: DevServersOptions) {
  const base = apiBase(config);
  const { read: READ_MS = READ_TIMEOUT_MS, action: ACTION_MS = ACTION_TIMEOUT_MS } = timeouts;

  // never forwards the browser's headers: the plugin sees a request from coco with no Origin, so its own guard still holds
  async function call(method: string, route: string, body: unknown, timeout: number): Promise<Reply> {
    try {
      const res = await fetchImpl(new URL(route, base), {
        method,
        ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { down: `${base} answered ${res.status} without JSON: is something else on that port?` };
      }
    } catch (e) {
      return { down: e instanceof Error && e.name === 'TimeoutError' ? `${base} did not answer within ${timeout} ms` : `nothing answers on ${base}` };
    }
  }

  const holderOf = (work: Work, key: RowKey): Holder => ({ kind: 'coco', id: `${work.slug}/${key}`, title: `coco: ${work.title || work.slug} ${keyLabel(key)}` });

  async function rowsOf(work: Work): Promise<Row[]> {
    const listed = REPO ? await exec('git', ['-C', REPO, 'worktree', 'list', '--porcelain']) : null;
    const worktrees = listed?.ok ? parseWorktrees(listed.stdout) : new Map<string, string>();
    return Promise.all(
      (work.stack || [])
        .map((s) => ({ s, key: rowKey(s) }))
        .filter((r): r is { s: StackRow; key: RowKey } => Boolean(r.key))
        .map(async ({ s, key }) => {
        const pr = s.number ? await works.prInfo(s.number).catch(() => null) : null;
        const branch = pr?.head || s.planned?.branch || null;
        return { key, label: keyLabel(key), branch, worktree: (branch && worktrees.get(branch)) || null, holder: holderOf(work, key) };
      }),
    );
  }

  // the server a row holds (maybe its stack top's), else the one of its own worktree; `mine` is relative to the row's holder
  function serverFor(row: Pick<Row, 'branch' | 'worktree' | 'holder'>, servers: PluginServer[]) {
    const mine = (lease: Lease) => lease.kind === 'coco' && lease.holderId === row.holder.id;
    const server =
      servers.find((s) => s.running && s.leases.some(mine)) ||
      (row.worktree && servers.find((s) => samePath(s.worktree.path, row.worktree))) ||
      (row.branch && servers.find((s) => s.running && s.worktree.branch === row.branch)) ||
      null;
    return server && { ...server, leases: server.leases.map((lease) => ({ ...lease, mine: mine(lease) })) };
  }

  // every open view polls the board: one call per few seconds serves them all, and a slow answer keeps the last good board
  let lastBoard: { at: number; reply: Reply } | null = null;
  let boardCall: Promise<Reply> | null = null;
  const boardReply = async (): Promise<Reply> => {
    if (lastBoard && Date.now() - lastBoard.at < BOARD_FRESH_MS) return lastBoard.reply;
    boardCall ??= call('GET', '/api/board', undefined, READ_MS).finally(() => (boardCall = null));
    const reply = await boardCall;
    if (!('down' in reply) && reply.status === 200) lastBoard = { at: Date.now(), reply };
    else if (lastBoard && Date.now() - lastBoard.at < BOARD_KEEP_MS) return lastBoard.reply;
    return reply;
  };
  const up = async () => {
    const reply = await boardReply();
    return !('down' in reply) && reply.status === 200;
  };

  // placement walks git over the stack: asked per worktree at most once per few seconds, the last good answer kept when one is slow
  const placements = new Map<string, { at: number; placement: Placement }>();
  const placementOf = async (worktree: string): Promise<Placement | null> => {
    const hit = placements.get(worktree);
    if (hit && Date.now() - hit.at < PLACEMENT_FRESH_MS) return hit.placement;
    const reply = await call('GET', `/api/placement?cwd=${encodeURIComponent(worktree)}`, undefined, READ_MS);
    const placement = !('down' in reply) && reply.status === 200 && reply.body?.placement?.mode ? reply.body.placement : null;
    if (placement) placements.set(worktree, { at: Date.now(), placement });
    return placement || (hit && Date.now() - hit.at < BOARD_KEEP_MS ? hit.placement : null);
  };

  // one brief line: what dev_server_start gives an agent in this worktree right now
  async function lineFor(worktree: string): Promise<string | null> {
    const reply = await boardReply();
    if ('down' in reply || reply.status !== 200 || !reply.body?.servers) return null;
    const placement = await placementOf(worktree);
    const from = placement?.servedFrom || worktree;
    const server = reply.body.servers.find((s) => samePath(s.worktree.path, from));
    const where = samePath(from, worktree) ? 'this worktree' : `\`${path.basename(from)}\`, the top of its stack`;
    if (server?.running && server.state && ['ready', 'idle', 'external'].includes(server.state)) return `- Right now: a server for ${where} already runs (${server.state}); \`dev_server_start\` reuses it in seconds.`;
    if (server?.running) return `- Right now: the server for ${where} is building; \`dev_server_start\` joins it, then \`dev_server_status\` until ready.`;
    if ((reply.body.prebuilds || []).some((p) => samePath(p.worktree, from))) return `- Right now: the warm build of ${where} is queued; a start now builds cold.`;
    if (server?.buildSeconds !== undefined) return `- Right now: ${where} has a warm build (built in ${server.buildSeconds} s); a start only boots it.`;
    return `- Right now: no build of ${where} yet; a first start builds cold, several minutes.`;
  }

  // a build a hand-run server left behind: the plugin never saw it, yet a start reuses it
  const clonePaths = (config?.devServers?.projects || []).flatMap((p) => p.warm?.clone || []);
  const cacheOnDisk = (worktree: string) => clonePaths.length > 0 && clonePaths.every((p) => fs.existsSync(path.join(worktree, p)));

  async function workView(work: Work) {
    const reply = await boardReply();
    if ('down' in reply) return { on: false, reason: reply.down };
    const board = reply.body;
    if (reply.status !== 200 || !board || !Array.isArray(board.servers)) return { on: false, reason: reply.body?.error?.message || `the dev servers API answered ${reply.status}` };
    const servers: PluginServer[] = board.servers;
    const queue: { worktree: string }[] = board.prebuilds || [];
    const rows = await Promise.all((await rowsOf(work)).map(async ({ holder, ...row }) => {
      const placement = row.worktree ? await placementOf(row.worktree) : null;
      // a row with no server of its own rides the stack top's when that one runs: what an agent starting here gets
      const shared = placement && !samePath(placement.servedFrom, row.worktree) ? servers.find((s) => s.running && samePath(s.worktree.path, placement.servedFrom)) : null;
      const own = serverFor({ ...row, holder }, servers);
      const server = (!own?.running && shared && { ...shared, leases: shared.leases.map((lease) => ({ ...lease, mine: false })) }) || own || null;
      const queued = row.worktree ? queue.findIndex((p) => samePath(p.worktree, row.worktree)) : -1;
      return { ...row, holderId: holder.id, server, servedFrom: server && row.worktree && !samePath(server.worktree.path, row.worktree) ? server.worktree.path : null, placement, prebuildQueued: queued < 0 ? null : queued, cacheOnDisk: row.worktree ? cacheOnDisk(row.worktree) : false };
    }));
    return { on: true, board, rows };
  }

  const relay = (send: Send, res: ServerResponse, reply: Reply) => {
    if ('down' in reply) return send(res, 503, { error: `dev servers off: ${reply.down}`, code: 'dev_servers_off' });
    if (reply.status >= 400) {
      const { code, message, details } = reply.body?.error || {};
      return send(res, reply.status, { error: message || `the dev servers API answered ${reply.status}`, code: code || null, ...(details && { details }) });
    }
    return send(res, 200, reply.body);
  };

  async function rowAction(work: Work, key: string, action: string, body: Record<string, unknown>): Promise<Reply | { status: number; error: string }> {
    const row = (await rowsOf(work)).find((r) => String(r.key) === key);
    if (!row) return { status: 404, error: `${key} is not a row of ${work.slug}` };
    const holder = row.holder;
    if (action === 'start') {
      if (!row.worktree) return { status: 409, error: `${row.branch || row.label} is not checked out in a worktree: create its workspace first` };
      return call('POST', '/api/servers/start', { cwd: row.worktree, holder, ...(body.dedicated === true && { dedicated: true }) }, ACTION_MS);
    }
    if (action === 'warm') {
      if (!row.worktree) return { status: 409, error: `${row.branch || row.label} is not checked out in a worktree` };
      lastBoard = null;
      return call('POST', '/api/prebuilds', { cwd: row.worktree }, ACTION_MS);
    }
    const id = String(body.serverId || '');
    if (!SERVER_ID.test(id)) return { status: 400, error: 'serverId required' };
    if (action === 'stop') return call('POST', `/api/servers/${id}/stop`, { force: body.force === true, holder }, ACTION_MS);
    if (action === 'pin') return call('POST', `/api/servers/${id}/pin`, { pinned: body.pinned !== false, holder }, ACTION_MS);
    return { status: 404, error: `no row action ${action}` };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, parts: string[], readBody: (req: IncomingMessage) => Promise<string>, send: Send) {
    try {
      const refused = refusal(req);
      if (refused) return send(res, 403, { error: refused });
      const [, a, b, c, d, e] = parts;
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (a === 'board' && req.method === 'GET') {
        const reply = await call('GET', '/api/board', undefined, READ_MS);
        return send(res, 200, 'down' in reply ? { on: false, reason: reply.down } : { on: reply.status === 200, board: reply.body });
      }
      if (a === 'works' && b) {
        const work = works.get(b);
        if (!work) return send(res, 404, { error: 'no such work' });
        if (!c && req.method === 'GET') return send(res, 200, await workView(work));
        if (c === 'rows' && d && e && req.method === 'POST') {
          const key = decodeURIComponent(d);
          const act = () => rowAction(work, key, e, body);
          // start and stop are jobs: a refused or failed call fails it with the plugin's answer
          const reply = jobs && (e === 'start' || e === 'stop')
            ? await jobs.wrap({ work: work.slug, pr: key, action: `dev-server:${e}`, label: `${e === 'start' ? 'Start' : 'Stop'} dev server ${keyLabel(key)}`, kind: 'command' }, async () => {
              const r = await act();
              if ('error' in r) throw Object.assign(new Error(r.error), { reply: r });
              if ('down' in r) throw Object.assign(new Error(r.down), { reply: r });
              if (r.status >= 400) throw Object.assign(new Error(`the dev-server plugin answered ${r.status}`), { reply: r });
              return r;
            }).catch((err: { reply?: Awaited<ReturnType<typeof act>> }) => err.reply ?? Promise.reject(err))
            : await act();
          return 'error' in reply ? send(res, reply.status, { error: reply.error }) : relay(send, res, reply);
        }
      }
      if (a === 'servers' && b && SERVER_ID.test(b)) {
        if (c === 'login' && req.method === 'POST') {
          const page = typeof body.path === 'string' && body.path.startsWith('/') ? { path: body.path } : {};
          return relay(send, res, await call('POST', `/api/servers/${b}/login`, page, ACTION_MS));
        }
        if (c === 'logs' && req.method === 'GET') {
          const asked = Number(new URL(req.url || '/', 'http://local').searchParams.get('lines')) || 60;
          const lines = Math.min(Math.max(1, Math.floor(asked)), MAX_LOG_LINES);
          return relay(send, res, await call('GET', `/api/servers/${b}/logs?lines=${lines}&touch=false`, undefined, READ_MS));
        }
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, 500, { error: String(e instanceof Error ? e.message || e : e) });
    }
  }

  return { handle, workView, rowsOf, up, lineFor };
}
