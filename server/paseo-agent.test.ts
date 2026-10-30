import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CARDS_LINE, COCO_MCP_TOOLS, createFollower,createPaseoAgents, daemonUrl, workCwd } from './paseo-agent.ts';
import type { ConnectionState, DaemonAgent, DaemonConnection, Entry, Started, TimelineEvent, ToolDetail, ToolStart, WaitResult, WorkspaceEntry, WorkspaceHandle } from './paseo-agent.ts';
import { createAsk } from './ask.ts';
import { createNotionSync } from './notion.ts';
import { DEFAULTS } from './config.ts';

const AGENT = '11111111-2222-3333-4444-555555555555';
const APP = '/opt/coco';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-agent-test-'));

type Handler = Parameters<DaemonAgent['timeline']['subscribe']>[0];
type TimelineItem = NonNullable<TimelineEvent['item']>;
type NotionWork = NonNullable<ReturnType<Parameters<typeof createNotionSync>[0]['works']['get']>>;
type AgentConfig = { toolPolicy?: { preapproved: { server: string; tool: string }[] }; systemPrompt?: string; provider?: string; mcpServers?: unknown; [key: string]: unknown };
type Created = { workspaceId: string; title?: string; prompt?: string; labels?: Record<string, string>; config: AgentConfig };

const tl = (item: TimelineItem): TimelineEvent => ({ type: 'timeline', provider: 'claude', item });
const say = (text: string, messageId = 'm1') => tl({ type: 'assistant_message', text, messageId });
const tool = (callId: string, name: string, detail: ToolDetail, status = 'completed') => tl({ type: 'tool_call', callId, name, detail, status, error: null });
const mcp = (callId: string, name: string, input: unknown, output: unknown) => tool(callId, `mcp__cocopilot__${name}`, { type: 'unknown', input, output });

// An in-memory daemon behind the SDK surface coco uses: workspaces list/ref/open/create, agents created in a workspace, a timeline replayed on run.
function fakeDaemon({ workspaces = [], events = [], results = [{ status: 'idle', lastMessage: null, final: null, error: null }], failRun = null }: { workspaces?: WorkspaceEntry[]; events?: TimelineEvent[]; results?: WaitResult[]; failRun?: string | null } = {}) {
  const calls: { opened: string[]; created: Record<string, unknown>[]; agents: Created[]; sent: string[]; archived: string[] } = { opened: [], created: [], agents: [], sent: [], archived: [] };
  let handler: Handler | null = null;
  const agent = (workspaceId: string): DaemonAgent => ({
    id: AGENT,
    workspaceId,
    timeline: {
      subscribe: (h) => {
        handler = h;
        const unsubscribe = () => void (handler = null);
        unsubscribe.ready = Promise.resolve();
        return unsubscribe;
      },
    },
    send: async (text) => {
      calls.sent.push(text);
      if (failRun) throw new Error(failRun);
      for (const event of events) handler?.({ agentId: AGENT, event });
      if (results[0]?.status === 'permission') setTimeout(() => handler?.({ agentId: AGENT, event: { type: 'permission_resolved', provider: 'claude', requestId: 'p1', resolution: { behavior: 'allow' } } }), 5);
    },
    waitForFinish: async () => {
      const next = results.shift();
      if (!next) throw new Error('no result left');
      return next;
    },
    refresh: async () => null,
    archive: async () => (calls.archived.push(AGENT), { archivedAt: 'now' }),
  });
  const handle = (w: WorkspaceEntry): WorkspaceHandle => ({ id: w.id, agents: { create: async (opts) => (calls.agents.push({ workspaceId: w.id, ...(opts as Omit<Created, 'workspaceId'>) }), agent(w.id)) } });
  const client = {
    workspaces: {
      list: async () => ({ entries: workspaces }),
      ref: (w: string | WorkspaceEntry) => handle(typeof w === 'string' ? { id: w } : w),
      open: async (cwd: string) => (calls.opened.push(cwd), handle({ id: 'wks_opened', workspaceDirectory: cwd })),
      create: async (opts: Record<string, unknown>) => (calls.created.push(opts), handle({ id: 'wks_worktree' })),
    },
    agents: {
      ref: (): DaemonAgent => {
        throw new Error('not expected');
      },
    },
  };
  return { connect: async () => client, calls };
}

