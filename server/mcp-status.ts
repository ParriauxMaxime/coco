// The MCP servers coco is configured with, and a real check that one answers: what the bottom bar's MCP menu shows.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { expandServer } from './config.ts';
import { HttpError, errorMessage } from './core-types.ts';
import type { Config, McpServer } from './config.ts';

export type McpCheck = { at: string; ok: boolean; tools: string[]; error: string | null };
export type McpServerInfo = { name: string; type: McpServer['type']; target: string; onAsk: boolean; onNotion: boolean; check: McpCheck | null };
export type McpProbe = (server: McpServer, timeoutMs: number) => Promise<McpCheck>;

const CHECK_MS = 10_000;
const TTL_MS = 5 * 60_000;
const TIMED_OUT = Symbol('timed out');

export const targetOf = (s: McpServer) => (s.type === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url);

// one handshake and tools/list, then closed again; a server needing an OAuth sign-in answers with its error
export async function probeServer(raw: McpServer, timeoutMs = CHECK_MS): Promise<McpCheck> {
  const server = expandServer(raw);
  const env = Object.fromEntries(Object.entries({ ...process.env, ...(server.type === 'stdio' ? server.env : {}) }).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const client = new Client({ name: 'cocopilot', version: '0' });
  const transport =
    server.type === 'stdio'
      ? new StdioClientTransport({ command: server.command, args: server.args, env, stderr: 'ignore' })
      : server.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
        : new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  const run = (async () => {
    await client.connect(transport);
    return (await client.listTools()).tools.map((t) => t.name);
  })();
  run.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const at = new Date().toISOString();
  try {
    const raced = await Promise.race([run, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); })]);
    return raced === TIMED_OUT ? { at, ok: false, tools: [], error: `no answer within ${Math.round(timeoutMs / 1000)}s` } : { at, ok: true, tools: raced, error: null };
  } catch (e) {
    return { at, ok: false, tools: [], error: errorMessage(e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

export type McpStatus = { list(): { servers: McpServerInfo[] }; check(name: string, opts?: { fresh?: boolean }): Promise<McpServerInfo> };

export function createMcpStatus({ config, probe = probeServer, ttlMs = TTL_MS, now = Date.now }: { config: Pick<Config, 'mcpServers' | 'agentMcp'>; probe?: McpProbe; ttlMs?: number; now?: () => number }): McpStatus {
  const cache = new Map<string, McpCheck>();
  const entries = () => Object.entries(config.mcpServers ?? {});
  const info = (name: string, server: McpServer, check: McpCheck | null): McpServerInfo => ({
    name,
    type: server.type,
    target: targetOf(server),
    onAsk: (config.agentMcp ?? []).includes(name),
    onNotion: name === 'notion',
    check,
  });

  function list(): { servers: McpServerInfo[] } {
    return { servers: entries().map(([name, server]) => info(name, server, cache.get(name) ?? null)) };
  }

  // a check, kept for a few minutes; fresh bypasses it (the menu's Check again)
  async function check(name: string, { fresh = false }: { fresh?: boolean } = {}): Promise<McpServerInfo> {
    const found = entries().find(([n]) => n === name);
    if (!found) throw new HttpError(404, `unknown MCP server ${name}`);
    const kept = cache.get(name);
    if (!fresh && kept && now() - Date.parse(kept.at) < ttlMs) return info(name, found[1], kept);
    const result = await probe(found[1], CHECK_MS);
    cache.set(name, result);
    return info(name, found[1], result);
  }

  return { list, check };
}
