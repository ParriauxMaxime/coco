import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createCode } from './code.ts';
import type { Blame } from './blame.ts';

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

type Body = { binary?: boolean; text?: string; headSha?: string; mergeBase?: string; files?: { filename: string }[]; unified?: string };
const seed = async (u: string) => {
  const out: { status?: number; body: Body } = { body: {} };
  const p = new URL(u, 'http://x').pathname.split('/').filter(Boolean).slice(1);
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = u;
  await code.handle(req, new ServerResponse(req), p, async () => '', (_r, status, body) => void Object.assign(out, { status, body }));
  return out;
};

test('blame: each line names its last commit, those of the PR flagged', async () => {
  await code.ensureRefs(1, { headSha: head, baseSha: base });
  const { body, status } = await seed(`/api/code/pr/1/blame?path=mod.txt`);
  const b = body as unknown as Blame;
  assert.equal(status, 200);
  assert.deepEqual(b.lines, [base, head, base, head]);
  assert.deepEqual(b.commits[head], { author: 't', email: 't@t', time: b.commits[head].time, summary: 'two', inPr: true });
  assert.equal(b.commits[base].inPr, false);
  assert.equal(b.github, 'acme/widgets');
  assert.deepEqual((await seed(`/api/code/pr/1/blame?ref=base&path=mod.txt`)).body, { ...b, lines: [base, base, base], commits: { [base]: b.commits[base] } });
  assert.equal(((await seed(`/api/code/commit/${head}/blame?path=mod.txt`)).body as unknown as Blame).lines.length, 4);
});

test('commit: files and texts of one commit against its parent', async () => {
  const refs = (await seed(`/api/code/commit/${head}/refs`)).body;
  assert.equal(refs.mergeBase, base);
  assert.ok(refs.files?.some((f) => f.filename === 'new.txt'));
  assert.equal((await seed(`/api/code/commit/${head.slice(0, 9)}/file?ref=base&path=mod.txt`)).body.text, 'a\nb\nc\n');
  assert.equal((await seed(`/api/code/commit/${head}/file?path=mod.txt`)).body.text, 'a\nB\nc\nd\n');
  assert.match((await seed(`/api/code/commit/${head}/diff?path=mod.txt`)).body.unified ?? '', /\+B/);
  assert.equal((await seed(`/api/code/commit/${base}/refs`)).status, 400);
  assert.equal((await seed('/api/code/commit/nothex/refs')).status, 400);
});

test('file: 404 outside tree, binary flag, text, traversal', async () => {
  await code.ensureRefs(2, { headSha: head, baseSha: base });
  const stub = (n: string) => `/api/code/pr/2/${n}`;
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

test('repoOf: a row of a work in another repo reads that repo, with its default branch', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'code-test-two-'));
  const git2 = (...a: string[]) => execFileSync('git', ['-C', dir2, ...a], { encoding: 'utf8' }).trim();
  try {
    git2('init', '-q', '-b', 'trunk');
    git2('config', 'user.email', 't@t');
    git2('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir2, 'two.txt'), 'one\n');
    git2('add', '.');
    git2('commit', '-qm', 'trunk');
    const trunk = git2('rev-parse', 'HEAD');
    git2('checkout', '-qb', 'side');
    fs.writeFileSync(path.join(dir2, 'two.txt'), 'two\n');
    git2('commit', '-qam', 'side');
    const side = git2('rev-parse', 'HEAD');
    const work = { slug: 'w2', repo: 'two', stack: [{ planned: { branch: 'side' } }] };
    const repoOf = (w: { repo?: string | null } | null | undefined) => (w?.repo === 'two' ? { path: dir2, github: 'acme/two', defaultBranch: 'trunk' } : { path: dir, github: 'acme/widgets', defaultBranch: 'main' });
    const two = createCode({ REPO: dir, works: { get: () => null, list: () => [work] as never }, repoOf });
    const refs = await two.ensureRefs('b:side');
    assert.deepEqual([refs.headSha, refs.baseSha, refs.mergeBase], [side, trunk, trunk]);
    assert.deepEqual((await two.prFilesFromGit('b:side')).map((f) => f.filename), ['two.txt']);
    const out: { status?: number; body: Body } = { body: {} };
    const req = Object.assign(new IncomingMessage(new Socket()), { method: 'GET', url: `/api/code/commit/${side}/refs` });
    await two.handle(req, new ServerResponse(req), ['code', 'commit', side, 'refs'], async () => '', (_r, status, body) => void Object.assign(out, { status, body }));
    assert.equal(out.body.mergeBase, trunk);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
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