test('the follower streams text and thinking deltas, shows a running call once per change, closes a message when a tool call lands, and keeps full tool inputs and results, proposals now being cards', () => {
  const deltas: (string | undefined)[][] = [];
  const entries: Entry[] = [];
  const asked: unknown[] = [];
  const starts: (string | undefined)[][] = [];
  const f = createFollower({ onDelta: (t, kind) => deltas.push([kind, t]), onEntry: (e) => entries.push(e), onToolStart: (e) => starts.push([e.id, e.kind, e.text]), onPermission: (p) => asked.push(p), agentId: AGENT });
  const scaffold = { slug: 'widgets-export', notes: 'x'.repeat(2000) };
  for (const event of [
    tl({ type: 'user_message', text: 'the brief' }),
    tl({ type: 'reasoning', text: 'weighing ' }),
    tl({ type: 'reasoning', text: 'the widgets' }),
    say('The widgets '),
    say('work has two PRs.'),
    mcp('c1', 'list_works', {}, null),
    tool('c2', 'Bash', { type: 'unknown', input: {}, output: null }, 'running'),
    tool('c2', 'Bash', { type: 'shell', command: 'git log -1' }, 'running'),
    tool('c2', 'Bash', { type: 'shell', command: 'git log -1' }, 'running'),
    tool('c2', 'Bash', { type: 'shell', command: 'git log -1', output: 'abc widgets' }),
    tool('c2', 'Bash', { type: 'shell', command: 'git log -1', output: 'abc widgets' }),
    { type: 'permission_requested', provider: 'claude', request: { id: 'p1', name: 'Bash', kind: 'tool', title: 'Run gh pr view 7' } },
    { type: 'permission_resolved', provider: 'claude', requestId: 'p1', resolution: { behavior: 'allow' } },
    mcp('c3', 'propose_work_scaffold', scaffold, { recorded: true }),
    say('Done.', 'm2'),
    { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: 0.42 } },
  ])
    f.push({ agentId: AGENT, event });

  assert.deepEqual(deltas, [['think', 'weighing '], ['think', 'the widgets'], ['text', 'The widgets '], ['text', 'work has two PRs.'], ['text', 'Done.']]);
  assert.deepEqual(starts, [['c2', 'unknown', '{}'], ['c2', 'shell', 'git log -1']]);
  assert.equal(entries[3].id, 'c2');
  assert.deepEqual(
    entries.map((e) => [e.type, e.name || '', e.text]),
    [['think', '', 'weighing the widgets'], ['text', '', 'The widgets work has two PRs.'], ['tool', 'mcp__cocopilot__list_works', '{}'], ['tool', 'Bash', 'git log -1'], ['tool', 'mcp__cocopilot__propose_work_scaffold', JSON.stringify(scaffold)], ['text', '', 'Done.']],
  );
  assert.equal(entries[3].output, 'abc widgets');
  assert.deepEqual(entries[4].input, scaffold);
  assert.deepEqual(f.submitted, {});
  assert.deepEqual(asked, [
    { type: 'permission', agentId: AGENT, request: { id: 'p1', name: 'Bash', kind: 'tool', title: 'Run gh pr view 7' } },
    { type: 'permission_resolved', agentId: AGENT, requestId: 'p1', resolution: { behavior: 'allow' } },
  ]);
  assert.equal(f.cost(), 0.42);
});

