import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createWorkspaceTerminals } from './workspace-terminals.ts';
import { HttpError } from './core-types.ts';
import type { TerminalApi } from './paseo-agent.ts';
import type { Sink } from './events.ts';

// a daemon with one workspace (wks_a): terminal t1, a script `web` whose output is terminal t9; t2 belongs to another workspace
function fakeDaemon() {
  const calls: { input: [string, unknown][]; created: unknown[]; killed: string[]; started: string[]; stopped: string[]; released: number } = { input: [], created: [], killed: [], started: [], stopped: [], released: 0 };
  const script = { scriptName: 'web', type: 'service', hostname: 'localhost', port: 5173, lifecycle: 'running', health: 'healthy', exitCode: null, terminalId: 't9', proxyUrl: null };
  const terms = [{ id: 't1', name: 'zsh', activity: { state: 'idle' } }];
  let receive: ((e: unknown) => void) | null = null;
  const d = {
    listTerminals: async (cwd: string) => ({ cwd, terminals: cwd === '/ws/a' ? terms : [{ id: 't2', name: 'other' }], requestId: 'r' }),
    listWorkspaceScripts: async (ws: string) => ({ requestId: 'r', workspaceId: ws, scripts: ws === 'wks_a' ? [script] : [], error: null }),
    createTerminal: async (cwd: string, name?: string, _r?: string, opts?: unknown) => {
      calls.created.push({ cwd, name, opts });
      return { terminal: { id: 't3', name: name || 'zsh', cwd }, error: null, requestId: 'r' };
    },
    sendTerminalInput: (id: string, m: unknown) => void calls.input.push([id, m]),
    killTerminal: async (id: string) => {
      calls.killed.push(id);
      return { terminalId: id, success: true, requestId: 'r' };
    },
    startWorkspaceScriptWithStatus: async (ws: string, name: string) => {
      calls.started.push(name);
      return { requestId: 'r', workspaceId: ws, script, error: null };
    },
    stopWorkspaceScript: async (ws: string, name: string) => {
      calls.stopped.push(name);
      return { requestId: 'r', workspaceId: ws, script: { ...script, lifecycle: 'stopped' }, error: null };
    },
    observeTerminals: () => ({ subscribe: (o: { snapshot: (p: unknown) => void }) => (o.snapshot({ cwd: '/ws/a', terminals: terms }), () => {}), release: async () => void calls.released++ }),
    observeTerminal: (_id: string, rec: (e: unknown) => void) => {
      receive = rec;
      return { subscribe: () => () => {}, release: async () => void calls.released++ };
    },
  };
  return { d: d as unknown as TerminalApi, calls, emit: (e: unknown) => receive?.(e) };
}

const PATH_A = `p.${Buffer.from('/ws/a').toString('base64url')}`;
const dirOf = async (id: string) => {
  if (id === 'wks_a') return '/ws/a';
  if (id === 'wks_b') return '/ws/b';
  if (id === PATH_A) return '/ws/a';
  if (!/^[\w.-]+$/.test(id)) throw new HttpError(400, 'bad workspace id');
  throw new HttpError(404, `no workspace ${id}`);
};

type Out = { status: number; body: Record<string, unknown> & { error: string } };
function caller(daemon: () => Promise<TerminalApi | null>) {
  const wt = createWorkspaceTerminals({ dirOf, daemon, pollMs: 1000 });
  const call = async (method: string, url: string, body?: unknown): Promise<Out> => {
    const out = { status: 0, body: {} } as Out;
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = url;
    const parts = url.split('/').filter(Boolean).slice(1);
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    await wt.handle(req, new ServerResponse(req), parts, async () => raw, (_r, status, b) => void Object.assign(out, { status, body: b }));
    return out;
  };
  return { wt, call };
}

test('routes refuse a bad workspace, route, terminal, script or body; a terminal of another workspace is not reachable', async () => {
  const { d, calls } = fakeDaemon();
  const { call } = caller(async () => d);
  assert.equal((await call('GET', '/api/workspaces/bad!id/terminals')).status, 400);
  assert.equal((await call('GET', '/api/workspaces/wks_none/terminals')).status, 404);
  assert.equal((await call('GET', '/api/workspaces/wks_a/nope')).status, 404);
  assert.equal((await call('GET', '/api/workspaces/wks_a/terminals/t1')).status, 404);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input/x', { data: 'a' })).status, 404);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/merge', {})).status, 404);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1', {})).status, 404);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/bad$id/input', { data: 'a' })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t2/input', { data: 'a' })).status, 404, "another workspace's terminal");
  assert.equal((await call('POST', '/api/workspaces/wks_b/terminals/t1/kill', {})).status, 404, 'kill through the wrong workspace');
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', { data: '' })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', { data: 'x'.repeat(70000) })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', { data: 5 })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', 'not json')).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', [1])).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/resize', { rows: 0, cols: 80 })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/resize', { rows: 24, cols: 80.5 })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals', { name: 'a\nb' })).status, 400);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals', { rows: 24 })).status, 400, 'a size needs both');
  assert.equal((await call('POST', '/api/workspaces/wks_a/scripts/web/restart', {})).status, 404);
  assert.equal((await call('POST', '/api/workspaces/wks_a/scripts/db/start', {})).status, 404, 'a script the workspace does not list');
  assert.equal((await call('POST', '/api/workspaces/wks_a/scripts', {})).status, 404);
  assert.equal((await call('POST', `/api/workspaces/${PATH_A}/scripts/web/start`, {})).status, 404, 'scripts need a Paseo workspace');
  assert.equal((await call('POST', `/api/workspaces/${PATH_A}/terminals`, {})).status, 409, 'so does a new terminal');
  assert.deepEqual([calls.input, calls.killed, calls.started, calls.created], [[], [], [], []], 'nothing reached the daemon');
});

