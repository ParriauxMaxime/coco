import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { encodingFor, send, sendFile } from './http-send.ts';
import { sseSink } from './events.ts';
import { EventEmitter } from 'node:events';
import type { Req, Res } from './core-types.ts';

type Out = { code: number; head: Record<string, string | number>; body: Buffer };

function fakeRes(headers: Record<string, string> = {}, method = 'GET', preset: Record<string, string> = {}) {
  const out: Out = { code: 0, head: {}, body: Buffer.alloc(0) };
  const res = {
    req: { method, headers },
    hasHeader: (n: string) => n.toLowerCase() in preset,
    writeHead: (code: number, head: Record<string, string | number>) => ((out.code = code), (out.head = head ?? {}), res),
    write: (c: string) => ((out.body = Buffer.concat([out.body, Buffer.from(c)])), true),
    end: (b?: Buffer | string) => void (b && (out.body = Buffer.concat([out.body, Buffer.from(b)]))),
  };
  return { res: res as unknown as Res, out };
}
const big = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, title: `work ${i}` })) };

test('a JSON GET carries a strong ETag and revalidates; the same tag answers 304 with no body', () => {
  const a = fakeRes();
  send(a.res, 200, { ok: true });
  assert.equal(a.out.code, 200);
  assert.equal(a.out.head['Cache-Control'], 'private, no-cache');
  const tag = String(a.out.head.ETag);
  assert.match(tag, /^"[\w-]{27}"$/);
  const b = fakeRes({ 'if-none-match': tag });
  send(b.res, 200, { ok: true });
  assert.equal(b.out.code, 304);
  assert.equal(b.out.body.length, 0);
  assert.equal(b.out.head.ETag, tag);
  const c = fakeRes({ 'if-none-match': tag });
  send(c.res, 200, { ok: false });
  assert.equal(c.out.code, 200);
  assert.notEqual(c.out.head.ETag, tag);
});

test('no ETag on a write, an error, an explicit no-store, a non-JSON default or a response setting a cookie', () => {
  const cases: [ReturnType<typeof fakeRes>, () => void][] = [];
  const post = fakeRes({}, 'POST');
  cases.push([post, () => send(post.res, 200, { ok: true })]);
  const err = fakeRes();
  cases.push([err, () => send(err.res, 404, { error: 'x' })]);
  const store = fakeRes();
  cases.push([store, () => send(store.res, 200, { png: 'x' }, 'application/json', 'no-store')]);
  const text = fakeRes();
  cases.push([text, () => send(text.res, 200, 'plain', 'text/plain')]);
  const cookie = fakeRes({}, 'GET', { 'set-cookie': 'a=b' });
  cases.push([cookie, () => send(cookie.res, 200, { ok: true })]);
  for (const [r, run] of cases) {
    run();
    assert.equal(r.out.head.ETag, undefined);
  }
  assert.equal(text.out.head['Cache-Control'], 'no-store');
});

test('a JSON body over 1 KB goes brotli when accepted, else gzip, and a small one or a refusing client gets it plain', () => {
  const raw = JSON.stringify(big);
  const br = fakeRes({ 'accept-encoding': 'gzip, deflate, br' });
  send(br.res, 200, big);
  assert.equal(br.out.head['Content-Encoding'], 'br');
  assert.equal(br.out.head.Vary, 'Accept-Encoding');
  assert.equal(zlib.brotliDecompressSync(br.out.body).toString(), raw);
  assert.ok(br.out.body.length < raw.length / 3);
  const gz = fakeRes({ 'accept-encoding': 'gzip' });
  send(gz.res, 200, big);
  assert.equal(gz.out.head['Content-Encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.out.body).toString(), raw);
  assert.notEqual(gz.out.head.ETag, br.out.head.ETag);
  // a tag stored under one encoding revalidates under another: the content is the same
  const again = fakeRes({ 'accept-encoding': 'br', 'if-none-match': String(gz.out.head.ETag) });
  send(again.res, 200, big);
  assert.equal(again.out.code, 304);
  const plain = fakeRes({ 'accept-encoding': 'br;q=0, gzip;q=0' });
  send(plain.res, 200, big);
  assert.equal(plain.out.head['Content-Encoding'], undefined);
  assert.equal(plain.out.body.toString(), raw);
  const small = fakeRes({ 'accept-encoding': 'br' });
  send(small.res, 200, { ok: true });
  assert.equal(small.out.head['Content-Encoding'], undefined);
  const png = fakeRes({ 'accept-encoding': 'br' });
  send(png.res, 200, Buffer.alloc(4096), 'image/png');
  assert.equal(png.out.head['Content-Encoding'], undefined);
  assert.equal(png.out.head.Vary, undefined);
});

test('encodingFor reads q-values and the wildcard', () => {
  assert.equal(encodingFor(undefined), null);
  assert.equal(encodingFor('gzip, br'), 'br');
  assert.equal(encodingFor('br;q=0, gzip'), 'gzip');
  assert.equal(encodingFor('*'), 'gzip');
  assert.equal(encodingFor('identity'), null);
});

test('an SSE stream keeps its own head: no ETag, no compression', () => {
  const req = new EventEmitter() as unknown as Req;
  const { res, out } = fakeRes({ 'accept-encoding': 'br' });
  sseSink(req, res).send(JSON.stringify(big));
  assert.equal(out.head['Content-Type'], 'text/event-stream');
  assert.equal(out.head['Cache-Control'], 'no-store');
  assert.equal(out.head.ETag, undefined);
  assert.equal(out.head['Content-Encoding'], undefined);
  assert.ok(out.body.toString().startsWith('data: {"items"'));
});

test('sendFile serves a precompressed sibling when present, else compresses once per mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-send-'));
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, 'console.log(1);\n'.repeat(200));
  const imm = 'public, max-age=31536000, immutable';
  const a = fakeRes({ 'accept-encoding': 'br' });
  sendFile(a.res, file, 'text/javascript', imm);
  assert.equal(a.out.head['Content-Encoding'], 'br');
  assert.equal(a.out.head['Cache-Control'], imm);
  assert.equal(a.out.head.ETag, undefined);
  assert.equal(zlib.brotliDecompressSync(a.out.body).toString(), fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(`${file}.gz`, 'PRECOMPRESSED');
  const b = fakeRes({ 'accept-encoding': 'gzip' });
  sendFile(b.res, file, 'text/javascript', imm);
  assert.equal(b.out.body.toString(), 'PRECOMPRESSED');
  const page = path.join(dir, 'favicon.svg');
  fs.writeFileSync(page, '<svg/>');
  const c = fakeRes();
  sendFile(c.res, page, 'image/svg+xml', 'no-cache');
  assert.ok(c.out.head.ETag);
  fs.rmSync(dir, { recursive: true, force: true });
});
