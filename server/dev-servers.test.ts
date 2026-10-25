import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { apiBase, createDevServers, parseWorktrees } from './dev-servers.ts';

const WORK = {
  slug: 'widget-search',
  title: 'Widget search',
  stack: [{ number: 41 }, { number: 42 }, { planned: { branch: 'feat/widget-filters' } }],
};
const HEADS = { 41: 'feat/widget-index', 42: 'feat/widget-search' };
const WORKTREES = ['worktree /code/widgets', 'HEAD aaa', 'branch refs/heads/main', '', 'worktree /wt/widget-index', 'HEAD bbb', 'branch refs/heads/feat/widget-index', '', 'worktree /wt/widget-search', 'HEAD ccc', 'branch refs/heads/feat/widget-search', '', 'worktree /wt/detached', 'HEAD ddd', 'detached', ''].join('\n');

const lease = (over) => ({ id: 'ls_1', kind: 'agent', holderId: null, title: 'Fix the widget', agentId: 'agent-alice', mine: false, since: '2026-10-23T10:00:00.000Z', lastUsedAt: '2026-10-23T10:00:00.000Z', ...over });
const server = (over) => ({
  id: 'wt_search',
  project: 'widgets',
  worktree: { path: '/wt/widget-search', branch: 'feat/widget-search', head: 'ccc', dirty: false },
  port: 8110,
  url: 'http://127.0.0.1:8110',
  reserved: [8110],
  state: 'ready',
  stateSince: '2026-10-23T10:00:00.000Z',
  pinned: false,
  pinnedBy: null,
  optIns: { services: [], dedicatedDb: false, reason: null },
  leases: [],
  lastUsedAt: '2026-10-23T10:00:00.000Z',
  logs: { run: '/state/logs/wt_search/run.log' },
  running: true,
  canLogin: true,
  ...over,
});
const BOARD = {
  error: null,
  cap: 3,
  lost: [],
  servers: [
    server({ leases: [lease(), lease({ id: 'ls_2', kind: 'coco', holderId: 'widget-search/41', title: 'coco: Widget search #41' })] }),
    server({ id: 'wt_other', worktree: { path: '/wt/gadgets', branch: 'feat/gadgets', head: 'eee', dirty: false }, port: 8120 }),
  ],
};

const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const close = (srv) => new Promise((resolve) => (srv.listening ? srv.close(resolve) : resolve()));
const freePort = async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
};

// a stand-in for the plugin's HTTP API: records what coco sends, answers from `routes`
async function fakePlugin(routes = {}) {
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const route = routes[`${req.method} ${req.url.split('?')[0]}`];
    if (route === 'hang') return;
    const [status, body] = route ? route(entry) : [404, { error: { code: 'not_found', message: `no route ${req.url}` } }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return { port: await listen(srv), seen, close: () => close(srv) };
}

async function coco(pluginPort, { timeouts } = {}) {
  const works = { get: (slug) => (slug === WORK.slug ? structuredClone(WORK) : null), prInfo: async (n) => ({ number: n, head: HEADS[n] }) };
  const exec = async (cmd, args) => (cmd === 'git' && args.includes('worktree') ? { ok: true, stdout: WORKTREES, stderr: '' } : { ok: false, stdout: '', stderr: 'no' });
  const devServers = createDevServers({ REPO: '/code/widgets', config: { devServers: { api: { port: pluginPort } } }, works, exec, timeouts });
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => { let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => resolve(raw)); });
  const srv = http.createServer((req, res) => {
    const parts = new URL(req.url, 'http://local').pathname.split('/').filter(Boolean).slice(1);
    devServers.handle(req, res, parts, readBody, send);
  });
  const port = await listen(srv);
  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, port, close: () => close(srv) };
}

