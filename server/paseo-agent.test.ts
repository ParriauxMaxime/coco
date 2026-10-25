import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COCO_MCP_TOOLS, createFollower, createPaseoAgents, daemonUrl, workCwd } from './paseo-agent.ts';
import { createAsk } from './ask.ts';
import { createNotionSync } from './notion.ts';
import { DEFAULTS } from './config.ts';

const AGENT = '11111111-2222-3333-4444-555555555555';
const APP = '/opt/coco';
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-agent-test-'));

const tl = (item) => ({ type: 'timeline', provider: 'claude', item });
const say = (text, messageId = 'm1') => tl({ type: 'assistant_message', text, messageId });
const tool = (callId, name, detail, status = 'completed') => tl({ type: 'tool_call', callId, name, detail, status, error: null });
const mcp = (callId, name, input, output) => tool(callId, `mcp__cocopilot__${name}`, { type: 'unknown', input, output });

// An in-memory daemon behind the SDK surface coco uses: workspaces list/ref/open/create, agents created in a workspace, a timeline replayed on run.
function fakeDaemon({ workspaces = [], events = [], results = [{ status: 'idle', lastMessage: null, final: null, error: null }], failRun = null } = {}) {
  const calls = { opened: [], created: [], agents: [], sent: [], archived: [] };
  let handler = null;
  const agent = (workspaceId) => ({
    id: AGENT,
    workspaceId,
    timeline: {
      subscribe: (h) => {
        handler = h;
        const unsubscribe = () => (handler = null);
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
    waitForFinish: async () => results.shift(),
    archive: async () => (calls.archived.push(AGENT), { archivedAt: 'now' }),
  });
  const handle = (w) => ({ id: w.id, directory: w.workspaceDirectory, agents: { create: async (opts) => (calls.agents.push({ workspaceId: w.id, ...opts }), agent(w.id)) } });
  const client = {
    workspaces: {
      list: async () => ({ entries: workspaces }),
      ref: (w) => handle(typeof w === 'string' ? { id: w } : w),
      open: async (cwd) => (calls.opened.push(cwd), handle({ id: 'wks_opened', workspaceDirectory: cwd })),
      create: async (opts) => (calls.created.push(opts), handle({ id: 'wks_worktree' })),
    },
  };
  return { connect: async () => client, calls };
}

test('the follower streams text and thinking deltas, shows a running call once per change, closes a message when a tool call lands, and keeps full tool inputs, results and proposals', () => {
  const deltas = [];
  const entries = [];
  const asked = [];
  const starts = [];
  const f = createFollower({ onDelta: (t, kind) => deltas.push([kind, t]), onEntry: (e) => entries.push(e), onToolStart: (e) => starts.push([e.id, e.kind, e.text]), onPermission: (p) => asked.push(p) });
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
  assert.deepEqual(f.submitted, { propose_work_scaffold: scaffold });
  assert.deepEqual(asked, ['Run gh pr view 7']);
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
    events: [say('Planned.'), mcp('c1', 'propose_rules', { rules: [] }, { recorded: true }), { type: 'turn_completed', provider: 'claude', usage: { totalCostUsd: 0.1 } }],
    results: [{ status: 'permission' }, { status: 'idle', lastMessage: 'Planned.' }],
  });
  const seen = [];
  let started = null;
  const r = await createPaseoAgents({ APP, connect: daemon.connect }).run({ title: 'Ask: plan widgets', prompt: 'Plan the widgets export', systemPrompt: 'You are coco.', provider: 'claude/opus', cwd: REPO, labels: { source: 'cocopilot', kind: 'ask', work: undefined, comments: 2 }, mcp: true, onStart: (s) => (started = s), onEntry: (e) => seen.push(e.type) });

  assert.deepEqual(started, { agentId: AGENT, workspaceId: 'wks_big', createdWorkspace: null });
  assert.equal(r.status, 'done');
  assert.equal(r.finalText, 'Planned.');
  assert.equal(r.cost, 0.1);
  assert.deepEqual(r.submitted, { propose_rules: { rules: [] } });
  assert.deepEqual(seen, ['text', 'tool']);
  const [created] = daemon.calls.agents;
  assert.equal(created.workspaceId, 'wks_big');
  assert.equal(created.title, 'coco · Ask: plan widgets');
  assert.equal(created.prompt, undefined);
  assert.deepEqual(created.labels, { source: 'cocopilot', kind: 'ask', comments: '2' });
  const { toolPolicy, ...config } = created.config;
  assert.deepEqual(config, { provider: 'claude/opus', systemPrompt: 'You are coco.', mcpServers: { cocopilot: { type: 'stdio', command: process.execPath, args: [`${APP}/server/mcp.ts`], alwaysLoad: true } } });
  assert.deepEqual(toolPolicy.preapproved.map((ref) => `${ref.server}.${ref.tool}`), COCO_MCP_TOOLS.map((tool) => `cocopilot.${tool}`));
  assert.deepEqual(daemon.calls.sent, ['Plan the widgets export']);
  assert.deepEqual(daemon.calls.archived, [AGENT]);
  assert.deepEqual(daemon.calls.opened, []);
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
  assert.match(r1.error, /refused/);
  assert.deepEqual(failed.calls.archived, [AGENT]);

  const slow = fakeDaemon({ results: [{ status: 'timeout' }] });
  const r2 = await createPaseoAgents({ APP, connect: slow.connect }).run({ title: 'Plan', prompt: 'p', provider: 'claude/opus', cwd: '/acme/widgets', timeoutMs: 60000 });
  assert.equal(r2.status, 'timeout');
  assert.match(r2.error, /no answer within 1 min/);
  assert.deepEqual(slow.calls.archived, [AGENT]);
});

