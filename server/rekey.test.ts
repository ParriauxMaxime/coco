import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rekeyValue, rekeyWorkFiles } from './rekey.ts';
import { currentKey } from './stack.ts';

const FROM = 'b:fix:a';

test('rekeyValue names the new key in keys and thread keys, never in absolute paths', () => {
  const thread = { key: 'c.b~fix~a.ab12', waiting: { replyPath: '/d/threads/c.b~fix~a.ab12-0011aabb-reply.json' }, n: FROM, other: 'b:fix:ab', items: ['p.b~fix~a', 'c.b~fix~ab.ff'] };
  assert.deepEqual(rekeyValue(thread, FROM, 42), { key: 'c.42.ab12', waiting: { replyPath: '/d/threads/c.b~fix~a.ab12-0011aabb-reply.json' }, n: 42, other: 'b:fix:ab', items: ['p.42', 'c.b~fix~ab.ff'] });
});

test('rekeyWorkFiles moves the row files to the number and leaves agent-held paths and other rows alone', () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-rekey-'));
  const root = path.join(DATA, 'works', 'w');
  const put = (rel: string, body: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  put('comments/pr-b~fix~a.json', { number: FROM, comments: [] });
  put('comments/pr-b~fix~ab.json', { number: 'b:fix:ab', comments: [] });
  put('reviews/pr-b~fix~a-plan.json', { plan: 1 });
  put('reviews/pr-b~fix~a-run-r1.json', { number: FROM, resultPath: '/x/pr-b~fix~a-run-r1-result.json' });
  put('reviews/pr-b~fix~a-run-r1-result.json', { ok: true });
  put('reviews/stack-run-s1.json', { rows: [{ key: FROM }, { key: 7 }] });
  put('threads/c.b~fix~a.ab12.json', { key: 'c.b~fix~a.ab12' });
  put('threads/c.b~fix~a.ab12.activity.jsonl', '{}\n');
  put('threads/c.b~fix~a.ab12-0011aabb-reply.json', { text: 'hi' });
  put('groups/abc123.json', { n: FROM, items: ['c.b~fix~a.ab12'] });
  put('artifacts/.meta.json', { 'body.md': { pr: FROM }, 'x.md': { pr: '7' } });
  put('artifacts/briefs/pr-b~fix~a-2026-10-29.md', '# brief');
  put('findings-cache/b~fix~a.json', {});
  rekeyWorkFiles(DATA, 'w', FROM, 42);
  const ls = (d: string) => fs.readdirSync(path.join(root, d)).sort();
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  assert.deepEqual(ls('comments'), ['pr-42.json', 'pr-b~fix~ab.json']);
  assert.equal(read('comments/pr-42.json').number, 42);
  assert.deepEqual(ls('reviews'), ['pr-42-plan.json', 'pr-42-run-r1.json', 'pr-b~fix~a-run-r1-result.json', 'stack-run-s1.json']);
  assert.equal(read('reviews/pr-42-run-r1.json').resultPath, '/x/pr-b~fix~a-run-r1-result.json');
  assert.deepEqual(read('reviews/stack-run-s1.json').rows, [{ key: 42 }, { key: 7 }]);
  assert.deepEqual(ls('threads'), ['c.42.ab12.activity.jsonl', 'c.42.ab12.json', 'c.b~fix~a.ab12-0011aabb-reply.json']);
  assert.equal(read('threads/c.42.ab12.json').key, 'c.42.ab12');
  assert.deepEqual(read('groups/abc123.json'), { n: 42, items: ['c.42.ab12'] });
  assert.deepEqual(read('artifacts/.meta.json'), { 'body.md': { pr: '42' }, 'x.md': { pr: '7' } });
  assert.deepEqual(ls('artifacts/briefs'), ['pr-42-2026-10-29.md']);
  assert.equal(fs.existsSync(path.join(root, 'findings-cache')), false);
});

test('currentKey: a branch key of a row that got its PR is its number; any other key stays', () => {
  const work = { stack: [{ number: 42, planned: { branch: 'fix/a' } }, { number: null, planned: { branch: 'fix/b' } }] };
  assert.equal(currentKey(work, FROM), 42);
  assert.equal(currentKey(work, 'b:fix:b'), 'b:fix:b');
  assert.equal(currentKey(work, 'b:fix:c'), 'b:fix:c');
  assert.equal(currentKey(work, 7), 7);
});
