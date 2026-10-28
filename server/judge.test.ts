import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJudge, judgeModels } from './judge.ts';

type Answer = { status: string; finalText: string; error?: string } | Error;

function setup(models: { default: string; fast: string; judge?: string }, answers: Answer[]) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-judge-'));
  const providers: string[] = [];
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const judge = createJudge({
    DATA,
    config: { models },
    agents: {
      run: async ({ provider }) => {
        providers.push(provider);
        clock += 500;
        const next = answers.shift() || { status: 'done', finalText: '[]' };
        if (next instanceof Error) throw next;
        return next;
      },
    },
    now: () => clock,
  });
  const ask = { kind: 'brief-lessons', parse: (t: string) => (t.startsWith('[') ? (JSON.parse(t) as string[]) : null), title: 'Brief lessons', prompt: 'judge this', labels: {}, workspaceId: 'wks_plan', cwd: '/tmp', timeoutMs: 1000 };
  const log = () => fs.readFileSync(path.join(DATA, 'judge-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { judge, ask, providers, log };
}

test('the judge model defaults to the fast model, then the default one, and falls back to fast', () => {
  assert.deepEqual(judgeModels({ default: 'claude/opus', fast: 'claude/sonnet' }), ['claude/sonnet']);
  assert.deepEqual(judgeModels({ default: 'claude/opus', fast: '' }), ['claude/opus']);
  assert.deepEqual(judgeModels({ default: 'claude/opus', fast: 'claude/sonnet', judge: 'opencode/ollama/qwen3' }), ['opencode/ollama/qwen3', 'claude/sonnet']);
});

test('a decision runs on the judge model and is logged with the model, a hash of the prompt and the time it took', async () => {
  const { judge, ask, providers, log } = setup({ default: 'claude/opus', fast: 'claude/sonnet', judge: 'opencode/ollama/qwen3' }, [{ status: 'done', finalText: '["a"]' }]);
  assert.deepEqual(await judge.decide(ask), ['a']);
  assert.deepEqual(providers, ['opencode/ollama/qwen3']);
  const [d] = log();
  assert.deepEqual({ ...d, input: undefined }, { at: '2026-10-28T12:00:00.000Z', kind: 'brief-lessons', model: 'opencode/ollama/qwen3', input: undefined, output: ['a'], ms: 500 });
  assert.match(d.input, /^[0-9a-f]{16}$/);
});

test('a judge model that fails, throws or answers nothing parseable hands the decision to the fast model', async () => {
  const models = { default: 'claude/opus', fast: 'claude/sonnet', judge: 'opencode/ollama/qwen3' };
  for (const bad of [{ status: 'error', finalText: '', error: 'ollama down' }, new Error('no provider'), { status: 'done', finalText: 'none' }]) {
    const { judge, ask, providers, log } = setup(models, [bad, { status: 'done', finalText: '[]' }]);
    assert.deepEqual(await judge.decide(ask), []);
    assert.deepEqual(providers, ['opencode/ollama/qwen3', 'claude/sonnet']);
    assert.ok(log()[0].error);
    assert.equal(log()[1].error, undefined);
  }
});

test('when every model fails, the decision throws the last error', async () => {
  const { judge, ask, log } = setup({ default: 'claude/opus', fast: 'claude/sonnet', judge: 'opencode/ollama/qwen3' }, [{ status: 'error', finalText: '', error: 'ollama down' }, { status: 'done', finalText: 'nope' }]);
  await assert.rejects(judge.decide(ask), /claude\/sonnet answered nothing parseable/);
  assert.deepEqual(log().map((d) => d.error), ['ollama down', 'claude/sonnet answered nothing parseable']);
});
