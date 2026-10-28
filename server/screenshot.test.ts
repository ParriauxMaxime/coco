import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshots, resolveTarget } from './screenshot.ts';

const ORIGIN = 'http://127.0.0.1:8777';

test('a coco hash path opens on coco itself', () => {
  assert.deepEqual(resolveTarget('#/work/view-all-campaigns/plan', ORIGIN), { url: 'http://127.0.0.1:8777/#/work/view-all-campaigns/plan' });
  assert.deepEqual(resolveTarget('/#/agents', ORIGIN), { url: 'http://127.0.0.1:8777/#/agents' });
});

test('localhost dev servers on any port pass, other hosts only when configured', () => {
  for (const url of ['http://localhost:8790/#/agents', 'http://127.0.0.1:3000/', 'http://[::1]:8000/', 'http://app.localhost:5173/']) assert.equal('url' in resolveTarget(url, ORIGIN), true, url);
  assert.match((resolveTarget('https://example.com/', ORIGIN) as { error: string }).error, /host not allowed/);
  assert.match((resolveTarget('http://dev.lemlist.com:8000/', ORIGIN) as { error: string }).error, /host not allowed/);
  assert.deepEqual(resolveTarget('http://dev.lemlist.com:8000/app', ORIGIN, ['dev.lemlist.com']), { url: 'http://dev.lemlist.com:8000/app' });
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
