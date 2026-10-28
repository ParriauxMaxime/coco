import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createWorkspaceFiles, isBinary, MAX_READ } from './workspace-files.ts';
import { HttpError } from './core-types.ts';
import type { FilesApi } from './paseo-agent.ts';
import type { Sink } from './events.ts';

let tmp = '';
let root = '';
let outside = '';
const put = (f: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), data);
};
const dirOf = async (id: string) => {
  if (id !== 'ws') throw new HttpError(404, `no workspace ${id}`);
  return root;
};

// a workspace with text, binary, an image, a large file, node_modules, and symlinks in and out of it
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-wsfiles-')));
  root = path.join(tmp, 'ws');
  outside = path.join(tmp, 'secret');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'key.txt'), 'top secret\n');
  put('src/app.ts', 'export const a = 1;\n');
  put('README.md', '# hi\n');
  put('bin/blob.dat', Buffer.from([1, 2, 0, 3]));
  put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  put('big.txt', 'x'.repeat(MAX_READ + 1));
  put('node_modules/dep/index.js', 'module.exports = 1;\n');
  put('.git/config', '[core]\n');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(outside, 'key.txt'), path.join(root, 'key-link.txt'));
  fs.symlinkSync('src/app.ts', path.join(root, 'app-link.ts'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

type Out = { status: number; body: Record<string, unknown> & { error: string } };
async function call(wf: ReturnType<typeof createWorkspaceFiles>, method: string, url: string, body?: unknown): Promise<Out> {
  const out = { status: 0, body: {} } as Out;
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  const parts = new URL(url, 'http://x').pathname.split('/').filter(Boolean).slice(1);
  const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  await wf.handle(req, new ServerResponse(req), parts, async () => raw, (_r, status, b) => void Object.assign(out, { status, body: b }));
  return out;
}
const fsOnly = () => createWorkspaceFiles({ dirOf, pollMs: 20 });
const at = (action: string, p?: string) => `/api/workspaces/ws/files/${action}${p === undefined ? '' : `?path=${encodeURIComponent(p)}`}`;

test('paths outside the workspace are refused for every route, before Paseo is asked', async () => {
  const asked: string[] = [];
  const spy = { listDirectory: async (_c: string, p: string) => (asked.push(p), { path: p, entries: [] }), readFile: async (_c: string, p: string) => (asked.push(p), { bytes: new Uint8Array(), mime: '', size: 0, path: p, kind: 'text', modifiedAt: '' }) } as unknown as FilesApi;
  for (const wf of [fsOnly(), createWorkspaceFiles({ dirOf, files: async () => spy })]) {
    for (const bad of ['../secret/key.txt', '/etc/passwd', 'src/../../secret/key.txt', '.', 'src/', 'a//b', `${outside}/key.txt`]) {
      for (const action of ['read', 'list', 'stat']) assert.equal((await call(wf, 'GET', at(action, bad))).status, 400, `${action} ${bad}`);
      assert.equal((await call(wf, 'POST', at('write'), { path: bad, content: 'x', expectedModifiedAt: 'x' })).status, 400, `write ${bad}`);
    }
    for (const escaping of ['escape/key.txt', 'key-link.txt']) {
      assert.equal((await call(wf, 'GET', at('read', escaping))).status, 403, escaping);
      assert.equal((await call(wf, 'GET', at('stat', escaping))).status, 403, escaping);
      assert.equal((await call(wf, 'POST', at('write'), { path: escaping, content: 'pwned', expectedModifiedAt: new Date().toISOString() })).status, 403, escaping);
    }
    assert.equal((await call(wf, 'GET', at('list', 'escape'))).status, 403);
    assert.equal((await call(wf, 'GET', '/api/workspaces/other/files/read?path=README.md')).status, 404);
    assert.equal((await call(wf, 'GET', at('nope'))).status, 404);
  }
  assert.deepEqual(asked, [], 'Paseo never sees a refused path');
  assert.equal(fs.readFileSync(path.join(outside, 'key.txt'), 'utf8'), 'top secret\n');
});

test('a directory lists dirs first, symlinks marked; the tree skips .git and node_modules outside git', async () => {
  const wf = fsOnly();
  const top = await call(wf, 'GET', at('list', ''));
  assert.equal(top.status, 200);
  const names = (top.body.entries as { name: string; kind: string; link?: boolean }[]).map((e) => `${e.kind}:${e.name}${e.link ? '@' : ''}`);
  assert.deepEqual(names.slice(0, 5), ['dir:.git', 'dir:bin', 'dir:escape@', 'dir:node_modules', 'dir:src']);
  assert.ok(names.includes('file:app-link.ts@'));
  const src = await call(wf, 'GET', at('list', 'src'));
  assert.deepEqual((src.body.entries as { path: string }[]).map((e) => e.path), ['src/app.ts']);
  assert.equal((await call(wf, 'GET', at('list', 'README.md'))).status, 400);
  const tree = (await call(wf, 'GET', at('tree'))).body.files as string[];
  assert.ok(tree.includes('src/app.ts') && tree.includes('README.md'));
  assert.ok(!tree.some((f) => f.startsWith('node_modules/') || f.startsWith('.git/') || f.startsWith('escape/')), tree.join(','));
});

test('a read is text, an image inline, a binary or too large placeholder; a symlink inside the workspace reads its target', async () => {
  const wf = fsOnly();
  const text = await call(wf, 'GET', at('read', 'src/app.ts'));
  assert.equal(text.body.kind, 'text');
  assert.equal(text.body.content, 'export const a = 1;\n');
  assert.match(String(text.body.modifiedAt), /^\d{4}-\d\d-\d\dT/);
  assert.equal((await call(wf, 'GET', at('read', 'app-link.ts'))).body.content, 'export const a = 1;\n');
  const bin = await call(wf, 'GET', at('read', 'bin/blob.dat'));
  assert.equal(bin.body.kind, 'binary');
  assert.equal(bin.body.content, undefined);
  const img = await call(wf, 'GET', at('read', 'logo.png'));
  assert.equal(img.body.kind, 'image');
  assert.match(String(img.body.dataUrl), /^data:image\/png;base64,/);
  const big = await call(wf, 'GET', at('read', 'big.txt'));
  assert.equal(big.body.kind, 'large');
  assert.equal(big.body.content, undefined);
  assert.equal((await call(wf, 'GET', at('read', 'src'))).status, 400);
  assert.equal((await call(wf, 'GET', at('read', 'missing.ts'))).status, 404);
  assert.equal((await call(wf, 'GET', at('stat', 'missing.ts'))).body.kind, 'missing');
  assert.ok(isBinary(Buffer.from('a\0b')) && !isBinary(Buffer.from('plain é text')));
});

test('a write needs the version read: it saves over it, refuses a file changed since, .git, a gone file and a GET', async () => {
  const wf = fsOnly();
  const read = await call(wf, 'GET', at('read', 'README.md'));
  const saved = await call(wf, 'POST', at('write'), { path: 'README.md', content: '# hello\n', expectedModifiedAt: read.body.modifiedAt });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# hello\n');
  const stale = await call(wf, 'POST', at('write'), { path: 'README.md', content: 'mine', expectedModifiedAt: read.body.modifiedAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.conflict, true);
  assert.equal(stale.body.modifiedAt, saved.body.modifiedAt);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# hello\n');
  assert.equal((await call(wf, 'POST', at('write'), { path: 'README.md', content: 'mine\n', expectedModifiedAt: stale.body.modifiedAt })).status, 200, 'overwrite once the owner saw the disk version');
  assert.equal((await call(wf, 'POST', at('write'), { path: '.git/config', content: 'x', expectedModifiedAt: 'x' })).status, 403);
  assert.equal((await call(wf, 'POST', at('write'), { path: 'gone.txt', content: 'x', expectedModifiedAt: 'x' })).status, 409);
  assert.equal((await call(wf, 'POST', at('write'), { path: 'README.md', content: 1, expectedModifiedAt: 'x' })).status, 400);
  assert.equal((await call(wf, 'POST', at('write'), { path: 'README.md', content: 'x' })).status, 400);
  assert.equal((await call(wf, 'POST', at('write'), 'not json')).status, 400);
  assert.equal((await call(wf, 'GET', `${at('write')}?path=README.md`)).status, 404);
  assert.equal(fs.existsSync(path.join(root, 'gone.txt')), false);
});

test('through Paseo: reads and writes take its answer, a conflict it reports is a 409', async () => {
  const writes: unknown[] = [];
  const paseo = {
    listDirectory: async () => ({ path: 'src', entries: [{ name: 'z.ts', path: 'src/z.ts', kind: 'file', size: 1, modifiedAt: 'm' }, { name: 'lib', path: 'src/lib', kind: 'directory', size: 0, modifiedAt: 'm' }] }),
    readFile: async (_c: string, p: string) => ({ bytes: new TextEncoder().encode(`paseo ${p}`), mime: 'text/plain', size: 9, path: p, kind: 'text', modifiedAt: 'paseo-m', revision: 'r1' }),
    writeFile: async (input: { content: string }) => (writes.push(input), input.content === 'clash' ? { status: 'conflict', version: { status: 'ready', cwd: root, path: 'x', size: 1, modifiedAt: 'newer' } } : { status: 'written', modifiedAt: 'paseo-w', size: 2, revision: 'r2' }),
  } as unknown as FilesApi;
  const wf = createWorkspaceFiles({ dirOf, files: async () => paseo });
  assert.deepEqual(((await call(wf, 'GET', at('list', 'src'))).body.entries as { path: string; kind: string }[]).map((e) => `${e.kind}:${e.path}`), ['dir:src/lib', 'file:src/z.ts']);
  const r = await call(wf, 'GET', at('read', 'src/app.ts'));
  assert.equal(r.body.content, 'paseo src/app.ts');
  assert.equal(r.body.revision, 'r1');
  const w = await call(wf, 'POST', at('write'), { path: 'src/app.ts', content: 'ok', expectedModifiedAt: 'paseo-m', expectedRevision: 'r1' });
  assert.equal(w.body.via, 'paseo');
  assert.deepEqual(writes[0], { cwd: root, path: 'src/app.ts', content: 'ok', expectedModifiedAt: 'paseo-m', expectedRevision: 'r1' });
  const clash = await call(wf, 'POST', at('write'), { path: 'src/app.ts', content: 'clash', expectedModifiedAt: 'paseo-m' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.modifiedAt, 'newer');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.ts'), 'utf8'), 'export const a = 1;\n', 'the fake daemon wrote nothing');
});

test('a watched file says ready, then changed once written and missing once deleted', async () => {
  const wf = fsOnly();
  put('live.txt', 'one\n');
  const got: { type: string; size?: number }[] = [];
  let close = () => {};
  const sink: Sink = { send: (json) => void got.push(JSON.parse(json)), onClose: (fn) => void (close = fn), closed: false };
  await wf.watch(sink, 'ws', 'live.txt');
  assert.equal(got[0].type, 'ready');
  const until = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(pred(), JSON.stringify(got));
  };
  await new Promise((r) => setTimeout(r, 30));
  put('live.txt', 'one\ntwo\n');
  await until(() => got.some((e) => e.type === 'changed' && e.size === 8));
  fs.rmSync(path.join(root, 'live.txt'));
  await until(() => got.some((e) => e.type === 'missing'));
  close();
  await assert.rejects(wf.watch(sink, 'ws', '../secret/key.txt'), /invalid path/);
  await assert.rejects(wf.watch(sink, 'ws', 'escape/key.txt'), /outside the workspace/);
});
