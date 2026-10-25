// The plan page's dev servers: the dev-servers plugin's HTTP API proxied same-origin, each stack row mapped to the worktree that has its branch,
// the server serving it, and a coco holder of its own ({ kind: 'coco', id: '<work>/<row>' }). The plugin being down reads as "off", never as an error.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { keyLabel, rowKey } from './stack.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const READ_TIMEOUT_MS = 2500;
// a start may first stop another server (its grace period), and a login waits for the project's provider (60 s by default)
const ACTION_TIMEOUT_MS = 65000;
const MAX_LOG_LINES = 200;
const SERVER_ID = /^[\w-]{1,80}$/;

const defaultExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const hostnameOf = (value, withScheme) => {
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
};

// coco itself has no auth: refuse what a web page on another site, a rebound DNS name or a form post could send through it
export function refusal(req) {
  if (!LOOPBACK.has(hostnameOf(req.headers.host || '', false))) return 'Host is not a loopback address';
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK.has(hostnameOf(origin, true))) return `Origin ${origin} is not a loopback origin`;
  if (req.method === 'POST' && (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return 'send the body as Content-Type: application/json';
  return null;
}

export const apiBase = (config) => {
  const { bind = '127.0.0.1', port = 8779 } = config?.devServers?.api || {};
  return `http://${bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind}:${port}`;
};

export function parseWorktrees(porcelain) {
  const byBranch = new Map();
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '));
    const br = lines.find((l) => l.startsWith('branch refs/heads/'));
    if (wt && br) byBranch.set(br.slice('branch refs/heads/'.length).trim(), wt.slice('worktree '.length).trim());
  }
  return byBranch;
}

const samePath = (a, b) => Boolean(a && b) && path.resolve(a) === path.resolve(b);

export function createDevServers({ REPO, config, works, exec = defaultExec, fetchImpl = fetch, timeouts = {} }) {
  const base = apiBase(config);
  const { read: READ_MS = READ_TIMEOUT_MS, action: ACTION_MS = ACTION_TIMEOUT_MS } = timeouts;

  // never forwards the browser's headers: the plugin sees a request from coco with no Origin, so its own guard still holds
  async function call(method, route, body, timeout) {
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
      return { down: e?.name === 'TimeoutError' ? `${base} did not answer within ${timeout} ms` : `nothing answers on ${base}` };
    }
  }

  const holderOf = (work, key) => ({ kind: 'coco', id: `${work.slug}/${key}`, title: `coco: ${work.title || work.slug} ${keyLabel(key)}` });

  async function rowsOf(work) {
    const listed = REPO ? await exec('git', ['-C', REPO, 'worktree', 'list', '--porcelain']) : { ok: false };
    const worktrees = listed.ok ? parseWorktrees(listed.stdout) : new Map();
    return Promise.all(
      (work.stack || []).filter(rowKey).map(async (s) => {
        const key = rowKey(s);
        const pr = s.number ? await works.prInfo(s.number).catch(() => null) : null;
        const branch = pr?.head || s.planned?.branch || null;
        return { key, label: keyLabel(key), branch, worktree: (branch && worktrees.get(branch)) || null, holder: holderOf(work, key) };
      }),
    );
  }

  // the server a row holds (maybe its stack top's), else the one of its own worktree; `mine` is relative to the row's holder
  function serverFor(row, servers) {
    const mine = (lease) => lease.kind === 'coco' && lease.holderId === row.holder.id;
    const server =
      servers.find((s) => s.running && s.leases.some(mine)) ||
      (row.worktree && servers.find((s) => samePath(s.worktree.path, row.worktree))) ||
      (row.branch && servers.find((s) => s.running && s.worktree.branch === row.branch)) ||
      null;
    return server && { ...server, leases: server.leases.map((lease) => ({ ...lease, mine: mine(lease) })) };
  }

  async function workView(work) {
    const reply = await call('GET', '/api/board', undefined, READ_MS);
    if (reply.down) return { on: false, reason: reply.down };
    if (reply.status !== 200 || !Array.isArray(reply.body?.servers)) return { on: false, reason: reply.body?.error?.message || `the dev servers API answered ${reply.status}` };
    const board = reply.body;
    const rows = (await rowsOf(work)).map(({ holder, ...row }) => {
      const server = serverFor({ ...row, holder }, board.servers);
      return { ...row, holderId: holder.id, server, servedFrom: server && row.worktree && !samePath(server.worktree.path, row.worktree) ? server.worktree.path : null };
    });
    return { on: true, board, rows };
  }

  const relay = (send, res, reply) => {
    if (reply.down) return send(res, 503, { error: `dev servers off: ${reply.down}`, code: 'dev_servers_off' });
    if (reply.status >= 400) {
      const { code, message, details } = reply.body?.error || {};
      return send(res, reply.status, { error: message || `the dev servers API answered ${reply.status}`, code: code || null, ...(details && { details }) });
    }
    return send(res, 200, reply.body);
  };

  async function rowAction(work, key, action, body) {
    const row = (await rowsOf(work)).find((r) => String(r.key) === key);
    if (!row) return { status: 404, error: `${key} is not a row of ${work.slug}` };
    const holder = row.holder;
    if (action === 'start') {
      if (!row.worktree) return { status: 409, error: `${row.branch || row.label} is not checked out in a worktree: create its workspace first` };
      return call('POST', '/api/servers/start', { cwd: row.worktree, holder, ...(body.dedicated === true && { dedicated: true }) }, ACTION_MS);
    }
    const id = String(body.serverId || '');
    if (!SERVER_ID.test(id)) return { status: 400, error: 'serverId required' };
    if (action === 'stop') return call('POST', `/api/servers/${id}/stop`, { force: body.force === true, holder }, ACTION_MS);
    if (action === 'pin') return call('POST', `/api/servers/${id}/pin`, { pinned: body.pinned !== false, holder }, ACTION_MS);
    return { status: 404, error: `no row action ${action}` };
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      const refused = refusal(req);
      if (refused) return send(res, 403, { error: refused });
      const [, a, b, c, d, e] = parts;
      const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
      if (a === 'board' && req.method === 'GET') {
        const reply = await call('GET', '/api/board', undefined, READ_MS);
        return send(res, 200, reply.down ? { on: false, reason: reply.down } : { on: reply.status === 200, board: reply.body });
      }
      if (a === 'works' && b) {
        const work = works.get(b);
        if (!work) return send(res, 404, { error: 'no such work' });
        if (!c && req.method === 'GET') return send(res, 200, await workView(work));
        if (c === 'rows' && d && e && req.method === 'POST') {
          const reply = await rowAction(work, decodeURIComponent(d), e, body);
          return reply.error ? send(res, reply.status, { error: reply.error }) : relay(send, res, reply);
        }
      }
      if (a === 'servers' && b && SERVER_ID.test(b)) {
        if (c === 'login' && req.method === 'POST') {
          const page = typeof body.path === 'string' && body.path.startsWith('/') ? { path: body.path } : {};
          return relay(send, res, await call('POST', `/api/servers/${b}/login`, page, ACTION_MS));
        }
        if (c === 'logs' && req.method === 'GET') {
          const asked = Number(new URL(req.url, 'http://local').searchParams.get('lines')) || 60;
          const lines = Math.min(Math.max(1, Math.floor(asked)), MAX_LOG_LINES);
          return relay(send, res, await call('GET', `/api/servers/${b}/logs?lines=${lines}&touch=false`, undefined, READ_MS));
        }
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) });
    }
  }

  return { handle, workView, rowsOf };
}