test('run starts the agent in the workspace already open on its directory, waits through a permission, returns the stream, then archives it', async () => {
  const REPO = '/acme/widgets';
  const daemon = fakeDaemon({
    workspaces: [
      { id: 'wks_small', projectId: 'p1', workspaceDirectory: REPO },
      { id: 'wks_big', projectId: 'p2', workspaceDirectory: REPO },
      { id: 'wks_sibling', projectId: 'p2', workspaceDirectory: '/acme/widgets-pr1' },
      { id: 'wks_other', projectId: 'p3', workspaceDirectory: '/elsewhere' },
    ],
    events: [say('Planned.'), mcp('c1', 'propose_review_plan', { steps: [] }, { recorded: true }), { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: 0.1 } }],
    results: [{ status: 'permission' }, { status: 'idle', lastMessage: 'Planned.' }],
  });
  const seen: string[] = [];
  let started: Started | null = null;
  const r = await createPaseoAgents({ APP, connect: daemon.connect }).run({ title: 'Ask: plan widgets', prompt: 'Plan the widgets export', systemPrompt: 'You are coco.', provider: 'claude/opus', cwd: REPO, labels: { source: 'cocopilot', kind: 'ask', work: undefined, comments: 2 }, mcp: true, onStart: (s) => (started = s), onEntry: (e) => seen.push(e.type) });

  assert.deepEqual(started, { agentId: AGENT, workspaceId: 'wks_big', createdWorkspace: null });
  assert.equal(r.status, 'done');
  assert.equal(r.finalText, 'Planned.');
  assert.equal(r.cost, 0.1);
  assert.deepEqual(r.submitted, { propose_review_plan: { steps: [] } });
  assert.deepEqual(seen, ['text', 'tool']);
  const [created] = daemon.calls.agents;
  assert.equal(created.workspaceId, 'wks_big');
  assert.equal(created.title, 'coco · Ask: plan widgets');
  assert.equal(created.prompt, undefined);
  assert.deepEqual(created.labels, { source: 'cocopilot', kind: 'ask', comments: '2' });
  const { toolPolicy, ...config } = created.config;
  assert.deepEqual(config, { provider: 'claude/opus', modeId: 'auto', systemPrompt: `You are coco.\n${CARDS_LINE}`, mcpServers: { cocopilot: { type: 'stdio', command: process.execPath, args: [`${APP}/server/mcp.ts`], alwaysLoad: true } }, options: { disallowedTools: ['AskUserQuestion'] } });
  assert.deepEqual(toolPolicy?.preapproved.map((ref) => `${ref.server}.${ref.tool}`), COCO_MCP_TOOLS.map((tool) => `cocopilot.${tool}`));
  assert.deepEqual(daemon.calls.sent, ['Plan the widgets export']);
  assert.deepEqual(daemon.calls.archived, [AGENT]);
  assert.deepEqual(daemon.calls.opened, []);
});

test('an agent on another provider than Claude starts in its own default mode, without the coco tools when asked', async () => {
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_plan', projectId: 'p1', workspaceDirectory: '/acme/widgets' }], events: [say('[]'), { type: 'turn_completed', provider: 'opencode' }], results: [{ status: 'idle', lastMessage: '[]' }] });
  await createPaseoAgents({ APP: '/app', connect: daemon.connect }).run({ title: 'Brief lessons', prompt: 'judge', provider: 'opencode/ollama/qwen3:14b', cwd: '/acme/widgets', mcp: false });
  assert.deepEqual(daemon.calls.agents[0].config, { provider: 'opencode/ollama/qwen3:14b' });
});

test('the shared agent line says code is edited only with Edit or Write after a Read', () => {
  assert.match(CARDS_LINE, /Edit code files only with the Edit or Write tools after a Read, never with sed, python or heredocs/);
});

test('the shared agent line has agents check a UI change with the screenshot tool, not the user', () => {
  assert.match(CARDS_LINE, /call cocopilot screenshot on the page and look at it before you report: never ask the user to reload/);
  assert.ok(COCO_MCP_TOOLS.includes('screenshot'));
});

