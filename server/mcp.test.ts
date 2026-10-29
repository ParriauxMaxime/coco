import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// the cocopilot MCP server as an agent runs it, over stdio, against a fake coco that records each call
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mcp-'));
const AGENT = '00000000-0000-4000-8000-0000000000a1';
type Call = { method: string; url: string; body: unknown };
const calls: Call[] = [];
let startedAt = 't1';
const routes: Partial<Record<string, (body: unknown) => unknown>> = {
  [`GET /api/agent-chat/${AGENT}/place`]: () => ({ work: 'widgets', pr: '7' }),
  'GET /api/code/pr/7/refs?fresh=1': () => ({ headSha: 'abc1234def', mergeBase: 'base' }),
  'GET /api/works/widgets/findings?pr=7': () => ({ rows: [{ key: 'agent|src/a.ts|null check', commentId: 'aa11' }] }),
  'POST /api/works/widgets/findings': () => ({ done: ['agent|src/a.ts|null check'], pruned: [{ key: 'c.7.aa11', outcome: 'pruned' }] }),
  'GET /api/works/widgets/agents': () => ({ agents: [
    { agentId: AGENT, kind: 'kit', title: 'kit: body', pr: '7', status: 'running', updatedAt: '2026-10-29T10:00:00Z', subagents: { running: 0, total: 0 } },
    { agentId: 'b2', kind: 'kit', title: 'kit: diagram', pr: '7', status: 'idle', updatedAt: '2026-10-29T09:00:00Z', subagents: { running: 1, total: 1 } },
    { agentId: 'c3', kind: 'review', title: 'Persona review', pr: '8', status: 'archived', updatedAt: null },
  ] }),
  'GET /api/jobs?work=widgets': () => ({ jobs: [
    { label: 'kit: diagram', action: 'gate:kit-diagram', state: 'done', pr: '7', agentId: 'b2', startedAt: '1', endedAt: '2', error: '' },
    { label: 'GitHub refresh', action: 'github-refresh', state: 'failed', pr: null, agentId: null, startedAt: '3', endedAt: '4', error: 'gh: rate limited' },
  ] }),
  [`GET /api/agent-chat/${AGENT}/threads?key=c.7.aa11`]: () => ({ threads: [{ key: 'c.7.aa11', suggestions: [{ commit: 'abc', state: 'queued' }] }] }),
  [`GET /api/agent-chat/${AGENT}/threads`]: () => ({ threads: [] }),
  'GET /api/server': () => ({ running: startedAt === 't1' ? 'old' : 'new', head: 'new', behind: 0, startedAt }),
  'POST /api/server/restart': () => {
    setTimeout(() => (startedAt = 't2'), 300);
    return { restarting: true };
  },
  'GET /api/works/widgets/drift': () => ({ drift: [], next: [] }),
  'POST /api/cards': () => ({ id: 'card1' }),
  [`POST /api/agent-chat/${AGENT}/archive-when-done`]: () => ({ ok: true, archived: 'once this turn ends' }),
  'GET /api/works/coco/prs/3/comments': () => ({ comments: [] }),
  'POST /api/works/coco/prs/3/comments': () => ({ id: 'f1' }),
};
const coco = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, url: req.url!, body });
    const route = routes[`${req.method} ${req.url}`];
    res.writeHead(route ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(route ? route(body) : { error: `no route ${req.method} ${req.url}` }));
  });
});
await new Promise<void>((ok) => coco.listen(0, '127.0.0.1', ok));
const PORT = (coco.address() as AddressInfo).port;
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${PORT}` }));

const client = new Client({ name: 'test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('./mcp.ts', import.meta.url).pathname], env: { ...process.env, COCO_CONFIG: path.join(DATA, 'config.json'), COCO_DATA: DATA, PASEO_AGENT_ID: AGENT } as Record<string, string> }));
after(async () => {
  await client.close();
  coco.close();
});

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as Result;
  const out = r.content.find((c) => c.type === 'text')?.text ?? '';
  return { error: Boolean(r.isError), text: out, json: () => JSON.parse(out) };
};
const since = (n: number) => calls.slice(n).map((c) => `${c.method} ${c.url}`);

test('get_artifacts lists the work artifacts with the head they were made for, and reads a text one', async () => {
  const dir = path.join(DATA, 'works', 'widgets', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diagram.md'), '```mermaid\nflowchart LR\n```\n');
  fs.writeFileSync(path.join(dir, 'demo.mp4'), Buffer.alloc(10));
  fs.writeFileSync(path.join(dir, 'pr-8-body.md'), 'other PR');
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ 'diagram.md': { pr: '7', kind: 'diagram', headSha: 'abc1234' }, 'demo.mp4': { pr: '7', kind: 'video', headSha: 'fff0000' }, 'pr-8-body.md': { pr: '8', kind: 'body' } }));
  const listed = (await call('get_artifacts', { pr: 7 })).json();
  assert.deepEqual(listed.map((a: { name: string; current?: boolean }) => [a.name, a.current]).sort(), [['demo.mp4', false], ['diagram.md', true]]);
  assert.equal(listed.find((a: { name: string }) => a.name === 'diagram.md').path, path.join(dir, 'diagram.md'));
  const one = (await call('get_artifacts', { name: 'diagram.md' })).json();
  assert.equal(one.content, '```mermaid\nflowchart LR\n```\n');
  assert.equal((await call('get_artifacts', { name: 'demo.mp4' })).json().content, undefined);
  const outside = await call('get_artifacts', { name: '../widgets.json' });
  assert.ok(outside.error);
  assert.match(outside.text, /no artifact/);
});

test('set_finding_status finds the row by comment id or thread key and posts the board action', async () => {
  assert.match((await call('set_finding_status', { id: 'aa11', status: 'dismissed' })).text, /reason required/);
  assert.match((await call('set_finding_status', { id: 'aa11', status: 'fixed' })).text, /commit required/);
  assert.match((await call('set_finding_status', { id: 'zz99', status: 'reopened' })).text, /no finding zz99 on 7/);
  const n = calls.length;
  const r = await call('set_finding_status', { id: 'c.7.aa11', status: 'fixed', commit: '0347afe', reason: 'applied by hand' });
  assert.deepEqual(r.json(), { key: 'agent|src/a.ts|null check', status: 'fixed', released: [{ key: 'c.7.aa11', outcome: 'pruned' }] });
  assert.deepEqual(calls.at(-1)?.body, { action: 'fixed', keys: ['agent|src/a.ts|null check'], reason: 'applied by hand', commit: '0347afe', pr: '7' });
  assert.deepEqual(since(n), ['GET /api/works/widgets/findings?pr=7', 'POST /api/works/widgets/findings']);
});

test('list_work_agents shows the agents and latest jobs of a PR, newest first, the caller marked', async () => {
  const { agents, jobs } = (await call('list_work_agents', { pr: 7 })).json();
  assert.deepEqual(agents.map((a: { agentId: string; you?: boolean; subagents?: number }) => [a.agentId, a.you, a.subagents]), [[AGENT, true, undefined], ['b2', undefined, 1]]);
  assert.deepEqual(jobs.map((j: { label: string }) => j.label), ['kit: diagram']);
  const all = (await call('list_work_agents')).json();
  assert.equal(all.agents.length, 3);
  assert.deepEqual(all.jobs.map((j: { label: string; error?: string }) => [j.label, j.error]), [['GitHub refresh', 'gh: rate limited'], ['kit: diagram', undefined]]);
});

test('get_thread reads the named thread, or says the agent holds none', async () => {
  assert.deepEqual((await call('get_thread', { thread: ' c.7.aa11 ' })).json(), [{ key: 'c.7.aa11', suggestions: [{ commit: 'abc', state: 'queued' }] }]);
  assert.deepEqual((await call('get_thread')).json(), { threads: [], note: 'this agent holds no thread' });
});

test('ask and flag_coco_issue cut an over-long text to its limit instead of refusing, and say what they cut', async () => {
  const long = 'x'.repeat(130);
  const r = (await call('ask', { kind: 'choice', title: 'Pick', question: 'q'.repeat(600), options: [{ key: 'a', label: long, consequence: 'c'.repeat(250) }, { key: 'b', label: 'B' }] })).json();
  assert.deepEqual(r.cut, ['question', 'options[0].label', 'options[0].consequence']);
  const sent = calls.at(-1)?.body as { question: string; options: { label: string; consequence?: string }[]; agentId: string };
  assert.deepEqual([sent.question.length, sent.options[0].label.length, sent.options[0].consequence?.length, sent.options[1].label, sent.agentId], [500, 120, 200, 'B', AGENT]);
  assert.ok(sent.options[0].label.endsWith('…'));

  fs.writeFileSync(path.join(DATA, 'works', 'coco.json'), JSON.stringify({ slug: 'coco', repo: 'cocopilot', stack: [{ number: 3 }] }));
  const f = (await call('flag_coco_issue', { title: 'Resolve a finding when its commit lands by hand', severity: 'major', summary: 's'.repeat(450), quote: 'fix it' })).json();
  assert.deepEqual([f.created, f.cut], [true, ['summary']]);
  assert.equal((calls.at(-1)?.body as { summary: string }).summary.length, 400);
});

test('propose_pr_body posts a pr_body card for the agent PR; archive_me asks coco to archive it after the turn', async () => {
  const r = (await call('propose_pr_body', { body: '## Summary\nNew', why: 'The count moved.' })).json();
  assert.equal(r.id, 'card1');
  assert.deepEqual(calls.at(-1)?.body, { action: { type: 'pr_body', input: { body: '## Summary\nNew', why: 'The count moved.', pr: '7' } }, agentId: AGENT });
  assert.deepEqual((await call('archive_me')).json(), { ok: true, archived: 'once this turn ends' });
  assert.equal(`${calls.at(-1)?.method} ${calls.at(-1)?.url}`, `POST /api/agent-chat/${AGENT}/archive-when-done`);
});

test('restart_coco restarts coco and waits for the new server', async () => {
  const n = calls.length;
  const r = await call('restart_coco');
  assert.deepEqual(r.json(), { running: 'new', head: 'new', behind: 0, startedAt: 't2' });
  assert.deepEqual(since(n).slice(0, 2), ['GET /api/server', 'POST /api/server/restart']);
});

test('a call made while coco is down lands once it is back', async () => {
  await new Promise<void>((ok) => coco.close(() => ok()));
  coco.closeAllConnections();
  setTimeout(() => coco.listen(PORT, '127.0.0.1'), 1200);
  const r = await call('get_drift');
  assert.equal(r.error, false);
  assert.deepEqual(r.json(), { drift: [], next: [] });
});
