import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextOf, fromPaseo } from './agent-usage.ts';

test("Paseo's usage keeps the context window of the last turn beside the cumulative input and cost, and only when both its sizes are known", () => {
  assert.deepEqual(fromPaseo({ inputTokens: 6, cachedInputTokens: 94, totalCostUsd: 0.5, contextWindowUsedTokens: 96279, contextWindowMaxTokens: 1000000 }), { inputTokens: 100, costUsd: 0.5, contextTokens: 96279, contextMax: 1000000 });
  assert.deepEqual(contextOf({ contextWindowUsedTokens: 96279 }), {});
  assert.deepEqual(contextOf(null), {});
});
