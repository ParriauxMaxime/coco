import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaseoHealth, diagnosticReason } from './paseo-health.ts';
import type { ConnectionState, DaemonConnection, ProviderEntry } from './paseo-agent.ts';

const CODEX = 'Codex\n  Binary: codex\n  Resolved path: not found\n  Version: unknown\n  Status: Unavailable';

function fakeClient(entries: ProviderEntry[]) {
  const listeners = new Set<(s: ConnectionState) => void>();
  let state: ConnectionState = { status: 'connected' };
  const calls: string[] = [];
  const connection: DaemonConnection = {
    state: () => state,
    onChange: (l) => (listeners.add(l), () => listeners.delete(l)),
    lastError: () => (state.status === 'connected' ? null : 'socket closed'),
    version: () => '0.14.0',
    reconnect: () => void calls.push('reconnect'),
  };
  const providers = {
    snapshot: async () => (calls.push('snapshot'), { entries }),
    refresh: async () => void calls.push('refresh'),
    diagnostic: async (p: string) => (calls.push(`diagnostic:${p}`), { diagnostic: p === 'codex' ? CODEX : null }),
  };
  const set = (s: ConnectionState) => {
    state = s;
    listeners.forEach((l) => l(s));
  };
  return { client: { connection, providers }, calls, set };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('a provider out says why: its own error, else its binary missing or the status line of its diagnostic', () => {
  assert.equal(diagnosticReason(CODEX), 'codex not found on PATH');
  assert.equal(diagnosticReason('OpenCode\n  Resolved path: /opt/homebrew/bin/opencode\n  Status: Not authenticated'), 'Not authenticated');
  assert.equal(diagnosticReason(null), null);
});

test('connected: the version and each provider, the diagnostic asked only for an enabled provider out without an error', async () => {
  const fake = fakeClient([
    { provider: 'claude', status: 'ready', enabled: true, label: 'Claude' },
    { provider: 'codex', status: 'unavailable', enabled: true, label: 'Codex' },
    { provider: 'muse', status: 'error', enabled: true, label: 'Muse', error: 'muse not found on PATH' },
    { provider: 'omp', status: 'unavailable', enabled: false, label: 'Oh My Pi' },
  ]);
  const health = createPaseoHealth({ client: async () => fake.client });
  await health.health();
  await tick();
  const h = health.current();
  assert.deepEqual([h.state, h.version, h.reason], ['connected', '0.14.0', null]);
  assert.deepEqual(h.providers.map((p) => [p.id, p.status, p.reason]), [['claude', 'ready', null], ['codex', 'unavailable', 'codex not found on PATH'], ['muse', 'error', 'muse not found on PATH'], ['omp', 'unavailable', null]]);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('diagnostic')), ['diagnostic:codex']);
});

test('a lost connection reads reconnecting, then down past the delay, and connected again once the SDK is back', async () => {
  let t = 0;
  const fake = fakeClient([]);
  const health = createPaseoHealth({ client: async () => fake.client, now: () => t, downAfterMs: 1000 });
  const seen: string[] = [];
  health.onChange(() => seen.push(health.current().state));
  await health.boot();
  t = 10;
  fake.set({ status: 'disconnected', reason: 'socket closed', nextRetryAt: '2026-10-28T10:00:00Z' });
  assert.deepEqual([health.current().state, health.current().reason, health.current().nextRetryAt], ['reconnecting', 'socket closed', '2026-10-28T10:00:00Z']);
  t = 2000;
  assert.equal(health.current().state, 'down');
  fake.set({ status: 'connected' });
  assert.equal(health.current().state, 'connected');
  assert.deepEqual(seen.slice(-2), ['reconnecting', 'connected']);
});

test('an unreachable daemon reads down with the error, and coco tries again', async () => {
  let tries = 0;
  const fake = fakeClient([]);
  const health = createPaseoHealth({ client: async () => (++tries === 1 ? Promise.reject(new Error('cannot reach the Paseo daemon at ws://127.0.0.1:6767/ws')) : fake.client), retryMs: 5 });
  await health.boot();
  assert.deepEqual([health.current().state, health.current().reason], ['down', 'cannot reach the Paseo daemon at ws://127.0.0.1:6767/ws']);
  await tick();
  await tick();
  assert.equal(health.current().state, 'connected');
});

test('a restart runs paseo daemon restart once at a time, then nudges the client; a refresh asks the daemon to look at its providers again', async () => {
  const fake = fakeClient([{ provider: 'opencode', status: 'ready', enabled: true, label: 'OpenCode' }]);
  const ran: string[][] = [];
  let finish: (r: { ok: boolean; stdout: string; stderr: string }) => void = () => {};
  const health = createPaseoHealth({ client: async () => fake.client, exec: (cmd, args) => (ran.push([cmd, ...args]), new Promise((r) => (finish = r))) });
  await health.boot();
  assert.equal(health.restart().restarting, true);
  assert.throws(() => health.restart(), /already restarting/);
  assert.deepEqual(ran, [['paseo', 'daemon', 'restart', '--json', '--timeout', '120']]);
  finish({ ok: false, stdout: '', stderr: 'daemon did not come back' });
  await tick();
  assert.deepEqual([health.current().restarting, health.current().restartError], [false, 'daemon did not come back']);
  assert.ok(fake.calls.includes('reconnect'));
  const after = await health.refreshProviders();
  assert.ok(fake.calls.includes('refresh'));
  assert.deepEqual(after.providers.map((p) => p.id), ['opencode']);
});
