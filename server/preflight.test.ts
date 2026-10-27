import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreflight, isVideoEntry } from './preflight.ts';
import { createDispatch } from './dispatch.ts';
import { createAsk } from './ask.ts';
import { DEFAULTS } from './config.ts';
import type { Config, PreflightConfig } from './config.ts';
import type { Work } from './core-types.ts';

const SECRET = 'sk-ant-SECRET-VALUE-1234';
const AGENT = '12345678-1234-1234-1234-123456789abc';
const work = { slug: 'csv', title: 'CSV export', repo: 'widgets', timeline: [], stack: [{ number: 101 }] } as unknown as Work;

type Server = { state?: string; lastError?: string } | null;
function rig({ cfg = {} as PreflightConfig, github = 'acme/widgets', wt = true, server = null as Server, on = true, prep = { state: 'ready', deps: [] as { path: string; mode: string }[], error: undefined as string | undefined }, env = {} as Record<string, string>, settings = null as object | null, http = async () => null as string | null, tcp = async () => null as string | null, exec = async () => ({ ok: true, output: '' }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  if (settings) {
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/settings-local.json'), JSON.stringify(settings));
  }
  let clock = 1_000_000;
  const calls = { view: 0, prepare: [] as unknown[], exec: [] as { argv: string[]; cwd: string; timeoutMs: number }[], http: [] as string[], tcp: [] as string[] };
  const preflight = createPreflight({
    config: { repo: { path: dir, github } },
    preflightOf: () => (Object.keys(cfg).length ? cfg : null),
    works: { get: (s) => (s === 'csv' ? work : null) },
    devServers: { workView: async () => (calls.view++, on ? { on: true, rows: [{ key: 101, worktree: wt ? dir : null, server }] } : { on: false, reason: 'nothing answers on :8779' }) },
    worktrees: { prepare: async (root, o) => (calls.prepare.push({ root, ...o }), prep) },
    env,
    probe: { http: async (u) => (calls.http.push(u), http()), tcp: async (h, p) => (calls.tcp.push(`${h}:${p}`), tcp()), exec: async (argv, o) => (calls.exec.push({ argv, ...o }), exec()) },
    now: () => clock,
  });
  return { preflight, calls, dir, tick: (ms: number) => (clock += ms) };
}
const by = (r: { checks: { name: string }[] }, name: string) => r.checks.find((c) => c.name === name) as { name: string; ok: boolean; detail: string; fix: string };

test('only kit-video gate runs are preflighted', () => {
  assert.equal(isVideoEntry('gate:kit-video:lem-demo-video'), true);
  assert.equal(isVideoEntry('gate:kit-body:lem-pr'), false);
  assert.equal(isVideoEntry('ask'), false);
});

test('worktree deps: ready is green, installing and failed are red with a fix, no worktree is not an error; nothing is started', async () => {
  const ok = await rig().preflight.run('csv', 101);
  assert.deepEqual([by(ok, 'Worktree deps').ok, by(ok, 'Dev server').ok], [true, true]);
  const busy = rig({ prep: { state: 'preparing', deps: [{ path: 'node_modules', mode: 'installing' }], error: undefined } });
  const r = await busy.preflight.run('csv', 101);
  assert.equal(by(r, 'Worktree deps').ok, false);
  assert.match(by(r, 'Worktree deps').fix, /wait/);
  assert.deepEqual(busy.calls.prepare, [{ root: busy.dir, retrying: true, start: false }]);
  const failed = await rig({ prep: { state: 'failed', deps: [], error: 'the main checkout has no node_modules' } }).preflight.run('csv', 101);
  assert.match(by(failed, 'Worktree deps').detail, /no node_modules/);
  assert.match(by(failed, 'Worktree deps').fix, /own_deps/);
  const none = rig({ wt: false });
  assert.equal(by(await none.preflight.run('csv', 101), 'Worktree deps').ok, true);
  assert.equal(none.calls.prepare.length, 0);
});

test('dev server: a crashed one and one running mid node_modules swap are red; none or plugin off are fine', async () => {
  const crashed = await rig({ server: { state: 'crashed', lastError: 'Cannot find module meteor' } }).preflight.run('csv', 101);
  assert.equal(by(crashed, 'Dev server').ok, false);
  assert.match(by(crashed, 'Dev server').detail, /crashed: Cannot find module meteor/);
  const swap = await rig({ server: { state: 'ready' }, prep: { state: 'preparing', deps: [{ path: 'node_modules', mode: 'installing' }], error: undefined } }).preflight.run('csv', 101);
  assert.equal(by(swap, 'Dev server').ok, false);
  assert.match(by(swap, 'Dev server').detail, /node_modules are being swapped/);
  assert.equal(by(await rig({ server: { state: 'ready' } }).preflight.run('csv', 101), 'Dev server').detail, 'ready');
  const off = by(await rig({ on: false }).preflight.run('csv', 101), 'Dev server');
  assert.deepEqual([off.ok, /not checked/.test(off.detail)], [true, true]);
});

test('MCP endpoints: http and tcp are probed, a refusal is red with the configured fix', async () => {
  const cfg: PreflightConfig = { mcp: [{ name: 'lemlist-dev MCP', url: 'http://localhost:8000/mcp', fix: 'start the app' }, { name: 'db', url: 'tcp://127.0.0.1:27017' }, { name: 'broken', url: 'nope' }] };
  const up = rig({ cfg });
  const r = await up.preflight.run('csv', 101);
  assert.deepEqual(up.calls.http, ['http://localhost:8000/mcp']);
  assert.deepEqual(up.calls.tcp, ['127.0.0.1:27017']);
  assert.deepEqual(r.checks.filter((c) => ['lemlist-dev MCP', 'db'].includes(c.name)).map((c) => c.ok), [true, true]);
  assert.equal(by(r, 'broken').ok, false);
  const down = await rig({ cfg, http: async () => 'ECONNREFUSED', tcp: async () => 'ECONNREFUSED' }).preflight.run('csv', 101);
  assert.deepEqual([by(down, 'lemlist-dev MCP').ok, by(down, 'lemlist-dev MCP').detail, by(down, 'lemlist-dev MCP').fix], [false, 'http://localhost:8000/mcp: ECONNREFUSED', 'start the app']);
  assert.match(by(down, 'db').fix, /tcp:\/\/127\.0\.0\.1:27017/);
});

test('LLM key: found in the env or in the settings file, missing is red; its value never reaches the result', async () => {
  const cfg: PreflightConfig = { settingsFile: 'app/settings-local.json', llmKey: { env: ['ANTHROPIC_API_KEY'], paths: ['llm.key'] } };
  const viaEnv = await rig({ cfg, settings: {}, env: { ANTHROPIC_API_KEY: SECRET } }).preflight.run('csv', 101);
  assert.deepEqual([by(viaEnv, 'LLM key').ok, by(viaEnv, 'LLM key').detail], [true, 'set in env ANTHROPIC_API_KEY']);
  const viaFile = await rig({ cfg, settings: { llm: { key: SECRET } } }).preflight.run('csv', 101);
  assert.deepEqual([by(viaFile, 'LLM key').ok, by(viaFile, 'LLM key').detail], [true, 'set in app/settings-local.json (llm.key)']);
  for (const r of [viaEnv, viaFile]) assert.ok(!JSON.stringify(r).includes(SECRET));
  const none = await rig({ cfg, settings: { llm: { key: '' } }, env: { ANTHROPIC_API_KEY: '' } }).preflight.run('csv', 101);
  assert.equal(by(none, 'LLM key').ok, false);
  assert.match(by(none, 'LLM key').detail, /ANTHROPIC_API_KEY.*app\/settings-local\.json \(llm\.key\)/);
  assert.match(by(none, 'LLM key').fix, /never paste it/);
});

test('settings-local.json: missing is red and also fails the key check', async () => {
  const cfg: PreflightConfig = { settingsFile: 'app/settings-local.json', llmKey: { env: ['K'], paths: ['llm.key'] } };
  const r = await rig({ cfg }).preflight.run('csv', 101);
  assert.equal(by(r, 'settings-local.json').ok, false);
  assert.equal(by(r, 'LLM key').ok, false);
  assert.equal(by(await rig({ cfg, settings: {} }).preflight.run('csv', 101), 'settings-local.json').ok, true);
});

test('fixture probes run only when configured, with their timeout, in the worktree; the default is none', async () => {
  const none = rig();
  assert.equal((await none.preflight.run('csv', 101)).checks.length, 2);
  assert.equal(none.calls.exec.length, 0);
  const cfg: PreflightConfig = { probes: [{ name: 'Campaign has leads', command: ['mongosh', '--eval', 'db.leads.count()'], timeoutSeconds: 5, fix: 'seed leads in SETUP' }] };
  const bad = rig({ cfg, exec: async () => ({ ok: false, output: '0 leads\nfound' }) });
  const r = await bad.preflight.run('csv', 101);
  assert.deepEqual(bad.calls.exec, [{ argv: ['mongosh', '--eval', 'db.leads.count()'], cwd: bad.dir, timeoutMs: 5000 }]);
  assert.deepEqual([by(r, 'Campaign has leads').ok, by(r, 'Campaign has leads').detail, by(r, 'Campaign has leads').fix], [false, '0 leads found', 'seed leads in SETUP']);
  assert.equal(by(await rig({ cfg }).preflight.run('csv', 101), 'Campaign has leads').ok, true);
});

test('lemlist repos get the lemlist defaults; others get none', async () => {
  const lem = rig({ github: 'lemlist/lemlist' });
  const r = await lem.preflight.run('csv', 101);
  assert.deepEqual(lem.calls.http, ['http://localhost:8000/mcp']);
  assert.deepEqual(r.checks.map((c) => c.name), ['Worktree deps', 'Dev server', 'lemlist-dev MCP', 'settings-local.json', 'LLM key']);
  const other = rig();
  assert.equal(other.calls.http.length, 0);
});

test('the result is cached for 60 s per PR; fresh re-runs it', async () => {
  const { preflight, calls, tick } = rig();
  const a = await preflight.run('csv', 101);
  tick(59_000);
  assert.equal(await preflight.run('csv', 101), a);
  assert.equal(calls.view, 1);
  await preflight.run('csv', 101, { fresh: true });
  assert.equal(calls.view, 2);
  tick(61_000);
  await preflight.run('csv', 101);
  assert.equal(calls.view, 3);
  await assert.rejects(preflight.run('nope', 101), /no such work/);
});

test('the brief lines list only red checks, point at the skill playbook and leak no key', async () => {
  const cfg: PreflightConfig = { mcp: [{ name: 'lemlist-dev MCP', url: 'http://localhost:8000/mcp', fix: 'start the app' }], llmKey: { env: ['ANTHROPIC_API_KEY'] } };
  const { preflight } = rig({ cfg, http: async () => 'ECONNREFUSED', env: { OTHER: SECRET } });
  const lines = preflight.briefLines(await preflight.run('csv', 101), 'lem-demo-video').join('\n');
  assert.match(lines, /^## Known blockers/);
  assert.match(lines, /`lem-demo-video` skill's "When a beat is blocked"/);
  assert.match(lines, /- lemlist-dev MCP: http:\/\/localhost:8000\/mcp: ECONNREFUSED \(to unblock, the owner: start the app\)/);
  assert.match(lines, /- LLM key: not set/);
  assert.doesNotMatch(lines, /Worktree deps/);
  assert.ok(!lines.includes(SECRET));
  const green = rig();
  assert.deepEqual(green.preflight.briefLines(await green.preflight.run('csv', 101), 'x'), []);
});

function dispatchRig(pre?: ReturnType<typeof rig>['preflight']) {
  const config: Config = { ...DEFAULTS, repo: { ...DEFAULTS.repo, github: 'acme/widgets' }, gateSkills: { ...DEFAULTS.gateSkills, 'kit-video': ['lem-demo-video'], 'kit-body': ['lem-pr'] }, kitKinds: ['body', 'video'] };
  const started: Record<string, unknown>[] = [];
  const dispatch = createDispatch({
    config,
    works: { get: () => structuredClone(work) as Work, save: () => {} },
    writer: { write: async () => ({ brief: 'Written brief' }), track: () => {} },
    placement: { place: async () => ({ workspaceId: 'wks', cwd: '/tmp/x' }) },
    agents: { start: async (o) => (started.push(o), { agentId: AGENT }) },
    briefs: { context: async () => ({ work, index: 0, pr: { head: 'feat/a', base: 'main' }, worktree: null, config }) } as never,
    reviewAgent: { start: async () => ({ runId: 'r', agentId: AGENT }), timeline: () => {} },
    comments: { list: () => ({ comments: [] }) },
    preflight: pre,
  });
  return { dispatch, started };
}

test('a kit-video dispatch gets the red checks as Known blockers in its first message; other entries and green runs do not', async () => {
  const cfg: PreflightConfig = { mcp: [{ name: 'lemlist-dev MCP', url: 'http://localhost:8000/mcp' }] };
  const red = dispatchRig(rig({ cfg, http: async () => 'ECONNREFUSED' }).preflight);
  await red.dispatch.start('csv', { entry: 'gate:kit-video:lem-demo-video', key: 101 });
  const prompt = String(red.started[0].prompt);
  assert.match(prompt, /\n## Known blockers\n[\s\S]*`lem-demo-video` skill's "When a beat is blocked"[\s\S]*- lemlist-dev MCP: http:\/\/localhost:8000\/mcp: ECONNREFUSED/);
  assert.ok(prompt.indexOf('Written brief') < prompt.indexOf('## Known blockers'));
  await red.dispatch.start('csv', { entry: 'gate:kit-body:lem-pr', key: 101 });
  assert.doesNotMatch(String(red.started[1].prompt), /Known blockers/);
  const green = dispatchRig(rig({ cfg }).preflight);
  await green.dispatch.start('csv', { entry: 'gate:kit-video:lem-demo-video', key: 101 });
  assert.doesNotMatch(String(green.started[0].prompt), /Known blockers/);
  const broken = dispatchRig({ run: async () => Promise.reject(new Error('boom')), briefLines: () => ['x'] });
  await broken.dispatch.start('csv', { entry: 'gate:kit-video:lem-demo-video', key: 101 });
  assert.equal(broken.started.length, 1);
});

test('the dispatch card shows the preflight before approval: red lines with the fix and "Start anyway", green ticks otherwise', async () => {
  const card = async (checks: { name: string; ok: boolean; detail: string; fix: string }[] | null, entry = 'gate:kit-video:lem-demo-video') => {
    const ask = createAsk({
      DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-ask-')), APP: '/opt/coco', REPO: '/acme/widgets', config: DEFAULTS,
      works: { get: (s) => (s === 'csv' ? (work as never) : undefined), save: () => {}, prInfo: async () => null },
      dispatch: async () => ({ title: 't', agentId: null }),
      preflight: async (_s, e) => (e === entry && checks ? { checks } : null),
    });
    const ctx = { agentId: '99999999-0000-4000-8000-000000000000', work: null, pr: null };
    return ask.actions.dispatch.card({ entry, pr: 101, workSlug: 'csv' }, ctx);
  };
  const red = (await card([{ name: 'Worktree deps', ok: true, detail: 'dependencies ready', fix: '' }, { name: 'LLM key', ok: false, detail: 'not set in the server env (ANTHROPIC_API_KEY)', fix: 'give the local server its key' }])).card;
  assert.equal(red.confirmLabel, 'Start anyway');
  const table = red.blocks.find((b: { type: string }) => b.type === 'table');
  assert.equal(table.caption, 'Preflight');
  assert.deepEqual(table.rows, [[{ text: '✓', tone: 'ok' }, 'Worktree deps', 'dependencies ready'], [{ text: '✕', tone: 'risk' }, 'LLM key', 'not set in the server env (ANTHROPIC_API_KEY). Fix: give the local server its key']]);
  const green = (await card([{ name: 'Worktree deps', ok: true, detail: 'dependencies ready', fix: '' }])).card;
  assert.equal(green.confirmLabel, 'Start agent');
  const other = (await card(null)).card;
  assert.deepEqual([other.confirmLabel, other.blocks.some((b: { type: string }) => b.type === 'table')], ['Start agent', false]);
});
