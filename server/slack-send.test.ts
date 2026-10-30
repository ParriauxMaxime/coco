import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlackSend, slackAuth } from './slack-send.ts';
import type { Config } from './config.ts';
import type { Card } from './cards.ts';

const env = (vars: Record<string, string>): Pick<Config, 'mcpServers'> => ({ mcpServers: { slack: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server@1.3.0'], env: vars } } });
const config = env({ SLACK_MCP_XOXP_TOKEN: 'xoxp-secret' });
const cardOf = (action: unknown, answer?: unknown) => ({ action, answer }) as unknown as Card;

test('the Slack credentials are the ones the MCP server runs on: an OAuth token, or the browser session pair', () => {
  assert.deepEqual(slackAuth(config), { token: 'xoxp-secret' });
  assert.deepEqual(slackAuth(env({ SLACK_MCP_XOXC_TOKEN: 'xoxc-web', SLACK_MCP_XOXD_TOKEN: 'xoxd-cookie' })), { token: 'xoxc-web', cookie: 'xoxd-cookie' });
  assert.equal(slackAuth(env({ SLACK_MCP_XOXC_TOKEN: 'xoxc-web' })), null);
  assert.equal(slackAuth({ mcpServers: {} }), null);
  assert.equal(slackAuth({ mcpServers: { slack: { type: 'http', url: 'https://mcp.slack.com/mcp' } } }), null);
});

test('a message becomes a confirm card showing the channel and the text, and is refused without credentials', async () => {
  const { cardAction } = createSlackSend({ config, post: async () => ({ channel: 'C1', ts: 't' }) });
  const out = await cardAction.card({ channel: '#general', text: 'Post the update', why: 'announce the release' }, {} as never);
  assert.equal(out.card.kind, 'confirm');
  assert.equal(out.card.title, 'Slack: #general');
  assert.equal(out.card.question, 'announce the release');
  assert.deepEqual(out.card.fields, [{ key: 'text', label: 'Message', type: 'textarea', default: 'Post the update', required: true }]);
  assert.equal(out.card.confirmLabel, 'Post to Slack');
  assert.throws(() => createSlackSend({ config: { mcpServers: {} } }).cardAction.card({ channel: '#general', text: 'x' }, {} as never), /no Slack credentials/);
});

test('only an approved card posts, with the text as edited on it', async () => {
  const sent: [string, string, string][] = [];
  const { cardAction } = createSlackSend({ config, post: async (auth, channel, text) => (sent.push([auth.token, channel, text]), { channel, ts: '1750000000.1' }) });
  const out = await cardAction.run(cardOf({ input: { channel: '#general', text: 'Post the update' } }, { at: new Date().toISOString(), values: { text: 'Post the update tomorrow' } }));
  assert.deepEqual(sent, [['xoxp-secret', '#general', 'Post the update tomorrow']]);
  assert.deepEqual(out, { ok: true, detail: 'posted (edited) to #general', link: 'https://slack.com/app_redirect?channel=%23general' });
});