test('the shared agent line sends "what would a reviewer do" to consult_persona, not a persona review', () => {
  assert.match(CARDS_LINE, /call cocopilot consult_persona and answer with that reviewer's call plus an ask card: do not start a persona review unless asked/);
  assert.ok(COCO_MCP_TOOLS.includes('consult_persona'));
});

test('every tool of the cocopilot MCP server is preapproved', () => {
  const declared = [...fs.readFileSync(new URL('./mcp.ts', import.meta.url), 'utf8').matchAll(/server\.tool\('(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...COCO_MCP_TOOLS].sort(), declared.sort());
});

test('a directory with no workspace gets one opened and reported; a new worktree comes from the repo with its checkout source', async () => {
  const daemon = fakeDaemon();
  const agents = createPaseoAgents({ APP, connect: daemon.connect });
  const a = await agents.start({ title: 'Set up', prompt: 'go', provider: 'claude/opus', cwd: '/acme/gadgets' });
  assert.deepEqual([a.workspaceId, a.createdWorkspace], ['wks_opened', 'wks_opened']);
  assert.deepEqual(daemon.calls.opened, ['/acme/gadgets']);
  assert.equal(daemon.calls.agents[0].prompt, 'go');

  const b = await agents.start({ title: 'Fix review #7', prompt: 'go', provider: 'claude/opus', cwd: '/acme/widgets', worktree: { mode: 'checkout-pr', prNumber: 7 } });
  assert.equal(b.createdWorkspace, 'wks_worktree');
  assert.deepEqual(daemon.calls.created, [{ source: { kind: 'worktree', cwd: '/acme/widgets', action: 'checkout', checkoutSource: { kind: 'change_request', number: 7 } } }]);
});

test('a failed or timed-out run is still archived and says why', async () => {
  const failed = fakeDaemon({ failRun: 'provider claude-perso refused for /acme/widgets' });
  const r1 = await createPaseoAgents({ APP, connect: failed.connect }).run({ title: 'Notion sync', prompt: 'p', provider: 'claude/sonnet', cwd: '/acme/widgets' });
  assert.equal(r1.status, 'error');
  assert.match(String(r1.error), /refused/);
  assert.deepEqual(failed.calls.archived, [AGENT]);

  const slow = fakeDaemon({ results: [{ status: 'timeout' }] });
  const r2 = await createPaseoAgents({ APP, connect: slow.connect }).run({ title: 'Plan', prompt: 'p', provider: 'claude/opus', cwd: '/acme/widgets', timeoutMs: 60000 });
  assert.equal(r2.status, 'timeout');
  assert.match(String(r2.error), /no answer within 1 min/);
  assert.deepEqual(slow.calls.archived, [AGENT]);
});

test('a daemon restart in mid-turn: the wait goes on once coco is reconnected, and the tool calls settled meanwhile are read back from the timeline', async () => {
  let handler: Handler | null = null;
  let up: ((s: ConnectionState) => void) | null = null;
  let state: ConnectionState = { status: 'connected' };
  const plan = { steps: [{ title: 'Read the API first' }] };
  const waits: string[] = [];
  const agent = {
    id: AGENT,
    workspaceId: 'wks_1',
    timeline: {
      subscribe: (h: Handler) => {
        handler = h;
        return Object.assign(() => void (handler = null), { ready: Promise.resolve() });
      },
      refetch: async () => ({ entries: [{ item: { type: 'user_message', text: 'old brief' } }, { item: tool('old', 'mcp__cocopilot__propose_review_plan', { type: 'unknown', input: { steps: [] } }).item }, { item: { type: 'user_message', text: 'p' } }, { item: mcp('c9', 'propose_review_plan', plan, null).item }] }),
    },
    send: async () => {},
    waitForFinish: async () => {
      waits.push(state.status);
      if (waits.length > 1) return { status: 'idle', lastMessage: 'Planned.' };
      state = { status: 'disconnected', reason: 'socket closed' };
      setTimeout(() => {
        state = { status: 'connected' };
        handler?.({ agentId: AGENT, event: { type: 'subscription_restored' } });
        up?.(state);
      }, 5);
      throw Object.assign(new Error('Connection lost'), { code: 'DAEMON_CONNECTION_LOST' });
    },
    refresh: async () => null,
    archive: async () => ({}),
  } as unknown as DaemonAgent;
  const connection: DaemonConnection = { state: () => state, onChange: (l) => ((up = l), () => (up = null)), lastError: () => null, version: () => null, reconnect: () => {} };
  const client = { connection, workspaces: { ref: () => ({ id: 'wks_1', agents: { create: async () => agent } }) }, agents: { ref: () => agent } };
  const r = await createPaseoAgents({ APP, connect: async () => client as never }).run({ title: 'Plan', prompt: 'p', workspaceId: 'wks_1' });
  assert.deepEqual(waits, ['connected', 'connected']);
  assert.deepEqual([r.status, r.finalText], ['done', 'Planned.']);
  assert.deepEqual(r.submitted, { propose_review_plan: plan });
  assert.deepEqual(r.entries.map((e) => e.id), ['c9']);
});

test('the daemon endpoint comes from PASEO_URL, else from `paseo status`, else the default port', async () => {
  const exec = async (cmd: string, args: string[]) => (cmd === 'paseo' && args.join(' ') === 'status --json' ? { ok: true, stdout: JSON.stringify({ listen: '127.0.0.1:7001' }), stderr: '' } : { ok: false, stdout: '', stderr: '' });
  assert.equal(await daemonUrl(exec), 'ws://127.0.0.1:7001/ws');
  assert.equal(await daemonUrl(async () => ({ ok: false, stdout: '', stderr: '' })), 'ws://127.0.0.1:6767/ws');
  process.env.PASEO_URL = 'ws://10.0.0.2:6767/ws';
  assert.equal(await daemonUrl(exec).finally(() => delete process.env.PASEO_URL), 'ws://10.0.0.2:6767/ws');
});

test("a work's agents run in the row's worktree, else the top-most open row's, else the repo", async () => {
  const worktrees = { 'feat/widgets-api': '/wt/api', 'feat/widgets-ui': '/wt/ui', 'feat/widgets-old': '/wt/old' };
  const exec = async () => ({ ok: true, stdout: Object.entries(worktrees).map(([b, wt]) => `worktree ${wt}\nHEAD x\nbranch refs/heads/${b}\n`).join('\n'), stderr: '' });
  const prs: Record<number, { state: string; head: string }> = { 1: { state: 'MERGED', head: 'feat/widgets-old' }, 2: { state: 'OPEN', head: 'feat/widgets-api' } };
  const prInfo = async (n: number) => prs[n];
  const work = { stack: [{ number: 1 }, { number: 2 }, { planned: { branch: 'feat/widgets-ui' } }, { number: null, planned: { branch: 'feat/widgets-next' } }] };
  assert.equal(await workCwd({ repo: '/acme/widgets', work, prInfo, exec }), '/wt/ui');
  assert.equal(await workCwd({ repo: '/acme/widgets', work, key: 2, prInfo, exec }), '/wt/api');
  assert.equal(await workCwd({ repo: '/acme/widgets', work: { stack: [{ number: 1 }] }, prInfo, exec }), '/acme/widgets');
});

test('a configured connector server mounts only when an agent asks for it, with its credentials expanded', async () => {
  const REPO = '/acme/widgets';
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_widgets', projectId: 'p1', workspaceDirectory: REPO }] });
  process.env.NOTION_TOKEN = 'secret-token';
  const servers = { notion: { type: 'http' as const, url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer ${NOTION_TOKEN}' } }, slack: { type: 'stdio' as const, command: 'npx', args: ['-y', 'slack-mcp-server'] } };
  const agents = createPaseoAgents({ APP, connect: daemon.connect });
  await agents.start({ title: 'Notion sync', provider: 'omp/deepseek', cwd: REPO, mcp: ['notion'], servers });
  await agents.start({ title: 'Ask', provider: 'omp/deepseek', cwd: REPO });
  delete process.env.NOTION_TOKEN;
  const [withNotion, plain] = daemon.calls.agents;
  assert.deepEqual(Object.keys(withNotion.config.mcpServers ?? {}), ['cocopilot', 'notion']);
  assert.deepEqual((withNotion.config.mcpServers as Record<string, unknown>).notion, { type: 'http', alwaysLoad: true, url: 'https://mcp.notion.com/mcp', headers: { Authorization: 'Bearer secret-token' } });
  assert.deepEqual(Object.keys(plain.config.mcpServers ?? {}), ['cocopilot']);
});

const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };

test('Ask coco streams deltas to watchers only, records text and tool calls with their results', async () => {
  const DATA = tmpDir();
  const scaffold = { slug: 'widgets-export' };
  const daemon = fakeDaemon({ events: [mcp('c1', 'list_works', {}, [{ slug: 'widgets' }]), say('Here is '), say('the scaffold.'), mcp('c2', 'propose_work_scaffold', scaffold, { recorded: true })], results: [{ status: 'idle', lastMessage: 'Here is the scaffold.' }] });
  const ask = createAsk({ DATA, APP, REPO: '/acme/widgets', config, works: { get: () => undefined, save: () => {}, prInfo: async () => null }, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  const watched: string[] = [];
  const done = new Promise<ReturnType<typeof ask.start>>((resolve) => {
    const run = ask.start({ prompt: 'Scaffold a work for the widgets CSV export' }, { onEnd: resolve });
    run.listeners.add((ev) => watched.push(ev.type));
  });
  const run = await done;

  assert.equal(run.status, 'idle');
  assert.equal(run.text, 'Here is the scaffold.');
  assert.deepEqual(run.events.filter((e) => e.type !== 'meta' && e.type !== 'step').map((e) => e.type), ['user', 'tool', 'text', 'tool', 'end']);
  assert.equal(run.events.at(-1)?.status, 'done');
  assert.equal(run.events.find((e) => e.type === 'tool')?.name, 'mcp__cocopilot__list_works');
  assert.deepEqual(run.events.find((e) => e.type === 'tool'), { type: 'tool', id: 'c1', name: 'mcp__cocopilot__list_works', kind: 'unknown', summary: '{}', input: '{}', output: '[{"slug":"widgets"}]', status: 'completed' });
  assert.ok(!watched.includes('delta') || watched.indexOf('delta') < watched.indexOf('text'));
  const [created] = daemon.calls.agents;
  assert.match(String(created?.config.systemPrompt), /^You are coco/);
  assert.equal(daemon.calls.sent[0], 'Scaffold a work for the widgets CSV export');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'asks', `${run.id}.json`), 'utf8')).agentId, AGENT);
  assert.ok(!fs.readFileSync(path.join(DATA, 'asks', `${run.id}.jsonl`), 'utf8').includes('"delta"'));
});

test('a Notion sync runs in the work workspace on the fast model and reads the JSON line the agent ends on', async () => {
  const DATA = tmpDir();
  let work: NotionWork = { slug: 'widgets', title: 'Widgets', stack: [], timeline: [], notion: { pageId: '0123456789abcdef0123456789abcdef', url: 'https://www.notion.so/acme/Widgets-0123456789abcdef0123456789abcdef', syncedAt: undefined } };
  const works = { get: () => structuredClone(work), save: (w: NotionWork) => (work = structuredClone(w)), listArtifacts: () => [], detailPrs: async () => [], prInfo: async () => ({ number: null }) };
  const answer = '{"status":"synced","pageId":"0123456789abcdef0123456789abcdef","url":"https://www.notion.so/acme/Widgets","lastEditedTime":null,"message":"ok"}';
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_widgets', projectId: 'p1', workspaceDirectory: '/acme/widgets' }], events: [say(`Synced.\n${answer}`)], results: [{ status: 'idle', lastMessage: `Synced.\n${answer}` }] });
  const notion = createNotionSync({ DATA, REPO: '/acme/widgets', config, works, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  const started = await notion.sync('widgets');
  assert.ok('ok' in started && started.ok === true);
  const log = path.join(DATA, 'works', 'widgets', 'notion-runs.jsonl');
  for (let i = 0; i < 200 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 10));

  assert.ok(work.notion?.syncedAt);
  assert.equal(work.notion?.url, 'https://www.notion.so/acme/Widgets');
  assert.match(String(work.timeline?.[0]?.text), /^synced Notion page 0123456789abcdef0123456789abcdef$/);
  const [created] = daemon.calls.agents;
  assert.equal(created.workspaceId, 'wks_widgets');
  assert.equal(created.config.provider, config.models.fast);
  assert.deepEqual(Object.keys(created.config.mcpServers ?? {}), ['cocopilot']);
  assert.match(String(created.config.systemPrompt), /cocopilot ask tool/);
  assert.deepEqual(created.labels, { source: 'cocopilot', kind: 'notion-apply', work: 'widgets' });
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).agentId, AGENT);
});

test('a Notion MCP server of our own mounts on models.connectors, the provider Paseo can preapprove it for', async () => {
  const DATA = tmpDir();
  let work: NotionWork = { slug: 'widgets', title: 'Widgets', stack: [], timeline: [], notion: { pageId: '0123456789abcdef0123456789abcdef', url: 'https://www.notion.so/acme/Widgets-0123456789abcdef0123456789abcdef', syncedAt: undefined } };
  const works = { get: () => structuredClone(work), save: (w: NotionWork) => (work = structuredClone(w)), listArtifacts: () => [], detailPrs: async () => [], prInfo: async () => ({ number: null }) };
  const answer = '{"status":"synced","pageId":"0123456789abcdef0123456789abcdef","url":"https://www.notion.so/acme/Widgets","lastEditedTime":null,"message":"ok"}';
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_widgets', projectId: 'p1', workspaceDirectory: '/acme/widgets' }], events: [say(`Synced.\n${answer}`)], results: [{ status: 'idle', lastMessage: `Synced.\n${answer}` }] });
  const own = { ...config, models: { ...config.models, default: 'omp/deepseek', fast: 'omp/deepseek', connectors: 'opencode/opencode/deepseek-v4.1-flash-free' }, mcpServers: { notion: { type: 'http' as const, url: 'https://mcp.notion.com/mcp' } } };
  const notion = createNotionSync({ DATA, REPO: '/acme/widgets', config: own, works, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  assert.ok('ok' in (await notion.sync('widgets')));
  const log = path.join(DATA, 'works', 'widgets', 'notion-runs.jsonl');
  for (let i = 0; i < 200 && !fs.existsSync(log); i++) await new Promise((r) => setImmediate(r));
  const [created] = daemon.calls.agents;
  assert.equal(created.config.provider, 'opencode/opencode/deepseek-v4.1-flash-free');
  assert.deepEqual(Object.keys(created.config.mcpServers ?? {}), ['cocopilot', 'notion']);
});

test('Ask mounts the interactive servers the config names', async () => {
  const DATA = tmpDir();
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_widgets', projectId: 'p1', workspaceDirectory: '/acme/widgets' }] });
  const withTools = { ...config, agentMcp: ['slack'], mcpServers: { slack: { type: 'stdio' as const, command: 'npx', args: ['-y', 'slack-mcp-server'] } } };
  const ask = createAsk({ DATA, APP, REPO: '/acme/widgets', config: withTools, works: { get: () => undefined, save: () => {}, prInfo: async () => null }, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  ask.start({ prompt: 'What did Slack say about the export?' });
  for (let i = 0; i < 200 && !daemon.calls.agents.length; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(Object.keys(daemon.calls.agents[0].config.mcpServers ?? {}), ['cocopilot', 'slack']);
});
