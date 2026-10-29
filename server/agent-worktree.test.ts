import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgentWorktrees, expandCheck } from './agent-worktree.ts';
import { DEFAULTS } from './config.ts';
import type { AgentWorktreeConfig, Config } from './config.ts';

const GUARD = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'scripts/install-guard.mjs');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// a main checkout of acme/widgets with its installed node_modules, and a worktree of it on its own branch
function fixture(t: { after(fn: () => void): void }, lock = '{"v":1}') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-wt-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'widgets');
  fs.mkdirSync(path.join(main, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\n.claude/settings.local.json\n');
  fs.writeFileSync(path.join(main, 'package-lock.json'), '{"v":1}');
  fs.writeFileSync(path.join(main, 'node_modules/left-pad.js'), 'main');
  git(main, 'init', '-q', '-b', 'main');
  git(main, '-c', 'user.name=alice', '-c', 'user.email=alice@acme.test', 'add', '.');
  git(main, '-c', 'user.name=alice', '-c', 'user.email=alice@acme.test', 'commit', '-qm', 'init');
  const wt = path.join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'cocopilot/abc123', wt);
  if (lock !== '{"v":1}') fs.writeFileSync(path.join(wt, 'package-lock.json'), lock);
  return { dir, main, wt };
}
const settings = (main: string, aw: AgentWorktreeConfig) => ({ ...DEFAULTS, repos: [{ ...DEFAULTS.repo, id: 'widgets', name: 'widgets', path: main, settings: {} }], agentWorktree: aw }) as Config;
const deps = (install: string) => [{ path: 'node_modules', lockfile: 'package-lock.json', install: ['sh', '-c', install] }];
const lint = { id: 'lint', label: 'Lint', command: ['node_modules/.bin/lint', '{files}'], files: '\\.ts$' };

test('a new worktree gets the main checkout node_modules linked, the install guard, and a brief naming the check commands', async (t) => {
  const { main, wt } = fixture(t);
  const aw = createAgentWorktrees({ config: settings(main, { deps: deps('true'), checks: [lint] }) });
  const r = await aw.prepare(wt);
  assert.equal(r.state, 'ready');
  assert.equal(fs.readlinkSync(path.join(wt, 'node_modules')), path.join(main, 'node_modules'));
  assert.deepEqual(r.deps, [{ path: 'node_modules', mode: 'linked' }]);
  const hook = JSON.parse(fs.readFileSync(path.join(wt, '.claude/settings.local.json'), 'utf8')).hooks.PreToolUse;
  assert.equal(hook.length, 1);
  assert.match(hook[0].hooks[0].command, /install-guard\.mjs" "node_modules"$/);
  fs.writeFileSync(path.join(main, 'node_modules/.bin/lint'), '');
  const brief = aw.briefLines(await aw.prepare(wt)).join('\n');
  assert.match(brief, /`node_modules`: linked to the main checkout/);
  assert.match(brief, /own_deps/);
  assert.match(brief, /Lint: `node_modules\/\.bin\/lint <changed files>`/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(wt, '.claude/settings.local.json'), 'utf8')).hooks.PreToolUse.length, 1, 'the guard is written once');
});

test('a worktree whose lockfile differs gets its own cloned and installed copy, and the waiting agent hears when checks work', async (t) => {
  const { main, wt } = fixture(t, '{"v":2}');
  const told: [string, string][] = [];
  const aw = createAgentWorktrees({ config: settings(main, { deps: deps('echo installed > node_modules/marker'), checks: [] }), notify: async (id, text) => void told.push([id, text]) });
  const r = await aw.prepare(wt);
  assert.equal(r.state, 'preparing');
  assert.equal(r.deps[0].mode, 'installing');
  aw.whenReady(wt, 'agent-1');
  await until(() => told.length > 0, 'the ready message');
  assert.equal(told[0][0], 'agent-1');
  assert.match(told[0][1], /checks are available now/);
  const nm = path.join(wt, 'node_modules');
  assert.equal(fs.lstatSync(nm).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(nm, 'left-pad.js'), 'utf8'), 'main', 'cloned from the main checkout');
  assert.equal(fs.readFileSync(path.join(nm, 'marker'), 'utf8').trim(), 'installed');
  assert.equal((await aw.prepare(wt)).deps[0].mode, 'own');
});

test('own_deps turns a linked folder into the worktree own copy and tells the agent', async (t) => {
  const { main, wt } = fixture(t);
  const told: string[] = [];
  const aw = createAgentWorktrees({ config: settings(main, { deps: deps('true'), checks: [] }), notify: async (_id, text) => void told.push(text) });
  await aw.prepare(wt);
  const r = await aw.ownDeps(path.join(wt), 'agent-2');
  assert.deepEqual(r.started, ['node_modules']);
  await until(() => told.length > 0, 'the own deps message');
  assert.match(told[0], /own dependency folders are installed/);
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), false);
  assert.deepEqual((await aw.ownDeps(wt, 'agent-2')).already, ['node_modules']);
});

test('the install guard refuses npm installs while node_modules is a link, and lets them through on an own copy', (t) => {
  const { main, wt } = fixture(t);
  fs.symlinkSync(path.join(main, 'node_modules'), path.join(wt, 'node_modules'));
  const hook = (command: string) => spawnSync(process.execPath, [GUARD, 'node_modules'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: wt }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: wt } }).stdout;
  for (const cmd of ['npm install', 'cd web && npm i -D left-pad', 'npm --prefix web ci', 'npm uninstall left-pad']) assert.match(hook(cmd), /"permissionDecision":"deny".*own_deps/, cmd);
  for (const cmd of ['npm run check-ts', 'npx oxfmt --check a.ts', 'git commit -m "npm install"x']) assert.equal(hook(cmd), '', cmd);
  fs.unlinkSync(path.join(wt, 'node_modules'));
  fs.mkdirSync(path.join(wt, 'node_modules'));
  assert.equal(hook('npm install'), '');
});