test('parseWorktrees keeps branch checkouts and skips detached ones; apiBase follows devServers.api', () => {
  assert.deepEqual([...parseWorktrees(WORKTREES)], [['main', '/code/widgets'], ['feat/widget-index', '/wt/widget-index'], ['feat/widget-search', '/wt/widget-search']]);
  assert.equal(apiBase({}), 'http://127.0.0.1:8779');
  assert.equal(apiBase({ devServers: { api: { bind: '::1', port: 9001 } } }), 'http://[::1]:9001');
});

test('the work view maps each row to its worktree and the server serving it, with mine relative to the row', async () => {
  const plugin = await fakePlugin({ 'GET /api/board': () => [200, BOARD] });
  const app = await coco(plugin.port);
  try {
    const { status, body } = await app.call('GET', `/api/dev-servers/works/${WORK.slug}`);
    assert.equal(status, 200);
    assert.equal(body.on, true);
    assert.equal(body.board.cap, 3);
    assert.deepEqual(
      body.rows.map(({ key, branch, worktree, holderId, server: s, servedFrom }) => [key, branch, worktree, holderId, s?.id ?? null, servedFrom]),
      [
        [41, 'feat/widget-index', '/wt/widget-index', 'widget-search/41', 'wt_search', '/wt/widget-search'],
        [42, 'feat/widget-search', '/wt/widget-search', 'widget-search/42', 'wt_search', null],
        ['b:feat:widget-filters', 'feat/widget-filters', null, 'widget-search/b:feat:widget-filters', null, null],
      ],
    );
    assert.deepEqual(body.rows[0].server.leases.map(({ mine }) => mine), [false, true]);
    assert.deepEqual(body.rows[1].server.leases.map(({ mine }) => mine), [false, false]);
    assert.equal((await app.call('GET', '/api/dev-servers/works/nope')).status, 404);
  } finally {
    await app.close();
    await plugin.close();
  }
});

