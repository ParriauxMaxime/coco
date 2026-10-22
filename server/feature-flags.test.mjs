import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFeatureFlags } from './feature-flags.mjs';

test('without a provider every row needs no flag; with one, the provider answers for the work', async () => {
  const none = createFeatureFlags({ config: {}, REPO: '' });
  assert.deepEqual(none.forRow({ betaFlags: [{ code: 'x' }] }, 1), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));
  const file = path.join(dir, 'provider.mjs');
  fs.writeFileSync(file, 'export const createFeatureFlags = ({ REPO }) => ({ forRow: (work) => work.betaFlags.map((f) => ({ ...f, repo: REPO })), known: () => new Map() });\n');
  const flags = createFeatureFlags({ config: { featureFlags: { provider: file } }, REPO: '/src/widgets' });
  await flags.ready;
  assert.deepEqual(flags.forRow({ betaFlags: [{ code: 'darkMode' }] }, 1), [{ code: 'darkMode', repo: '/src/widgets' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
