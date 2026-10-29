import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allowedHosts, guard, guarded, isLocal, loopbackHosts } from './guard.ts';
import { createDevices } from './devices.ts';
import type { Req } from './core-types.ts';

const hosts = allowedHosts(8777, 'http://coco.tail.ts.net:8777');
const g = (method: string, headers: { host?: string; origin?: string }) => guard(hosts, { method, headers });

test('allowed hosts pass', () => {
  for (const host of ['127.0.0.1:8777', 'localhost:8777', '127.0.0.1:8778', 'localhost:8778', 'coco.tail.ts.net:8777']) assert.equal(g('GET', { host }), null);
});
test('bad or missing host is refused', () => {
  assert.ok(g('GET', { host: 'evil.com:8777' }));
  assert.ok(g('GET', {}));
  assert.ok(g('POST', { host: 'evil.com' }));
});
test('foreign origin on a write is refused, a GET is not checked for origin', () => {
  assert.ok(g('POST', { host: '127.0.0.1:8777', origin: 'http://evil.com' }));
  assert.ok(g('DELETE', { host: '127.0.0.1:8777', origin: 'null' }));
  assert.ok(g('POST', { host: '127.0.0.1:8777', origin: 'https://evil.com' }));
  assert.ok(g('POST', { host: '127.0.0.1:8777', origin: 'file://127.0.0.1:8777' }));
  assert.equal(g('GET', { host: '127.0.0.1:8777', origin: 'http://evil.com' }), null);
});
test('own origin and no origin pass on a write', () => {
  assert.equal(g('POST', { host: '127.0.0.1:8777', origin: 'http://localhost:8778' }), null);
  assert.equal(g('POST', { host: '127.0.0.1:8777' }), null);
});
test('a shell (terminals, scripts, the event stream carrying them) refuses a foreign origin on a read too', () => {
  const read = (url: string, origin?: string) => guard(hosts, { method: 'GET', url, headers: { host: '127.0.0.1:8777', ...(origin ? { origin } : {}) } });
  for (const url of ['/api/workspaces/wks_a/terminals', '/api/workspaces/p.L3RtcA/scripts', '/api/events?sub=terminal:wks_a:t1', '/api/events']) {
    assert.ok(read(url, 'http://evil.com'), url);
    assert.equal(read(url, 'http://localhost:8778'), null, url);
    assert.equal(read(url), null, url);
  }
  assert.equal(read('/api/workspaces/wks_a/git/status', 'http://evil.com'), null, 'other reads keep the plain rule');
  assert.ok(guard(hosts, { method: 'POST', url: '/api/workspaces/wks_a/terminals/t1/input', headers: { host: '127.0.0.1:8777', origin: 'http://evil.com' } }));
  assert.ok(guard(hosts, { method: 'GET', url: '/api/workspaces/wks_a/terminals', headers: { host: 'evil.com:8777' } }), 'DNS rebinding');
  for (const p of ['/api/workspaces/wks_a/terminals/t1/input', '/api/events', '/works/x/a.png']) assert.ok(guarded(p), p);
  assert.equal(guarded('/assets/index.js'), false);
});
test('an agent\'s browser tab is refused on every guarded route, reads and screenshots included', () => {
  const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36 CocoAgentBrowser';
  for (const [method, url] of [['GET', '/api/works'], ['POST', '/api/agents/a1/mode'], ['GET', '/api/screenshot?url=%23%2F'], ['GET', '/works/x/a.png']]) {
    assert.ok(guard(hosts, { method, url, headers: { host: '127.0.0.1:8777', origin: 'http://127.0.0.1:8777', 'user-agent': ua } }), url);
  }
  assert.equal(guard(hosts, { method: 'POST', url: '/api/works', headers: { host: '127.0.0.1:8777', origin: 'http://127.0.0.1:8777', 'user-agent': ua.replace(' CocoAgentBrowser', '') } }), null);
});
test('a reverse proxy host from the config passes, with its https origin on a write', () => {
  const proxied = allowedHosts(8777, 'http://127.0.0.1:8777', ['Coco.local']);
  assert.equal(guard(proxied, { method: 'GET', headers: { host: 'coco.local' } }), null);
  assert.equal(guard(proxied, { method: 'POST', headers: { host: 'coco.local', origin: 'https://coco.local' } }), null);
  assert.ok(guard(proxied, { method: 'POST', headers: { host: 'coco.local', origin: 'https://evil.com' } }));
});

const loopback = loopbackHosts(8777);
const req = (headers: Record<string, string>, remoteAddress = '127.0.0.1') => ({ method: 'GET', url: '/', headers, socket: { remoteAddress } }) as unknown as Req;
const tunnel = (headers: Record<string, string> = {}) => req({ host: 'mac.example.ts.net', 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', ...headers });

test('only this Mac is local: loopback socket and Host, no proxy header', () => {
  for (const host of ['127.0.0.1:8777', 'localhost:8777', '127.0.0.1:8778', 'LOCALHOST:8778']) assert.ok(isLocal(loopback, req({ host })), host);
  assert.ok(isLocal(loopback, req({ host: '127.0.0.1:8777' }, '::ffff:127.0.0.1')));
  assert.ok(!isLocal(loopback, req({ host: 'mac.example.ts.net' })), 'a proxied Host');
  assert.ok(!isLocal(loopback, req({ host: '127.0.0.1:8777', 'x-forwarded-for': '100.64.0.7' })), 'a tunnel client faking a loopback Host');
  assert.ok(!isLocal(loopback, req({ host: '127.0.0.1:8777', forwarded: 'for=100.64.0.7' })));
  assert.ok(!isLocal(loopback, req({ host: '127.0.0.1:8777' }, '192.168.1.20')), 'a LAN client when bound to 0.0.0.0');
  assert.ok(!isLocal(loopback, req({ host: '127.0.0.1:9999' })));
});

test('a request is let in from this Mac without a token, from elsewhere only with a live device token', () => {
  const devices = createDevices({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-guard-')), 'devices.json'), loopback });
  assert.equal(devices.who(req({ host: '127.0.0.1:8777' })), 'local');
  assert.equal(devices.who(tunnel()), null, 'unpaired');
  assert.equal(devices.who(tunnel({ cookie: 'coco_device=forged' })), null, 'a made-up token');
  const r = devices.redeem(devices.newCode().code) as { token: string; device: { id: string } };
  const paired = tunnel({ cookie: `theme=dark; coco_device=${r.token}` });
  assert.equal((devices.who(paired) as { id: string }).id, r.device.id);
  devices.revoke(r.device.id);
  assert.equal(devices.who(paired), null, 'revoked');
});
