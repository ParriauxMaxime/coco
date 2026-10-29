import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshots, crossSite, resolveTarget } from './screenshot.ts';
import type { Req, Res } from './core-types.ts';

const ORIGIN = 'http://127.0.0.1:8777';

test('a coco hash path opens on coco itself', () => {
  assert.deepEqual(resolveTarget('#/work/view-all-campaigns/plan', ORIGIN), { url: 'http://127.0.0.1:8777/#/work/view-all-campaigns/plan' });
  assert.deepEqual(resolveTarget('/#/agents', ORIGIN), { url: 'http://127.0.0.1:8777/#/agents' });
});

test('localhost dev servers on any port pass, other hosts only when configured', () => {
  for (const url of ['http://localhost:8790/#/agents', 'http://127.0.0.1:3000/', 'http://[::1]:8000/', 'http://app.localhost:5173/']) assert.equal('url' in resolveTarget(url, ORIGIN), true, url);
  assert.match((resolveTarget('https://example.com/', ORIGIN) as { error: string }).error, /host not allowed/);
  assert.match((resolveTarget('http://dev.example.test:8000/', ORIGIN) as { error: string }).error, /host not allowed/);
  assert.deepEqual(resolveTarget('http://dev.example.test:8000/app', ORIGIN, ['dev.example.test']), { url: 'http://dev.example.test:8000/app' });
});

test('non-http schemes and empty targets are refused', () => {
  assert.match((resolveTarget('file:///etc/passwd', ORIGIN) as { error: string }).error, /only http/);
  assert.match((resolveTarget('  ', ORIGIN) as { error: string }).error, /url required/);
});

test('a missing Chrome fails clearly, and a refused host never launches it', async () => {
  const shots = createScreenshots({ chromePath: '/nowhere/chrome', origin: ORIGIN });
  await assert.rejects(shots.capture({ url: 'https://example.com' }), /host not allowed/);
  await assert.rejects(shots.capture({ url: '#/agents' }), /Chrome not found at \/nowhere\/chrome: .*screenshot\.chrome/);
  shots.stop();
});

type Sent = { code: number; body: { error?: string } };
async function call(method: string, query: string, headers: Record<string, string> = {}, body = '') {
  const shots = createScreenshots({ chromePath: '/nowhere/chrome', origin: ORIGIN });
  const sent: Sent[] = [];
  const req = { method, headers } as unknown as Req;
  await shots.handle(req, {} as Res, new URL(`http://127.0.0.1:8777/api/screenshot?${query}`), async () => body, (_res, code, b) => void sent.push({ code, body: b as Sent['body'] }));
  shots.stop();
  return sent[0];
}

test('a request from another site is refused before Chrome is touched; coco itself and a typed URL pass', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await call('GET', 'url=%23%2Fagents', { 'sec-fetch-site': site });
    assert.equal(r.code, 403);
    assert.match(r.body.error || '', /another site/);
  }
  assert.equal(crossSite({ headers: { 'sec-fetch-site': 'same-origin' } }), null);
  assert.equal(crossSite({ headers: {} }), null);
  assert.match((await call('GET', 'url=%23%2Fagents', { 'sec-fetch-site': 'none' })).body.error || '', /Chrome not found/);
});

test('eval and selector are refused on GET and taken from a POST body', async () => {
  for (const q of ['url=%23%2Fagents&eval=alert(1)', 'url=%23%2Fagents&selector=body']) {
    const r = await call('GET', q);
    assert.equal(r.code, 405);
    assert.match(r.body.error || '', /POST/);
  }
  assert.match((await call('POST', '', {}, JSON.stringify({ url: '#/agents', eval: '1', selector: 'body' }))).body.error || '', /Chrome not found/);
  assert.match((await call('POST', '', { 'sec-fetch-site': 'cross-site' }, JSON.stringify({ url: '#/agents', eval: '1' }))).body.error || '', /another site/);
  assert.equal((await call('POST', '', {}, '{nope')).code, 400);
});
