import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDevices, deviceName, pairOrigins } from './devices.ts';
import { loopbackHosts } from './guard.ts';
import type { Req, Res } from './core-types.ts';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-devices-')), 'devices.json');
const make = (clock = { t: Date.parse('2026-10-29T10:00:00Z') }) => ({ clock, devices: createDevices({ file: tmpFile(), loopback: loopbackHosts(8777), now: () => clock.t }) });
const phone = (cookie?: string) => ({ method: 'GET', headers: { host: 'mac.example.ts.net', 'x-forwarded-for': '100.64.0.7', ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Req;

function fakeRes() {
  const r = Object.assign(new EventEmitter(), { status: 0, headers: {} as Record<string, unknown>, body: '', destroyed: false });
  return Object.assign(r, {
    writeHead: (status: number, headers: Record<string, unknown>) => Object.assign(r, { status, headers }),
    end: (body = '') => void (r.body = body),
    destroy: () => void (r.destroyed = true, r.emit('close')),
  });
}

test('a code pairs one device, once', () => {
  const { devices } = make();
  const { code } = devices.newCode();
  const r = devices.redeem(code, 'Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A; wv) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 CocoAndroid');
  assert.ok('token' in r);
  assert.equal(r.device.name, 'coco app on Pixel 8');
  assert.equal(Buffer.from(r.token, 'base64url').length, 32);
  const again = devices.redeem(code);
  assert.ok('error' in again && again.status === 400, 'single use');
  assert.equal(devices.list().length, 1);
});

test('a code expires after five minutes', () => {
  const { clock, devices } = make();
  const { code } = devices.newCode();
  clock.t += 5 * 60_000 + 1;
  const r = devices.redeem(code);
  assert.ok('error' in r && r.status === 400);
  assert.equal(devices.list().length, 0);
});

test('codes are read case-insensitively, and ten wrong ones lock pairing for a minute', () => {
  const { clock, devices } = make();
  const { code } = devices.newCode();
  for (let i = 0; i < 10; i++) assert.equal((devices.redeem(`WRONG${i}`) as { status: number }).status, 400);
  assert.equal((devices.redeem(code) as { status: number }).status, 429, 'even the right code waits');
  clock.t += 60_001;
  assert.ok('token' in devices.redeem(code.toLowerCase()));
});

test('the store keeps a token\'s hash, never the token, and survives a restart', () => {
  const file = tmpFile();
  const devices = createDevices({ file, loopback: loopbackHosts(8777) });
  const r = devices.redeem(devices.newCode().code) as { token: string };
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(r.token));
  const after = createDevices({ file, loopback: loopbackHosts(8777) });
  assert.ok(after.who(phone(`coco_device=${r.token}`)));
});

test('GET /pair sets the cookie and goes on to coco, or to the app download, from a page of coco\'s origin', () => {
  const { devices } = make();
  for (const [query, to] of [['', '/'], ['&then=apk', '/mobile/coco.apk']]) {
    const res = fakeRes();
    devices.pair(phone(), res as unknown as Res, new URL(`https://mac.example.ts.net/pair?code=${devices.newCode().code}${query}`));
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(`<meta http-equiv="refresh" content="0;url=${to}">`));
    assert.match(String(res.headers['Set-Cookie']), /^coco_device=[\w-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=\d+$/);
  }
  const bad = fakeRes();
  devices.pair(phone(), bad as unknown as Res, new URL('https://mac.example.ts.net/pair?code=NOPE'));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers['Set-Cookie'], undefined);
});

test('revoking a device cuts its open streams', () => {
  const { devices } = make();
  const r = devices.redeem(devices.newCode().code) as { token: string; device: { id: string } };
  const d = devices.who(phone(`coco_device=${r.token}`));
  assert.ok(d && d !== 'local');
  const stream = fakeRes();
  devices.hold(d, stream as unknown as Res);
  assert.ok(devices.revoke(r.device.id));
  assert.equal(stream.destroyed, true);
  assert.equal(devices.revoke(r.device.id), false);
});

test('device names come from the User-Agent', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(deviceName(''), 'Browser');
});

test('the pairing addresses skip loopback, default to https and put tailnet names first', () => {
  assert.deepEqual(pairOrigins('http://127.0.0.1:8777', ['coco.localhost', 'Mac.Example.ts.net', 'localhost:8777']), ['https://mac.example.ts.net']);
  assert.deepEqual(pairOrigins('https://coco.example.com', ['coco.local', 'mac.example.ts.net']), ['https://mac.example.ts.net', 'https://coco.example.com', 'https://coco.local']);
});
