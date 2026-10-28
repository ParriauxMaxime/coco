import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHosts, guard, guarded } from './guard.ts';

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
