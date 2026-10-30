import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackSend, slackToken } from './slack-send.ts';
import type { Config } from './config.ts';
import type { Card } from './cards.ts';

const config: Pick<Config, 'mcpServers'> = {
  mcpServers: { slack: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server@1.3.0'], env: { SLACK_MCP_XOXP_TOKEN: 'xoxp-secret' } } },
};
const cardOf = (action: unknown, answer?: unknown) => ({ action, answer }) as unknown as Card;

test('the Slack token is the one the MCP server runs on', () => {
  assert.equal(slackToken(config), 'xoxp-secret');
  assert.equal(slackToken({ mcpServers: {} }), null);
  assert.equal(slackToken({ mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }), null);
});

test('a message becomes a confirm card showing the channel and the text, and is refused without a token', async () => {
  const { cardAction } = createSlackSend({ config, post: async () => ({ channel: 'C1', ts: 't' }) });
  const out = await cardAction.card({ channel: '#general', text: 'Post the update', why: 'announce the release' }, {} as never);
  assert.equal(out.card.kind, 'confirm');
  assert.equal(out.card.title, 'Slack: #general');
  assert.equal(out.card.question, 'announce the release');
  assert.deepEqual(out.card.fields, [{ key: 'text', label: 'Message', type: 'textarea', default: 'Post the update', required: true }]);
  assert.equal(out.card.confirmLabel, 'Post to Slack');
  assert.throws(() => createSlackSend({ config: { mcpServers: {} } }).cardAction.card({ channel: '#general', text: 'x' }, {} as never), /no Slack token/);
});

test('only an approved card posts, with the text as edited on it', async () => {
  const sent: [string, string, string][] = [];
  const { cardAction } = createSlackSend({ config, post: async (token, channel, text) => (sent.push([token, channel, text]), { channel, ts: '1750000000.1' }) });
  const out = await cardAction.run(cardOf({ input: { channel: '#general', text: 'Post the update' } }, { at: new Date().toISOString(), values: { text: 'Post the update tomorrow' } }));
  assert.deepEqual(sent, [['xoxp-secret', '#general', 'Post the update tomorrow']]);
  assert.deepEqual(out, { ok: true, detail: 'posted (edited) to #general', link: 'https://slack.com/app_redirect?channel=%23general' });
});
