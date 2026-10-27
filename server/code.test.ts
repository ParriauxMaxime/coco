import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCode } from './code.ts';

let dir = '';
let code: ReturnType<typeof createCode>;
let base = '';
let head = '';
const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const w = (f: string, c: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  };
  w('mod.txt', 'a\nb\nc\n');
  w('gone.txt', 'bye\n');
  w('old/name.txt', Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  base = git('rev-parse', 'HEAD');
  w('mod.txt', 'a\nB\nc\nd\n');
  w('new.txt', 'hello\nworld\n');
  w('blob.bin', Buffer.from([1, 2, 0, 3]));
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.mkdirSync(path.join(dir, 'new'), { recursive: true });
  git('mv', 'old/name.txt', 'new/name.txt');
  git('add', '-A');
  git('commit', '-qm', 'two');
  head = git('rev-parse', 'HEAD');
  code = createCode({ REPO: dir, config: { repo: { github: 'acme/widgets', defaultBranch: 'main' } }, works: { get: () => null, list: () => [] } });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('prFilesFromGit shape', async () => {
  const files = await code.prFilesFromGit(1, { headSha: head, baseSha: base });
  const by = Object.fromEntries(files.map((f) => [f.filename, f]));
  assert.deepEqual(by['new.txt'], { filename: 'new.txt', status: 'added', additions: 2, deletions: 0 });
  assert.deepEqual(by['mod.txt'], { filename: 'mod.txt', status: 'modified', additions: 2, deletions: 1 });
  assert.deepEqual(by['gone.txt'], { filename: 'gone.txt', status: 'removed', additions: 0, deletions: 1 });
  assert.deepEqual(by['new/name.txt'], { filename: 'new/name.txt', status: 'renamed', previous: 'old/name.txt', additions: 0, deletions: 0 });
  assert.equal(by['blob.bin'].status, 'added');
  assert.equal((await code.ensureRefs(1, { headSha: head, baseSha: base })).mergeBase, base);
  assert.equal(git('rev-parse', 'refs/cocopilot/head/1'), head);
  await code.dropRefs(1);
  assert.equal(execFileSync('git', ['-C', dir, 'for-each-ref', 'refs/cocopilot'], { encoding: 'utf8' }), '');
});

test('file: 404 outside tree, binary flag, text, traversal', async () => {
  await code.ensureRefs(2, { headSha: head, baseSha: base });
  const stub = (n: string) => `/api/code/pr/2/${n}`;
  const seed = async (u: string) => {
    const out: { status?: number; body: { binary?: boolean; text?: string } } = { body: {} };
    const p = new URL(u, 'http://x').pathname.split('/').filter(Boolean).slice(1);
    const req = new IncomingMessage(new Socket());
    req.method = 'GET';
    req.url = u;
    await code.handle(req, new ServerResponse(req), p, async () => '', (_r, status, body) => void Object.assign(out, { status, body }));
    return out;
  };
  assert.equal((await seed(stub('file?ref=head&path=missing.txt'))).status, 404);
  assert.equal((await seed(stub('file?ref=head&path=old'))).status, 404);
  const bin = await seed(stub('file?ref=head&path=blob.bin'));
  assert.equal(bin.body.binary, true);
  assert.equal(bin.body.text, '');
  const txt = await seed(stub('file?ref=head&path=mod.txt'));
  assert.equal(txt.body.text, 'a\nB\nc\nd\n');
  assert.equal((await seed(stub('file?ref=base&path=gone.txt'))).body.text, 'bye\n');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../b', 'old//name.txt']) {
    assert.equal((await seed(stub(`file?ref=head&path=${encodeURIComponent(bad)}`))).status, 400, bad);
  }
  assert.equal((await seed('/api/code/pr/2/nope')).status, 404);
  await code.dropRefs(2);
});

test('head: local branch tip when ahead of GitHub, GitHub head otherwise', async () => {
  const ahead = git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'unpushed');
  git('update-ref', 'refs/heads/feat', ahead);
  git('update-ref', 'refs/heads/stale', base);
  assert.equal((await code.ensureRefs(3, { headSha: head, baseSha: base, headRef: 'feat' })).headSha, ahead);
  assert.equal(git('rev-parse', 'refs/cocopilot/head/3'), ahead);
  assert.equal((await code.ensureRefs(4, { headSha: head, baseSha: base, headRef: 'stale' })).headSha, head);
  assert.equal((await code.ensureRefs(5, { headSha: head, baseSha: base, headRef: 'missing' })).headSha, head);
  await Promise.all([3, 4, 5].map((n) => code.dropRefs(n)));
});