test('row actions send the row worktree and a coco holder, never the browser Origin; logs never count as use', async () => {
  const ok = (extra = {}) => () => [200, { server: server(), next: 'ready at http://127.0.0.1:8110', ...extra }];
  const plugin = await fakePlugin({
    'POST /api/servers/start': ok({ placement: { mode: 'own', servedFrom: '/wt/widget-search', because: [] }, lease: { id: 'ls_9' } }),
    'POST /api/servers/wt_search/stop': ok({ stopped: false, kept: 'leased', swept: [], portsBusy: [] }),
    'POST /api/servers/wt_search/pin': ok(),
    'POST /api/servers/wt_search/login': () => [200, { id: 'wt_search', url: 'http://127.0.0.1:8110/', next: 'open it' }],
    'GET /api/servers/wt_search/logs': () => [200, { id: 'wt_search', source: 'run', file: '/x', lines: ['widgets ready'], truncated: true }],
  });
  const app = await coco(plugin.port);
  const holder = { kind: 'coco', id: 'widget-search/42', title: 'coco: Widget search #42' };
  const origin = { origin: 'http://127.0.0.1:8777' };
  try {
    assert.equal((await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/start`, {}, origin)).status, 200);
    assert.equal((await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/stop`, { serverId: 'wt_search', force: true }, origin)).status, 200);
    assert.equal((await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/pin`, { serverId: 'wt_search', pinned: false }, origin)).status, 200);
    assert.equal((await app.call('POST', '/api/dev-servers/servers/wt_search/login', { path: '/widgets' }, origin)).body.url, 'http://127.0.0.1:8110/');
    assert.deepEqual((await app.call('GET', '/api/dev-servers/servers/wt_search/logs?lines=9000')).body.lines, ['widgets ready']);
    assert.deepEqual(
      plugin.seen.map(({ method, url, body }) => [method, url, body]),
      [
        ['POST', '/api/servers/start', { cwd: '/wt/widget-search', holder }],
        ['POST', '/api/servers/wt_search/stop', { force: true, holder }],
        ['POST', '/api/servers/wt_search/pin', { pinned: false, holder }],
        ['POST', '/api/servers/wt_search/login', { path: '/widgets' }],
        ['GET', '/api/servers/wt_search/logs?lines=200&touch=false', undefined],
      ],
    );
    for (const { headers } of plugin.seen) {
      assert.equal(headers.origin, undefined);
      assert.equal(headers.host, `127.0.0.1:${plugin.port}`);
    }
    assert.equal(plugin.seen[0].headers['content-type'], 'application/json');

    const unchecked = await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/b%3Afeat%3Awidget-filters/start`, {});
    assert.deepEqual([unchecked.status, unchecked.body.error], [409, 'feat/widget-filters is not checked out in a worktree: create its workspace first']);
    assert.equal((await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/stop`, { serverId: '../board' })).status, 400);
    assert.equal(plugin.seen.length, 5);
  } finally {
    await app.close();
    await plugin.close();
  }
});

test('plugin errors come back as coco errors with their code', async () => {
  const plugin = await fakePlugin({
    'POST /api/servers/start': () => [409, { error: { code: 'capacity_full', message: 'every slot is pinned', details: { cap: 1 } } }],
  });
  const app = await coco(plugin.port);
  try {
    const reply = await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/41/start`, {});
    assert.deepEqual(reply, { status: 409, body: { error: 'every slot is pinned', code: 'capacity_full', details: { cap: 1 } } });
  } finally {
    await app.close();
    await plugin.close();
  }
});

test('with the plugin down or hung the plan page reads "off" quickly, and actions fail with dev_servers_off', async () => {
  const app = await coco(await freePort(), { timeouts: { read: 300, action: 300 } });
  const hung = await fakePlugin({ 'GET /api/board': 'hang', 'POST /api/servers/start': 'hang' });
  const slow = await coco(hung.port, { timeouts: { read: 300, action: 300 } });
  try {
    const down = await app.call('GET', `/api/dev-servers/works/${WORK.slug}`);
    assert.deepEqual([down.status, down.body.on], [200, false]);
    assert.match(down.body.reason, /nothing answers on http:\/\/127\.0\.0\.1:\d+/);
    assert.equal((await app.call('GET', '/api/dev-servers/board')).body.on, false);
    const action = await app.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/start`, {});
    assert.deepEqual([action.status, action.body.code], [503, 'dev_servers_off']);

    const started = Date.now();
    const waited = await slow.call('GET', `/api/dev-servers/works/${WORK.slug}`);
    assert.deepEqual([waited.body.on, waited.body.reason], [false, `http://127.0.0.1:${hung.port} did not answer within 300 ms`]);
    assert.ok(Date.now() - started < 2000);
    assert.equal((await slow.call('POST', `/api/dev-servers/works/${WORK.slug}/rows/42/start`, {})).body.code, 'dev_servers_off');
  } finally {
    await app.close();
    await slow.close();
    hung.close();
  }
});

test('requests from another site, a rebound host or a form post never reach the plugin', async () => {
  const plugin = await fakePlugin({ 'GET /api/board': () => [200, BOARD] });
  const app = await coco(plugin.port);
  try {
    const route = `/api/dev-servers/works/${WORK.slug}`;
    assert.equal((await app.call('GET', route, undefined, { origin: 'http://widgets.example' })).status, 403);
    assert.equal((await app.call('GET', route, undefined, { origin: 'null' })).status, 403);
    const rebound = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: app.port, path: route, headers: { host: 'widgets.example:8777' } }, (res) => resolve(res.resume().statusCode)).on('error', reject);
    });
    assert.equal(rebound, 403);
    assert.equal((await app.call('POST', `${route}/rows/42/start`, 'cwd=/tmp', { 'content-type': 'text/plain' })).status, 403);
    assert.equal(plugin.seen.length, 0);
    assert.equal((await app.call('GET', route, undefined, { origin: 'http://localhost:8778' })).status, 200);
  } finally {
    await app.close();
    await plugin.close();
  }
});
