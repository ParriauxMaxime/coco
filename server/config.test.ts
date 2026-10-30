import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, agentMcpFor, mcpServersFor, modelsFor } from './config.ts';
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

test('models.thinking starts unset and no connector server ships in the defaults', () => {
  assert.equal(DEFAULTS.models.thinking, undefined);
  assert.deepEqual(DEFAULTS.mcpServers, {});
  assert.deepEqual(DEFAULTS.agentMcp, []);
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

const stdio = (command: string) => ({ type: 'stdio' as const, command });
const connectors: Config = {
  ...config,
  mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' }, slack: stdio('slack-mcp-server') },
  agentMcp: ['slack'],
  repos: [repo('lempire', { mcpServers: { gmail: stdio('gmail-mcp') } }), repo('perso'), repo('quiet', { agentMcp: [] })],
};

test('a repo adds MCP servers by name and picks what the agents you talk to mount', () => {
  assert.deepEqual(Object.keys(mcpServersFor(config, 'lempire')), []);
  assert.deepEqual(Object.keys(mcpServersFor(connectors, 'lempire')).sort(), ['gmail', 'notion', 'slack']);
  assert.deepEqual(Object.keys(mcpServersFor(connectors, 'perso')).sort(), ['notion', 'slack']);
  assert.deepEqual([agentMcpFor(connectors, 'lempire'), agentMcpFor(connectors, 'perso'), agentMcpFor(connectors, 'quiet'), agentMcpFor(connectors, null)], [['slack'], ['slack'], [], ['slack']]);
});