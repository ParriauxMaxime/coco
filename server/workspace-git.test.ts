import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createWorkspaceGit, pathId } from './workspace-git.ts';
import type { Sink } from './events.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com' };
let root = '';
let clone = '';
let wg: ReturnType<typeof createWorkspaceGit>;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim();
const write = (f: string, text: string) => fs.writeFileSync(path.join(clone, f), text);

// a clone with a bare origin, on a feature branch never pushed; no Paseo: every call goes through git
before(() => {
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_COMMITTER_NAME: 'alice', GIT_COMMITTER_EMAIL: 'alice@example.com' });
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-wsgit-')));
  clone = path.join(root, 'widgets');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', path.join(root, 'origin.git')]);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  git(clone, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
  write('keep.txt', 'one\ntwo\n');
  write('gone.txt', 'bye\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'init');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  git(clone, 'switch', '-q', '-c', 'feat/x');
  wg = createWorkspaceGit({ repos: [{ path: clone }], listWorkspaces: async () => [{ id: 'wks_a', workspaceDirectory: clone }], pollMs: 20 });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

type Out = { status: number; body: Record<string, unknown> & { error: string } };
async function call(method: string, url: string, body?: unknown): Promise<Out> {
  const out = { status: 0, body: {} } as Out;
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  const parts = new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(1);
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  await wg.handle(req, new ServerResponse(req), parts, async () => raw, (_r, status, b) => void Object.assign(out, { status, body: b }));
  return out;
}
const at = (action: string) => `/api/workspaces/${pathId(clone)}/git/${action}`;

test('routes refuse what is not a workspace, a route or a valid body', async () => {
  assert.equal((await call('GET', '/api/workspaces/bad!id/git/status')).status, 400);
  assert.equal((await call('GET', '/api/workspaces/wks_none/git/status')).status, 404);
  assert.equal((await call('GET', `/api/workspaces/${pathId(root)}/git/status`)).status, 404, 'a directory that is no worktree of a configured repo');
  assert.equal((await call('GET', `/api/workspaces/${pathId('relative/dir')}/git/status`)).status, 400);
  assert.equal((await call('GET', at('nope'))).status, 404);
  assert.equal((await call('GET', at('commit/nothex/refs'))).status, 400);
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../b']) assert.equal((await call('GET', at(`diff/file?path=${encodeURIComponent(bad)}`))).status, 400, bad);
  assert.equal((await call('POST', at('commit'), { message: '   ' })).status, 400);
  assert.equal((await call('POST', at('commit'), { message: 'x', paths: ['../out'] })).status, 400);
  assert.equal((await call('POST', at('discard'), { paths: [] })).status, 400);
  assert.equal((await call('POST', at('stash'), { action: 'drop' })).status, 400);
  assert.equal((await call('POST', at('pr'), { title: 't', base: 'main; rm -rf /' })).status, 400);
  assert.equal((await call('POST', at('pr'), { title: '' })).status, 400);
  assert.equal((await call('POST', at('push'), 'not json')).status, 400);
  assert.equal((await call('POST', at('merge'), {})).status, 404);
  assert.equal((await call('GET', '/api/workspaces/wks_a/git/status')).body.branch, 'feat/x', 'a Paseo workspace id resolves to its directory');
});

test('status, diff, commit picked files, unpushed commits, push, stash, discard: through git in a temp repo', async () => {
  write('keep.txt', 'one\nTWO\nthree\n');
  write('new.txt', 'hello\n');
  fs.rmSync(path.join(clone, 'gone.txt'));
  const st = (await call('GET', at('status'))).body;
  assert.equal(st.branch, 'feat/x');
  assert.equal(st.dirty, true);
  assert.equal(st.upstream, null);
  assert.equal(st.base, 'origin/main');
  assert.equal(st.via, 'git');

  const files = (await call('GET', at('diff'))).body.files as { filename: string; status: string; additions: number; deletions: number }[];
  const by = Object.fromEntries(files.map((f) => [f.filename, f]));
  assert.deepEqual([by['keep.txt'].status, by['keep.txt'].additions, by['keep.txt'].deletions], ['modified', 2, 1]);
  assert.deepEqual([by['new.txt'].status, by['new.txt'].additions], ['added', 1]);
  assert.equal(by['gone.txt'].status, 'removed');
  const texts = (await call('GET', at('diff/file?path=keep.txt&unified=1'))).body;
  assert.deepEqual([texts.original, texts.modified], ['one\ntwo\n', 'one\nTWO\nthree\n']);
  assert.match(String(texts.unified), /\+TWO/);
  assert.equal((await call('GET', at('diff/file?path=new.txt'))).body.original, '');

  const committed = await call('POST', at('commit'), { message: 'add new', paths: ['new.txt', 'gone.txt'] });
  assert.equal(committed.status, 200, committed.body.error);
  assert.equal(git(clone, 'log', '-1', '--format=%s'), 'add new');
  assert.equal(git(clone, 'show', '--name-only', '--format=', 'HEAD'), 'gone.txt\nnew.txt');
  assert.deepEqual(((await call('GET', at('diff'))).body.files as { filename: string }[]).map((f) => f.filename), ['keep.txt'], 'the unpicked file stays uncommitted');
  const list = (await call('GET', at('commits'))).body.commits as { sha: string; subject: string }[];
  assert.deepEqual(list.map((c) => c.subject), ['add new']);
  const refs = (await call('GET', at(`commit/${list[0].sha}/refs`))).body;
  assert.equal(refs.subject, 'add new');
  assert.deepEqual((refs.files as { filename: string }[]).map((f) => f.filename).sort(), ['gone.txt', 'new.txt']);

  const pushed = await call('POST', at('push'));
  assert.equal(pushed.status, 200, pushed.body.error);
  const after = (await call('GET', at('status'))).body;
  assert.deepEqual([after.upstream, after.ahead, after.behind, after.aheadBase], ['origin/feat/x', 0, 0, 1]);
  assert.deepEqual((await call('GET', at('commits'))).body.commits, []);

  write('keep.txt', 'stashed\n');
  assert.equal((await call('POST', at('stash'), { action: 'save' })).status, 200);
  assert.equal(fs.readFileSync(path.join(clone, 'keep.txt'), 'utf8'), 'one\ntwo\n');
  // another worktree's stash lands on top of the shared stack: pop still takes this branch's
  const other = path.join(root, 'other');
  git(clone, 'worktree', 'add', '-q', other, 'main');
  fs.writeFileSync(path.join(other, 'keep.txt'), 'not mine\n');
  git(other, 'stash', 'push', '-q', '-m', 'someone else');
  assert.equal(((await call('GET', at('status'))).body.stashes as unknown[]).length, 1);
  assert.equal((await call('POST', at('stash'), { action: 'pop' })).status, 200);
  assert.equal(fs.readFileSync(path.join(clone, 'keep.txt'), 'utf8'), 'stashed\n');
  assert.match(git(clone, 'stash', 'list'), /^stash@\{0\}: On main: someone else$/);
  assert.equal((await call('POST', at('stash'), { action: 'pop' })).status, 409, 'nothing left on this branch');

  write('junk.txt', 'junk\n');
  const discarded = await call('POST', at('discard'), { paths: ['keep.txt', 'junk.txt'] });
  assert.equal(discarded.status, 200, discarded.body.error);
  assert.equal(fs.readFileSync(path.join(clone, 'keep.txt'), 'utf8'), 'one\ntwo\n');
  assert.equal(fs.existsSync(path.join(clone, 'junk.txt')), false);
  assert.equal((await call('GET', at('status'))).body.dirty, false);
});

test('a watcher hears a change in the working tree, and stops polling once gone', async () => {
  const got: string[] = [];
  const closers: (() => void)[] = [];
  const sink: Sink = { send: (json) => void got.push(JSON.parse(json).type), onClose: (fn) => void closers.push(fn), closed: false };
  await wg.watch(sink, pathId(clone));
  assert.deepEqual(got, ['ready']);
  await new Promise((r) => setTimeout(r, 60));
  write('keep.txt', 'edited\n');
  for (let i = 0; i < 50 && !got.includes('changed'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(got.includes('changed'));
  closers.forEach((fn) => fn());
  git(clone, 'checkout', '--', 'keep.txt');
});
