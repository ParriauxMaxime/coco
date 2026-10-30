import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpStatus } from './mcp-status.ts';
import type { McpCheck } from './mcp-status.ts';
import type { Config } from './config.ts';

const config: Pick<Config, 'mcpServers' | 'agentMcp'> = {
  mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' }, slack: { type: 'stdio', command: 'npx', args: ['-y', 'slack-mcp-server'] } },
  agentMcp: ['slack'],
};

const result = (ok: boolean): McpCheck => ({ at: '2026-10-30T09:00:00.000Z', ok, tools: ok ? ['send_message', 'search'] : [], error: ok ? null : 'OAuth sign-in required' });

test('the MCP menu lists the configured servers, what they run, and where coco mounts them', () => {
  const status = createMcpStatus({ config, probe: async () => result(true) });
  assert.deepEqual(status.list(), {
    servers: [
      { name: 'notion', type: 'http', target: 'https://mcp.notion.com/mcp', onAsk: false, onNotion: true, check: null },
      { name: 'slack', type: 'stdio', target: 'npx -y slack-mcp-server', onAsk: true, onNotion: false, check: null },
    ],
  });
});

test('a check runs the server once and is kept; fresh checks it again', async () => {
  const probed: string[] = [];
  let at = Date.parse('2026-10-30T09:00:00.000Z');
  const status = createMcpStatus({ config, ttlMs: 60_000, now: () => at, probe: async (server) => (probed.push(server.type), result(true)) });
  const first = await status.check('notion');
  assert.deepEqual(first.check?.tools, ['send_message', 'search']);
  at += 30_000;
  await status.check('notion');
  assert.equal(probed.length, 1);
  await status.check('notion', { fresh: true });
  assert.equal(probed.length, 2);
});

test('a server that fails to answer shows its reason, and an unknown name is refused', async () => {
  const status = createMcpStatus({ config, probe: async () => result(false) });
  assert.equal((await status.check('slack')).check?.error, 'OAuth sign-in required');
  await assert.rejects(status.check('gmail'), (e: Error & { status?: number }) => e.status === 404 && /unknown MCP server gmail/.test(e.message));
});
