import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCode } from './code.mjs';

let dir, code, base, head;
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const w = (f, c) => {
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
  code = createCode({ REPO: dir, config: { repo: { github: 'acme/widgets', defaultBranch: 'main' } }, works: {} });
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
  const stub = (n) => `/api/code/pr/2/${n}`;
  const seed = async (u) => {
    const out = {};
    const p = new URL(u, 'http://x').pathname.split('/').filter(Boolean).slice(1);
    await code.handle({ method: 'GET', url: u }, {}, p, null, (_r, status, body) => Object.assign(out, { status, body }));
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
