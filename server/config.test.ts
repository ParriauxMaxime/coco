import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, modelsFor } from './config.ts';
import type { Config, RepoConfig } from './config.ts';

const repo = (id: string, settings: RepoConfig['settings'] = {}): RepoConfig => ({
  id,
  name: id,
  path: `/src/${id}`,
  github: `acme/${id}`,
  defaultBranch: 'main',
  tsconfig: 'tsconfig.json',
  rules: [],
  reviewsDir: '.claude/reviews',
  commitConvention: '',
  settings,
});

const top = { default: 'omp/openrouter-deepseek', fast: 'omp/openrouter-deepseek' };
const config: Config = { ...DEFAULTS, models: { ...top, thinking: 'auto' }, repos: [repo('lempire'), repo('perso', { models: { default: 'claude/claude-opus-5-5', fast: 'claude/claude-sonnet-5-5', thinking: 'high' } }), repo('partial', { models: { default: 'claude/claude-opus-5-5' } })] };

test('models.thinking starts unset in the shipped defaults', () => {
  assert.equal(DEFAULTS.models.thinking, undefined);
});

test('a repo without settings.models runs on the top-level models', () => {
  assert.deepEqual(modelsFor(config, config.repos[0]), { default: 'omp/openrouter-deepseek', fast: 'omp/openrouter-deepseek', thinking: 'auto' });
  assert.deepEqual(modelsFor(config, null), { default: 'omp/openrouter-deepseek', fast: 'omp/openrouter-deepseek', thinking: 'auto' });
  assert.deepEqual(modelsFor(config, 'unknown'), { default: 'omp/openrouter-deepseek', fast: 'omp/openrouter-deepseek', thinking: 'auto' });
});

test('a repo overlays the models key by key: a key it leaves out stays the global one', () => {
  const partial = modelsFor(config, config.repos[2]);
  assert.deepEqual([partial.default, partial.fast, partial.thinking], ['claude/claude-opus-5-5', 'omp/openrouter-deepseek', 'auto']);
  const full = modelsFor(config, 'perso');
  assert.deepEqual([full.default, full.fast, full.thinking], ['claude/claude-opus-5-5', 'claude/claude-sonnet-5-5', 'high']);
});