test('the daemon endpoint comes from PASEO_URL, else from `paseo status`, else the default port', async () => {
  const exec = async (cmd, args) => (cmd === 'paseo' && args.join(' ') === 'status --json' ? { ok: true, stdout: JSON.stringify({ listen: '127.0.0.1:7001' }) } : { ok: false, stdout: '' });
  assert.equal(await daemonUrl(exec), 'ws://127.0.0.1:7001/ws');
  assert.equal(await daemonUrl(async () => ({ ok: false, stdout: '' })), 'ws://127.0.0.1:6767/ws');
  process.env.PASEO_URL = 'ws://10.0.0.2:6767/ws';
  assert.equal(await daemonUrl(exec).finally(() => delete process.env.PASEO_URL), 'ws://10.0.0.2:6767/ws');
});

test("a work's agents run in the row's worktree, else the top-most open row's, else the repo", async () => {
  const worktrees = { 'feat/widgets-api': '/wt/api', 'feat/widgets-ui': '/wt/ui', 'feat/widgets-old': '/wt/old' };
  const exec = async () => ({ ok: true, stdout: Object.entries(worktrees).map(([b, wt]) => `worktree ${wt}\nHEAD x\nbranch refs/heads/${b}\n`).join('\n') });
  const prs = { 1: { state: 'MERGED', head: 'feat/widgets-old' }, 2: { state: 'OPEN', head: 'feat/widgets-api' } };
  const prInfo = async (n) => prs[n];
  const work = { stack: [{ number: 1 }, { number: 2 }, { planned: { branch: 'feat/widgets-ui' } }, { number: null, planned: { branch: 'feat/widgets-next' } }] };
  assert.equal(await workCwd({ repo: '/acme/widgets', work, prInfo, exec }), '/wt/ui');
  assert.equal(await workCwd({ repo: '/acme/widgets', work, key: 2, prInfo, exec }), '/wt/api');
  assert.equal(await workCwd({ repo: '/acme/widgets', work: { stack: [{ number: 1 }] }, prInfo, exec }), '/acme/widgets');
});

const config = { ...DEFAULTS, owner: { name: 'Alice', login: 'alice' }, repo: { ...DEFAULTS.repo, github: 'acme/widgets' } };