test('a main checkout without node_modules does not block: the brief says the checks are unavailable, a retry links it and tells the agent', async (t) => {
  const { main, wt } = fixture(t);
  fs.rmSync(path.join(main, 'node_modules'), { recursive: true });
  const told: string[] = [];
  const aw = createAgentWorktrees({ config: settings(main, { deps: deps('true'), checks: [lint] }), notify: async (_id, text) => void told.push(text), retryMs: [30, 30, 30] });
  const r = await aw.prepare(wt);
  assert.equal(r.state, 'failed');
  assert.match(aw.briefLines(r).join('\n'), /Not available yet: Lint \(the main checkout .* has no node_modules\)/);
  aw.whenReady(wt, 'agent-3');
  fs.mkdirSync(path.join(main, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(main, 'node_modules/.bin/lint'), '');
  await until(() => told.length > 0, 'the retry');
  assert.match(told[0], /Lint: `node_modules\/\.bin\/lint <changed files>`/);
  assert.equal(fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), true);
});

test('an optional folder the main checkout lacks is installed in the worktree, so the check that needs it runs', async (t) => {
  const { main, wt } = fixture(t);
  fs.mkdirSync(path.join(wt, 'web'));
  const tests = { id: 'tests', label: 'Tests', command: ['vitest'], needs: ['web/node_modules'] };
  const web = { path: 'web/node_modules', install: ['sh', '-c', 'mkdir node_modules'], optional: true };
  const told: string[] = [];
  const aw = createAgentWorktrees({ config: settings(main, { deps: [...deps('true'), web], checks: [tests] }), notify: async (_id, text) => void told.push(text) });
  const r = await aw.prepare(wt);
  assert.equal(r.state, 'preparing');
  assert.deepEqual(r.deps.map((d) => d.mode), ['linked', 'installing']);
  aw.whenReady(wt, 'agent-4');
  await until(() => told.length > 0, 'the ready message');
  const ready = await aw.prepare(wt);
  assert.equal(ready.state, 'ready');
  assert.deepEqual(ready.deps.map((d) => d.mode), ['linked', 'own']);
  assert.equal(ready.checks[0].available, true);
});

test("coco's run of the checks on a commit: each check on the files it covers, a failure keeps its output, a check lacking what it needs is skipped", async (t) => {
  const { main, wt } = fixture(t);
  const commit = (file: string) => {
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), 'x');
    git(wt, 'add', file);
    git(wt, '-c', 'user.name=bob', '-c', 'user.email=bob@acme.test', 'commit', '-qm', `touch ${file}`, '-m', 'Cc-Comment: aa11');
    return git(wt, 'rev-parse', 'HEAD');
  };
  const checks = [
    { id: 'lint', label: 'Lint', command: ['sh', '-c', 'echo linted "$0"', '{files}'], files: '\\.ts$' },
    { id: 'types', label: 'Type check', command: ['sh', '-c', 'echo "src/a.ts(1,1): error TS2322" >&2; exit 2'], files: '\\.ts$' },
    { id: 'css', label: 'Styles', command: ['stylelint', '{files}'], files: '\\.css$' },
    { id: 'tests', label: 'Tests', command: ['vitest', '{tests}'], needs: ['web/node_modules'] },
  ];
  const aw = createAgentWorktrees({ config: settings(main, { deps: deps('true'), checks }) });
  const head = commit('src/a.ts');
  const v = await aw.verify(wt, { base: `${head}^`, head });
  assert.ok(v);
  assert.equal(v.state, 'failed');
  assert.deepEqual(v.files, ['src/a.ts']);
  assert.deepEqual(v.results.map((r) => [r.label, r.state]), [['Lint', 'passed'], ['Type check', 'failed'], ['Styles', 'skipped'], ['Tests', 'skipped']]);
  assert.match(v.results[1].output ?? '', /error TS2322/);
  assert.match(v.results[3].why ?? '', /web\/node_modules is missing/);
  assert.equal(aw.briefLines(await aw.prepare(wt)).some((l) => /Not available yet: Tests/.test(l)), true);
});

test('a check expands to the changed files it covers and the tests next to them, relative to its folder', (t) => {
  const { wt } = fixture(t);
  fs.mkdirSync(path.join(wt, 'app/src'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'app/src/a.test.ts'), '');
  const changed = ['app/src/a.ts', 'app/src/b.ts', 'README.md'];
  assert.deepEqual(expandCheck(wt, { id: 't', label: 'Tests', cwd: 'app', command: ['vitest', 'run', '{tests}'], files: '\\.ts$' }, changed), { argv: ['vitest', 'run', 'src/a.test.ts'], cwd: path.join(wt, 'app') });
  assert.deepEqual(expandCheck(wt, { id: 'l', label: 'Lint', command: ['lint', '{files}'], files: '\\.ts$' }, changed), { argv: ['lint', 'app/src/a.ts', 'app/src/b.ts'], cwd: wt });
  assert.deepEqual(expandCheck(wt, { id: 'l', label: 'Lint', command: ['lint', '{files}'], files: '\\.css$' }, changed), { skip: 'no changed file it checks' });
  assert.deepEqual(expandCheck(wt, { id: 't', label: 'Tests', command: ['vitest', '{tests}'], files: '\\.ts$' }, ['app/src/b.ts']), { skip: 'no test file next to the changed files' });
});
