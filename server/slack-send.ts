// propose_slack_message: the Slack connector's only write path. An agent's message becomes a confirm card; pressing Post to Slack
// calls chat.postMessage with the token coco already holds for the Slack MCP server, and nothing is sent before that (docs/agent-io.md).
import { opt, str } from './cards.ts';
import { expandServer } from './config.ts';
import type { Config } from './config.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';

const MAX_TEXT = 4000;
const MAX_CHANNEL = 120;
type SlackInput = { channel: string; text: string; why?: string };
export type SlackPost = (auth: SlackAuth, channel: string, text: string) => Promise<{ channel: string; ts: string }>;

// the credentials the Slack MCP server runs on (config.mcpServers.slack.env), which coco reuses to post:
// an OAuth token, or the browser session pair (xoxc + the d cookie) where no app can be installed in the workspace
export type SlackAuth = { token: string; cookie?: string };
export function slackAuth(config: Pick<Config, 'mcpServers'>): SlackAuth | null {
  const server = config.mcpServers?.slack;
  if (!server || server.type !== 'stdio') return null;
  const env = (expandServer(server) as Extract<typeof server, { type: 'stdio' }>).env ?? {};
  const token = env.SLACK_MCP_XOXP_TOKEN?.trim() || env.SLACK_MCP_XOXB_TOKEN?.trim() || env.SLACK_MCP_XOXC_TOKEN?.trim();
  if (!token) return null;
  const cookie = env.SLACK_MCP_XOXD_TOKEN?.trim();
  if (token.startsWith('xoxc-') && !cookie) return null;
  return { token, ...(token.startsWith('xoxc-') && cookie ? { cookie } : {}) };
}

export const slackPost: SlackPost = async (auth, channel, text) => {
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json; charset=utf-8', ...(auth.cookie ? { cookie: `d=${auth.cookie}` } : {}) },
    body: JSON.stringify({ channel, text }),
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; channel?: string; ts?: string };
  if (!body.ok) throw new Error(`Slack refused: ${body.error || `HTTP ${r.status}`}`);
  return { channel: body.channel || channel, ts: body.ts || '' };
};

export function createSlackSend({ config, post = slackPost }: { config: Pick<Config, 'mcpServers'>; post?: SlackPost }) {
  const inputOf = (raw: Raw): SlackInput => ({ channel: str(raw.channel, MAX_CHANNEL, 'channel').trim(), text: str(raw.text, MAX_TEXT, 'text'), why: opt(raw.why, 500, 'why') });

  const cardAction: ActionDef = {
    card: (raw) => {
      const input = inputOf(raw);
      if (!slackAuth(config)) throw new Error('no Slack credentials: set mcpServers.slack.env.SLACK_MCP_XOXP_TOKEN, or SLACK_MCP_XOXC_TOKEN + SLACK_MCP_XOXD_TOKEN where no app can be installed (docs/configuration.md, "Connectors on any provider")');
      return {
        input,
        card: {
          kind: 'confirm',
          title: `Slack: ${input.channel}`.slice(0, 120),
          question: input.why,
          blocks: [{ type: 'text', text: `Post to **${input.channel}** as you. Nothing is sent until you press Post to Slack.` }, { type: 'code', code: input.text, lang: 'text', caption: 'Message' }],
          fields: [{ key: 'text', label: 'Message', type: 'textarea', default: input.text, required: true }],
          confirmLabel: 'Post to Slack',
          rejectLabel: 'Drop',
        },
      };
    },
    run: async (card) => {
      const auth = slackAuth(config);
      if (!auth) throw new Error('no Slack credentials');
      const input = inputOf(card.action?.input ?? {});
      const text = str(card.answer?.values?.text ?? input.text, MAX_TEXT, 'text');
      const sent = await post(auth, input.channel, text);
      return { ok: true, detail: `posted${text !== input.text ? ' (edited)' : ''} to ${sent.channel}`, link: `https://slack.com/app_redirect?channel=${encodeURIComponent(sent.channel)}` };
    },
  };
  return { cardAction };
}
