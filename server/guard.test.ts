import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedHosts, guard } from './guard.ts';

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
  assert.ok(g('POST', { host: '127.0.0.1:8777', origin: 'https://127.0.0.1:8777' }));
  assert.equal(g('GET', { host: '127.0.0.1:8777', origin: 'http://evil.com' }), null);
});
test('own origin and no origin pass on a write', () => {
  assert.equal(g('POST', { host: '127.0.0.1:8777', origin: 'http://localhost:8778' }), null);
  assert.equal(g('POST', { host: '127.0.0.1:8777' }), null);
});
