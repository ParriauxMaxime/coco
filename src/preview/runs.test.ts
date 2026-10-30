import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runsOf } from './runs.ts';
import type { WorkAgent } from '../types.ts';

const agent = (agentId: string, x: Partial<WorkAgent> = {}): WorkAgent => ({ id: `ag-${agentId}`, agentId, askId: null, kind: 'agent', title: agentId, pr: null, status: 'running', updatedAt: null, provider: null, thinking: null, openCards: 0, promptTokens: null, systemTokens: null, inputTokens: null, costUsd: null, ...x });
const shape = (runs: ReturnType<typeof runsOf>) => runs.map((r) => [r.chief.agentId, r.workers.map((w) => w.agentId)]);

test('without a parent edge every agent stays its own run, in its order', () => {
  assert.deepEqual(shape(runsOf([agent('a'), agent('b'), agent('c')])), [['a', []], ['b', []], ['c', []]]);
});

test('workers fold under the chief their root names, deeper ones too', () => {
  const list = [agent('w1', { parentAgentId: 'c', rootAgentId: 'c' }), agent('c', { rootAgentId: 'c' }), agent('solo', { rootAgentId: 'solo' }), agent('w2', { parentAgentId: 'w1', rootAgentId: 'c' })];
  assert.deepEqual(shape(runsOf(list)), [['c', ['w1', 'w2']], ['solo', []]]);
});

test('a worker whose chief is not listed stands alone', () => {
  assert.deepEqual(shape(runsOf([agent('w', { parentAgentId: 'gone', rootAgentId: 'gone' }), agent('ask', { agentId: null })])), [['w', []], [null, []]]);
});
