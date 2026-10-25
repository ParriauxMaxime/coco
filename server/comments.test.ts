import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createComments } from './comments.ts';
import { HttpError } from './core-types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comments-test-'));
const REPO = path.join(tmp, 'repo');
const sh = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const L = (n: number) => `line ${n}`;
const base = Array.from({ length: 60 }, (_, i) => L(i + 1));
const put = (name: string, lines: string[]) => fs.writeFileSync(path.join(REPO, name), lines.join('\n') + '\n');
const commit = (msg: string) => (sh('add', '-A'), sh('commit', '-q', '-m', msg), sh('rev-parse', 'HEAD'));
let c1 = '';
let c2 = '';
let c3 = '';
let c4 = '';
let c3Lines: string[] = [];

before(() => {
  fs.mkdirSync(REPO);
  sh('init', '-q');
  sh('config', 'user.email', 't@t');
  sh('config', 'user.name', 't');
  put('f.txt', base);
  c1 = commit('c1');
  // c2: edit line 10, insert 5 lines after line 20
  const v2 = [...base];
  v2[9] = 'line 10 edited';
  v2.splice(20, 0, ...Array.from({ length: 5 }, (_, i) => `inserted ${i + 1}`));
  put('f.txt', v2);
  c2 = commit('c2');
  // c3: rewrite lines 35-37 (old 30-32), move block old 50-52 (now 55-57) ten lines down
  const v3 = [...v2];
  v3.splice(34, 3, 'rewritten a', 'rewritten b', 'rewritten c');
  const block = v3.splice(54, 3);
  v3.splice(54 + 10 - 3, 0, ...block);
  c3Lines = v3;
  put('f.txt', v3);
  c3 = commit('c3');
  // c4: rename with a tiny edit
  sh('mv', 'f.txt', 'renamed.txt');
  put('renamed.txt', [...v3.slice(0, 58), 'tail tweak', ...v3.slice(59)]);
  c4 = commit('c4');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup() {
  const DATA = fs.mkdtempSync(path.join(tmp, 'data-'));
  fs.mkdirSync(path.join(DATA, 'works'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'works', 'w.json'), '{"slug":"w"}');
  return { DATA, comments: createComments({ DATA, REPO, config: { owner: { login: 'alice' } } }) };
}
type Comments = ReturnType<typeof createComments>;
const mk = (comments: Comments, startLine: number, endLine: number, extra: Record<string, unknown> = {}) => comments.add('w', 1, { path: 'f.txt', side: 'head', sha: c1, startLine, endLine, body: 'b', ...extra });

test('comment above an edit keeps its lines', async () => {
  const { comments } = setup();
  const c = await mk(comments, 3, 4);
  const r = await comments.reanchor('w', 1, { headSha: c2, mergeBase: null });
  assert.deepEqual(r, { updated: 1, outdated: 0, unchanged: 0 });
  const got = comments.list('w', 1).comments[0];
  assert.equal(got.id, c.id);
  assert.equal([got.startLine, got.endLine, got.sha, got.status].join(), `3,4,${c2},open`);
  assert.equal(got.snippet, 'line 3\nline 4');
});

test('comment below an inserted block shifts by the insert size and keeps its snippet', async () => {
  const { comments } = setup();
  const c = await mk(comments, 40, 42);
  await comments.reanchor('w', 1, { headSha: c2 });
  const got = comments.list('w', 1).comments[0];
  assert.deepEqual([got.startLine, got.endLine], [45, 47]);
  assert.equal(got.snippet, c.snippet);
  assert.equal(got.status, 'open');
});

test('rewritten lines become outdated and keep their old anchor', async () => {
  const { comments } = setup();
  const c = await mk(comments, 30, 32);
  const r = await comments.reanchor('w', 1, { headSha: c3 });
  assert.equal(r.outdated, 1);
  const got = comments.list('w', 1).comments[0];
  assert.equal(got.status, 'outdated');
  assert.equal([got.startLine, got.endLine, got.sha, got.snippet].join('|'), [30, 32, c1, c.snippet].join('|'));
});

test('a block moved 10 lines is found by the snippet search', async () => {
  const { comments } = setup();
  const c = await mk(comments, 50, 52);
  await comments.reanchor('w', 1, { headSha: c3 });
  const got = comments.list('w', 1).comments[0];
  const at = c3Lines.indexOf('line 50') + 1;
  assert.equal(got.status, 'open');
  assert.equal([got.startLine, got.endLine, got.sha].join(), `${at},${at + 2},${c3}`);
  assert.equal(got.snippet, c.snippet);
  assert.ok(at > 55 + 3);
});

test('a rename keeps the comment and updates its path', async () => {
  const { comments } = setup();
  await mk(comments, 3, 4, { sha: c3 });
  await comments.reanchor('w', 1, { headSha: c4 });
  const got = comments.list('w', 1).comments[0];
  assert.equal(got.path, 'renamed.txt');
  assert.equal([got.startLine, got.endLine, got.status].join(), '3,4,open');
  assert.equal(got.sha, c4);
});

test('fixed comments are left alone unless they still anchor', async () => {
  const { comments } = setup();
  const a = await mk(comments, 30, 32);
  const b = await mk(comments, 3, 4);
  await comments.update('w', 1, a.id, { status: 'fixed' });
  await comments.update('w', 1, b.id, { status: 'declined' });
  const r = await comments.reanchor('w', 1, { headSha: c3 });
  assert.deepEqual(r, { updated: 1, outdated: 0, unchanged: 1 });
  const [x, y] = comments.list('w', 1).comments;
  assert.equal([x.status, x.sha].join(), `fixed,${c1}`);
  assert.equal([y.status, y.sha].join(), `declined,${c3}`);
});

test('reanchor twice gives the same result', async () => {
  const { comments, DATA } = setup();
  await mk(comments, 3, 4);
  await mk(comments, 40, 42);
  await mk(comments, 30, 32);
  await mk(comments, 50, 52);
  await comments.reanchor('w', 1, { headSha: c3 });
  const first = comments.list('w', 1);
  const raw = fs.readFileSync(path.join(DATA, 'works/w/comments/pr-1.json'), 'utf8');
  const r2 = await comments.reanchor('w', 1, { headSha: c3 });
  assert.deepEqual(comments.list('w', 1), first);
  assert.equal(fs.readFileSync(path.join(DATA, 'works/w/comments/pr-1.json'), 'utf8'), raw);
  assert.equal(r2.updated, 0);
});

test('concurrent adds never interleave', async () => {
  const { comments } = setup();
  await Promise.all(Array.from({ length: 12 }, (_, i) => mk(comments, i + 1, i + 1)));
  assert.equal(comments.list('w', 1).comments.length, 12);
});

test('add validates; snippetFor returns 3+3 context, fewer near line 1', async () => {
  const { comments } = setup();
  const ok = { path: 'f.txt', side: 'head', sha: c1, startLine: 5, endLine: 5, body: 'x' };
  for (const bad of [{ path: '' }, { sha: undefined }, { startLine: undefined }, { endLine: undefined }, { body: '' }, { endLine: 4 }, { body: 'x'.repeat(5001) }, { startLine: 200, endLine: 200 }, { side: 'left' }, { sha: 'deadbeef' }]) {
    await assert.rejects(comments.add('w', 1, { ...ok, ...bad }), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(Object.keys(bad)));
  }
  const mid = await comments.snippetFor({ sha: c1, path: 'f.txt', startLine: 10, endLine: 11 });
  assert.deepEqual(mid, { snippet: 'line 10\nline 11', ctxBefore: ['line 7', 'line 8', 'line 9'], ctxAfter: ['line 12', 'line 13', 'line 14'] });
  const top = await comments.snippetFor({ sha: c1, path: 'f.txt', startLine: 2, endLine: 2 });
  assert.deepEqual(top.ctxBefore, ['line 1']);
  assert.equal(top.ctxAfter.length, 3);
  const end = await comments.snippetFor({ sha: c1, path: 'f.txt', startLine: 60, endLine: 60 });
  assert.deepEqual(end.ctxAfter, []);
  const c = await comments.add('w', 1, ok);
  assert.match(c.id, /^[0-9a-f]{12}$/);
  assert.equal(c.status, 'open');
  assert.equal(c.author, 'alice');
});

test('handle routes and error codes', async () => {
  const { comments } = setup();
  const call = async (method: string, parts: string[], body?: unknown) => {
    let out: { code: number; payload: { id: string; status: string; comments: unknown[] } } = { code: 0, payload: { id: '', status: '', comments: [] } };
    const req = new IncomingMessage(new Socket());
    req.method = method;
    await comments.handle(req, new ServerResponse(req), parts, async () => (body === undefined ? '' : JSON.stringify(body)), (_res, code, payload) => void (out = { code, payload: JSON.parse(JSON.stringify(payload)) }));
    return out;
  };
  const p = ['works', 'w', 'prs', '1', 'comments'];
  assert.equal((await call('GET', ['works', 'nope', 'prs', '1', 'comments'])).code, 404);
  assert.equal((await call('POST', p, { path: 'f.txt', sha: c1, startLine: 1 })).code, 400);
  const created = await call('POST', p, { path: 'f.txt', sha: c1, startLine: 1, endLine: 2, body: 'hey' });
  assert.equal(created.code, 200);
  const id = created.payload.id;
  assert.equal((await call('GET', p)).payload.comments.length, 1);
  assert.equal((await call('PUT', [...p, id], { status: 'sent', runId: 'r1' })).payload.status, 'sent');
  assert.equal((await call('PUT', [...p, id], { status: 'bogus' })).code, 400);
  assert.equal((await call('PUT', [...p, 'nope'], { body: 'x' })).code, 404);
  assert.deepEqual((await call('POST', [...p, 'reanchor'], { headSha: c2 })).payload, { updated: 1, outdated: 0, unchanged: 0 });
  assert.equal((await call('DELETE', [...p, id])).code, 200);
  assert.equal((await call('DELETE', [...p, id])).code, 404);
});
