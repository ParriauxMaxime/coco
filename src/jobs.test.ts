import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_MS, unannounced } from './jobs.ts';
import type { Job } from './types.ts';

const at = (ms: number) => new Date(ms).toISOString();
const job = (x: Partial<Job>): Job => ({ id: 'j', work: 'w', pr: null, action: 'tidy', label: 'Tidy history', kind: 'agent', state: 'failed', agentId: null, startedAt: at(0), endedAt: null, output: '', error: '', ...x });

test('a job first seen failed or lost is announced, even when its running render never landed', () => {
  const now = Date.now();
  const failed = job({ id: 'f', endedAt: at(now - 500), error: "Provider 'omp' cannot preapprove exact MCP tools" });
  const lost = job({ id: 'l', state: 'lost', endedAt: at(now - 500) });
  assert.deepEqual(unannounced([failed, lost], new Set(), now), [failed, lost]);
});

test('an announced id is not said twice', () => {
  const now = Date.now();
  const j = job({ id: 'f', endedAt: at(now - 500) });
  assert.deepEqual(unannounced([j], new Set(['f']), now), []);
});

test('a failure older than the recent window is not replayed when a page opens, and nothing else announces', () => {
  const now = Date.now();
  const old = job({ id: 'old', endedAt: at(now - RECENT_MS - 1) });
  const running = job({ id: 'run', state: 'running' });
  const done = job({ id: 'ok', state: 'done', endedAt: at(now - 100) });
  assert.deepEqual(unannounced([old, running, done], new Set(), now), []);
});

test('a dismissed failure absent from the list adds nothing to announce', () => {
  assert.deepEqual(unannounced([], new Set(['f']), Date.now()), []);
});