test('Ask coco streams deltas to watchers only, records text, tool calls with their results and the scaffold proposal', async () => {
  const DATA = tmpDir();
  const scaffold = { slug: 'widgets-export' };
  const daemon = fakeDaemon({ events: [mcp('c1', 'list_works', {}, [{ slug: 'widgets' }]), say('Here is '), say('the scaffold.'), mcp('c2', 'propose_work_scaffold', scaffold, { recorded: true })], results: [{ status: 'idle', lastMessage: 'Here is the scaffold.' }] });
  const ask = createAsk({ DATA, APP, REPO: '/acme/widgets', config, works: {}, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  const watched = [];
  const done = new Promise((resolve) => {
    const run = ask.start({ prompt: 'Scaffold a work for the widgets CSV export' }, { onEnd: resolve });
    run.listeners.add((ev) => watched.push(ev.type));
  });
  const run = await done;

  assert.equal(run.status, 'idle');
  assert.deepEqual(run.proposal, scaffold);
  assert.equal(run.text, 'Here is the scaffold.');
  assert.deepEqual(run.events.filter((e) => e.type !== 'meta').map((e) => e.type), ['user', 'tool', 'text', 'tool', 'end']);
  assert.equal(run.events.at(-1).status, 'done');
  assert.equal(run.events.find((e) => e.type === 'tool').name, 'mcp__cocopilot__list_works');
  assert.deepEqual(run.events.find((e) => e.type === 'tool'), { type: 'tool', id: 'c1', name: 'mcp__cocopilot__list_works', kind: 'unknown', summary: '{}', input: '{}', output: '[{"slug":"widgets"}]', status: 'completed' });
  assert.ok(!watched.includes('delta') || watched.indexOf('delta') < watched.indexOf('text'));
  const [created] = daemon.calls.agents;
  assert.match(created.config.systemPrompt, /^You are coco/);
  assert.equal(daemon.calls.sent[0], 'Scaffold a work for the widgets CSV export');
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'asks', `${run.id}.json`), 'utf8')).agentId, AGENT);
  assert.ok(!fs.readFileSync(path.join(DATA, 'asks', `${run.id}.jsonl`), 'utf8').includes('"delta"'));
});

test('a Notion sync runs in the work workspace on the fast model and reads the JSON line the agent ends on', async () => {
  const DATA = tmpDir();
  let work = { slug: 'widgets', title: 'Widgets', stack: [], timeline: [], notion: { pageId: '0123456789abcdef0123456789abcdef', url: 'https://www.notion.so/acme/Widgets-0123456789abcdef0123456789abcdef', syncedAt: null } };
  const works = { get: () => structuredClone(work), save: (w) => (work = structuredClone(w)), listArtifacts: () => [], detailPrs: async () => [], prInfo: async () => null };
  const answer = '{"status":"synced","pageId":"0123456789abcdef0123456789abcdef","url":"https://www.notion.so/acme/Widgets","lastEditedTime":null,"message":"ok"}';
  const daemon = fakeDaemon({ workspaces: [{ id: 'wks_widgets', projectId: 'p1', workspaceDirectory: '/acme/widgets' }], events: [say(`Synced.\n${answer}`)], results: [{ status: 'idle', lastMessage: `Synced.\n${answer}` }] });
  const notion = createNotionSync({ DATA, REPO: '/acme/widgets', config, works, agents: createPaseoAgents({ APP, connect: daemon.connect }) });
  assert.equal((await notion.sync('widgets')).ok, true);
  const log = path.join(DATA, 'works', 'widgets', 'notion-runs.jsonl');
  for (let i = 0; i < 200 && !fs.existsSync(log); i++) await new Promise((r) => setTimeout(r, 10));

  assert.ok(work.notion.syncedAt);
  assert.equal(work.notion.url, 'https://www.notion.so/acme/Widgets');
  assert.match(work.timeline[0].text, /^synced Notion page 0123456789abcdef0123456789abcdef$/);
  const [created] = daemon.calls.agents;
  assert.equal(created.workspaceId, 'wks_widgets');
  assert.equal(created.config.provider, config.models.fast);
  assert.equal(created.config.mcpServers, undefined);
  assert.deepEqual(created.labels, { source: 'cocopilot', kind: 'notion-apply', work: 'widgets' });
  assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).agentId, AGENT);
});