test('list, create, type, resize, kill, scripts start and stop go to the daemon for this workspace only', async () => {
  const { d, calls } = fakeDaemon();
  const { call } = caller(async () => d);
  const list = await call('GET', '/api/workspaces/wks_a/terminals');
  assert.deepEqual(list.body, { cwd: '/ws/a', terminals: [{ id: 't1', name: 'zsh', title: null, busy: false }] });
  const made = await call('POST', '/api/workspaces/wks_a/terminals', { name: 'build', rows: 30, cols: 100 });
  assert.equal(made.status, 200);
  assert.deepEqual(calls.created, [{ cwd: '/ws/a', name: 'build', opts: { workspaceId: 'wks_a', size: { rows: 30, cols: 100 } } }]);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/input', { data: 'echo hello\r' })).status, 200);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t9/input', { data: 'q' })).status, 200, "a script's output terminal");
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/resize', { rows: 40, cols: 120 })).status, 200);
  assert.deepEqual(calls.input, [['t1', { type: 'input', data: 'echo hello\r' }], ['t9', { type: 'input', data: 'q' }], ['t1', { type: 'resize', rows: 40, cols: 120 }]]);
  assert.equal((await call('POST', '/api/workspaces/wks_a/terminals/t1/kill', {})).status, 200);
  assert.deepEqual(calls.killed, ['t1']);
  const scripts = await call('GET', '/api/workspaces/wks_a/scripts');
  assert.deepEqual(scripts.body, { supported: true, scripts: [{ name: 'web', type: 'service', running: true, health: 'healthy', port: 5173, url: 'http://localhost:5173', exitCode: null, terminalId: 't9' }] });
  assert.equal((await call('POST', '/api/workspaces/wks_a/scripts/web/stop', {})).body.script && calls.stopped[0], 'web');
  assert.equal((await call('POST', '/api/workspaces/wks_a/scripts/web/start', {})).status, 200);
  assert.deepEqual(calls.started, ['web']);
  assert.deepEqual((await call('GET', `/api/workspaces/${PATH_A}/scripts`)).body, { supported: false, scripts: [] });
});

test('with Paseo away the routes say so', async () => {
  const { call } = caller(async () => null);
  const r = await call('GET', '/api/workspaces/wks_a/terminals');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Paseo/);
});

test('a terminal streams its screen then its output, base64, and lets go of Paseo when the page does', async () => {
  const { d, calls, emit } = fakeDaemon();
  const { wt } = caller(async () => d);
  const sent: unknown[] = [];
  const closers: (() => void)[] = [];
  const sink: Sink = { send: (json) => void sent.push(JSON.parse(json)), onClose: (fn) => void closers.push(fn), closed: false };
  await assert.rejects(wt.watchTerminal(sink, 'wks_a', 't2'), /no terminal t2/);
  await wt.watchTerminal(sink, 'wks_a', 't1');
  emit({ type: 'restore', data: new TextEncoder().encode('$ ') });
  emit({ type: 'output', data: new TextEncoder().encode('hello\r\n') });
  emit({ type: 'snapshot', state: { rows: 1, cols: 4, grid: [[{ char: 'h' }, { char: 'i' }]], scrollback: [], cursor: { row: 0, col: 2 } } });
  const decoded = sent.map((m) => ({ ...(m as { type: string }), data: Buffer.from((m as { data: string }).data, 'base64').toString() }));
  assert.deepEqual(decoded.slice(0, 2), [{ type: 'reset', data: '$ ' }, { type: 'output', data: 'hello\r\n' }]);
  assert.equal(decoded[2].type, 'reset');
  assert.match(decoded[2].data, /hi/);
  closers.forEach((fn) => fn());
  assert.equal(calls.released, 1);
});

test('the list topic sends the terminals and the scripts', async () => {
  const { d, calls } = fakeDaemon();
  const { wt } = caller(async () => d);
  const sent: { type: string }[] = [];
  const closers: (() => void)[] = [];
  const sink: Sink = { send: (json) => void sent.push(JSON.parse(json)), onClose: (fn) => void closers.push(fn), closed: false };
  await wt.watchList(sink, 'wks_a');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent.map((m) => m.type).sort(), ['scripts', 'terminals']);
  closers.forEach((fn) => fn());
  assert.equal(calls.released, 1);
});
