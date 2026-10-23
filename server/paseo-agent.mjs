// Every agent coco starts runs through the Paseo daemon (its SDK): in the workspace already open on its directory, titled `coco · …`, followed live, archived once done (a conversation's once closed).
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createPaseoClient } from '@getpaseo/client';
import { rowKey } from './stack.mjs';

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
export const TITLE_PREFIX = 'coco · ';
const TITLE_MAX = 60;
const DEFAULT_LISTEN = '127.0.0.1:6767';
const TIMEOUT_MS = 15 * 60 * 1000;
const HOME = os.homedir();
const COCO_TOOL = /^mcp__cocopilot__(propose_\w+)$/;
// the server.tool names of server/mcp.mjs, preapproved like any plugin preapproves its own tools
export const COCO_MCP_TOOLS = ['list_works', 'get_work', 'list_personas', 'read_persona', 'suggest_personas', 'read_skill', 'list_paseo', 'github_pr', 'github_search', 'propose_work_scaffold', 'propose_paseo_agent', 'propose_rules', 'propose_review_plan'];

// The server may run inside a Paseo agent's shell: its PASEO_AGENT_ID would make every CLI launch that agent's subagent and pin it to that agent's workspace.
const AMBIENT_PASEO = ['PASEO_AGENT_ID', 'PASEO_AGENT_CWD', 'PASEO_WORKSPACE_ID'];
export const launcherEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !AMBIENT_PASEO.includes(k)));
export const expandHome = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME);
export const sameDir = (a, b) => path.resolve(expandHome(a)) === path.resolve(expandHome(b));
export const cocoTitle = (title) => `${TITLE_PREFIX}${String(title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX)}`;

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const defaultExec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

// PASEO_URL wins; otherwise the endpoint `paseo status` reports for the local daemon
export async function daemonUrl(exec = defaultExec) {
  if (process.env.PASEO_URL) return process.env.PASEO_URL;
  const r = await exec('paseo', ['status', '--json'], { env: launcherEnv(), timeout: 15000 });
  const listen = r.ok ? parseJson(r.stdout, null)?.listen : null;
  return `ws://${/^[\w.[\]-]+:\d+$/.test(listen || '') ? listen : DEFAULT_LISTEN}/ws`;
}

export async function connectDaemon({ exec = defaultExec } = {}) {
  const url = await daemonUrl(exec);
  const client = createPaseoClient({ url, clientId: 'cocopilot', password: process.env.PASEO_PASSWORD || undefined, reconnect: { enabled: true } });
  try {
    await client.connect();
  } catch (e) {
    await client.close().catch(() => {});
    throw new Error(`cannot reach the Paseo daemon at ${url}: ${e.message}`);
  }
  return client;
}

export async function worktreeFor(repo, branch, exec = defaultExec) {
  const r = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
  if (!r.ok) return null;
  for (const block of r.stdout.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '));
    const br = lines.find((l) => l.startsWith('branch '));
    if (wt && br && br.slice('branch '.length).trim() === `refs/heads/${branch}`) return wt.slice('worktree '.length).trim();
  }
  return null;
}

// where a work's agents run: the worktree of the given row, else the top-most open row that has one, else the repo
export async function workCwd({ repo, work, key = null, prInfo, exec = defaultExec }) {
  const rows = work?.stack || [];
  const ordered = [...rows.filter((s) => key && rowKey(s) === key), ...[...rows].reverse().filter((s) => !key || rowKey(s) !== key)];
  for (const s of ordered) {
    const pr = s.number ? await prInfo(s.number) : null;
    if (pr && (pr.state === 'MERGED' || pr.state === 'CLOSED') && rowKey(s) !== key) continue;
    const branch = s.planned?.branch || pr?.head;
    const wt = branch ? await worktreeFor(repo, branch, exec) : null;
    if (wt) return wt;
  }
  return repo;
}

const toolText = (d) => (!d ? '' : d.type === 'shell' ? d.command : d.type === 'read' || d.type === 'edit' || d.type === 'write' ? d.filePath : d.type === 'search' ? d.query : d.type === 'fetch' ? d.url : d.type === 'plain_text' ? d.text || d.label || '' : d.type === 'sub_agent' ? d.description || '' : d.type === 'unknown' ? JSON.stringify(d.input ?? null) : '');
const marked = (text, mark) => (text == null || text === '' ? [] : String(text).split('\n').map((l) => `${mark} ${l}`));
const editDiff = (d) => d.unifiedDiff || [...marked(d.oldString, '-'), ...marked(d.newString, '+')].join('\n');
const toolOutput = (d) => (!d ? '' : d.type === 'shell' ? d.output || '' : d.type === 'read' || d.type === 'search' ? d.content || '' : d.type === 'fetch' ? d.result || '' : d.type === 'edit' ? editDiff(d) : d.type === 'write' ? d.content || '' : d.type === 'sub_agent' ? d.log || '' : d.type === 'unknown' ? (d.output == null ? '' : typeof d.output === 'string' ? d.output : JSON.stringify(d.output)) : '');

// Turns timeline events into entries: text and thinking once their message is complete (their deltas go to onDelta(text, 'text' | 'think') as they stream),
// a tool call once it has its result; onToolStart sees a running call each time what it shows changes.
export function createFollower({ onEntry, onDelta, onToolStart, onPermission } = {}) {
  const entries = [];
  const submitted = {};
  const done = new Set();
  const shown = new Map();
  const waiters = new Set();
  let chain = null;
  let cost = null;
  let failure = null;
  const emit = (e) => {
    entries.push(e);
    onEntry?.(e);
  };
  const close = () => {
    const text = chain?.text.trim();
    if (text) emit({ type: chain.type, text });
    chain = null;
  };
  const settle = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };
  function push(message) {
    const ev = message?.event;
    if (!ev) return;
    if (ev.type === 'timeline') {
      const it = ev.item;
      if (it.type === 'user_message') return;
      if (it.type === 'assistant_message' || it.type === 'reasoning') {
        const type = it.type === 'reasoning' ? 'think' : 'text';
        if (!chain || chain.type !== type || (it.messageId && chain.id && chain.id !== it.messageId)) {
          close();
          chain = { type, id: it.messageId, text: '' };
        }
        chain.text += it.text;
        onDelta?.(it.text, type);
        return;
      }
      close();
      if (it.type === 'tool_call' && it.status === 'running' && !done.has(it.callId)) {
        const kind = it.detail?.type || 'unknown';
        const text = toolText(it.detail);
        const seen = `${kind}\n${text}`;
        if (shown.get(it.callId) !== seen) {
          shown.set(it.callId, seen);
          onToolStart?.({ type: 'tool', id: it.callId, name: it.name, kind, input: it.detail?.type === 'unknown' ? it.detail.input : it.detail, text, output: '', status: 'running', error: null });
        }
      }
      if (it.type === 'tool_call' && it.status !== 'running' && !done.has(it.callId)) {
        done.add(it.callId);
        shown.delete(it.callId);
        const input = it.detail?.type === 'unknown' ? it.detail.input : it.detail;
        const m = it.name.match(COCO_TOOL);
        if (m && it.status === 'completed') submitted[m[1]] = input;
        emit({ type: 'tool', id: it.callId, name: it.name, kind: it.detail?.type || 'unknown', input, text: toolText(it.detail), output: toolOutput(it.detail), status: it.status, error: it.error ? String(it.error) : null });
      }
      if (it.type === 'error') emit({ type: 'error', text: it.message });
      return;
    }
    if (ev.type === 'permission_requested') {
      close();
      onPermission?.(ev.request?.title || ev.request?.name || 'permission');
    }
    if (ev.type === 'turn_completed') cost = ev.usage?.totalCostUsd ?? cost;
    if (ev.type === 'turn_failed') failure = ev.error;
    if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(ev.type)) close();
    if (['permission_resolved', 'turn_completed', 'turn_failed', 'turn_canceled'].includes(ev.type)) settle();
  }
  // resolves on the next permission answer or turn end, or after ms
  const nextSettle = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      waiters.add(() => (clearTimeout(timer), resolve()));
    });
  return { push, end: close, nextSettle, entries, submitted, cost: () => cost, failure: () => failure };
}

const EXCERPT = 2000;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
export const toolEvent = (e) => ({ type: 'tool', id: e.id || null, name: e.name, kind: e.kind || 'unknown', summary: clip(String(e.text || ''), 300), input: e.kind === 'unknown' && e.input != null ? clip(JSON.stringify(e.input), EXCERPT) : '', output: clip(String(e.error || e.output || ''), EXCERPT), status: e.status });

// the follower callbacks every conversation surface uses: keep() gets what is stored and replayed (text, think, tool running then settled under one id, stderr, meta),
// live() what only a watcher sees (delta and think_delta, batched)
export function activityEvents({ keep, live, deltaMs = 100 }) {
  const buffer = { delta: '', think_delta: '' };
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    for (const type of ['think_delta', 'delta']) {
      if (buffer[type]) live({ type, text: buffer[type] });
      buffer[type] = '';
    }
  };
  return {
    onDelta: (text, kind = 'text') => {
      buffer[kind === 'think' ? 'think_delta' : 'delta'] += text;
      timer ||= setTimeout(flush, deltaMs);
    },
    onToolStart: (e) => {
      flush();
      keep(toolEvent(e));
    },
    onEntry: (e) => {
      if (e.type === 'text' || e.type === 'think') {
        buffer[e.type === 'text' ? 'delta' : 'think_delta'] = '';
        flush();
        keep({ type: e.type, text: e.text });
      } else if (e.type === 'tool') {
        flush();
        keep(toolEvent(e));
      } else if (e.type === 'error') keep({ type: 'stderr', text: e.text.slice(0, EXCERPT) });
    },
    onPermission: (what) => keep({ type: 'meta', text: `waiting for a permission in Paseo: ${what}` }),
    flush,
  };
}

export function createPaseoAgents({ APP = null, connect = connectDaemon } = {}) {
  let pending = null;
  const client = () =>
    (pending ||= connect().catch((e) => {
      pending = null;
      throw e;
    }));

  // the workspace already open on cwd (the biggest project's when several share it); opening one only when there is none
  async function workspaceFor(cwd) {
    const c = await client();
    const entries = [];
    for (let cursor, page; !page || cursor; ) {
      page = await c.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      entries.push(...page.entries);
      cursor = page.pageInfo?.nextCursor;
    }
    const size = (p) => entries.filter((w) => w.projectId === p).length;
    const [best] = entries.filter((w) => !w.archivingAt && w.workspaceDirectory && sameDir(w.workspaceDirectory, cwd)).sort((a, b) => size(b.projectId) - size(a.projectId));
    if (best) return { workspace: c.workspaces.ref(best), created: false };
    const workspace = await c.workspaces.open(path.resolve(expandHome(cwd)));
    return { workspace, created: !entries.some((w) => w.id === workspace.id) };
  }

  // worktree: { mode: 'branch-off', newBranch, base, slug } | { mode: 'checkout-branch', branch } | { mode: 'checkout-pr', prNumber }, opened from the repo at cwd
  async function worktreeWorkspace(cwd, wt) {
    const action =
      wt.mode === 'branch-off' ? { action: 'branch-off', branchName: wt.newBranch, ...(wt.base ? { baseBranch: wt.base } : {}) } : wt.mode === 'checkout-branch' ? { action: 'checkout', refName: wt.branch } : { action: 'checkout', checkoutSource: { kind: 'change_request', number: Number(wt.prNumber) } };
    const workspace = await (await client()).workspaces.create({ source: { kind: 'worktree', cwd, ...(wt.slug ? { worktreeSlug: wt.slug } : {}), ...action } });
    return { workspace, created: true };
  }

  const configFor = ({ provider, mode, thinking, systemPrompt, mcp }) => ({
    provider,
    ...(mode ? { modeId: mode } : {}),
    ...(thinking ? { thinkingOptionId: thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(mcp
      ? {
          mcpServers: { cocopilot: { type: 'stdio', command: process.execPath, args: [path.join(APP, 'server/mcp.mjs')], alwaysLoad: true } },
          toolPolicy: { preapproved: COCO_MCP_TOOLS.map((tool) => ({ kind: 'mcp', server: 'cocopilot', tool })) },
        }
      : {}),
  });
  const cleanLabels = (labels) => Object.fromEntries(Object.entries(labels || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));

  // places and creates the agent; with a prompt it starts right away, coco does not follow it
  async function start({ title, prompt, labels, cwd = null, workspaceId = null, worktree = null, ...config }) {
    const { workspace, created } = workspaceId ? { workspace: (await client()).workspaces.ref(workspaceId), created: false } : worktree ? await worktreeWorkspace(cwd, worktree) : await workspaceFor(cwd);
    const agent = await workspace.agents.create({ title: cocoTitle(title), config: configFor(config), labels: cleanLabels(labels), ...(prompt ? { prompt } : {}) });
    return { agent, agentId: agent.id, workspaceId: workspace.id, createdWorkspace: created ? workspace.id : null };
  }

  // an agent coco started earlier, or null once it is archived or unknown to the daemon (an unreachable daemon throws)
  async function attach(agentId) {
    const agent = (await client()).agents.ref(agentId);
    const found = await agent.refresh();
    return found?.agent && !found.agent.archivedAt && found.agent.status !== 'closed' ? agent : null;
  }

  async function archive(agentId) {
    const agent = await attach(agentId);
    if (agent) await agent.archive();
    return Boolean(agent);
  }

  const outcome = (result, follow, timeoutMs) => {
    const status = result.status === 'idle' ? 'done' : result.status === 'permission' ? 'timeout' : result.status;
    const texts = follow.entries.filter((e) => e.type === 'text').map((e) => e.text);
    const error = status === 'timeout' ? `no answer within ${Math.round(timeoutMs / 60000)} min` : status === 'error' ? result.error || follow.failure() || 'the Paseo agent failed' : null;
    return {
      status,
      error,
      entries: follow.entries,
      submitted: follow.submitted,
      text: texts.join('\n\n'),
      finalText: result.lastMessage || texts.at(-1) || '',
      cost: follow.cost() ?? result.final?.lastUsage?.totalCostUsd ?? null,
    };
  };

  // one agent for a whole conversation, started from opts or re-attached by agentId (null once that agent is gone):
  // say() opens a turn, or steers the turn in flight like a thread follow-up; the agent lives until close()
  async function session({ agentId = null, onEntry, onDelta, onToolStart, onPermission, flush, ...opts }) {
    let agent;
    let started;
    if (agentId) {
      agent = await attach(agentId);
      if (!agent) return null;
      started = { agentId, workspaceId: agent.workspaceId, createdWorkspace: null };
    } else ({ agent, ...started } = await start(opts));
    const callbacks = { onEntry, onDelta, onToolStart, onPermission };
    let follow = createFollower(callbacks);
    const unsubscribe = agent.timeline.subscribe((m) => follow.push(m));
    const { ready } = unsubscribe;
    ready.catch(() => {});
    // messages leave in order, once the timeline is followed; one reaching a busy agent joins its turn
    let sending = Promise.resolve();
    const deliver = (text) => (sending = sending.catch(() => {}).then(() => ready).then(() => agent.send(text, { activeTurnBehavior: 'steer' })));
    let inFlight = null;
    let steered = false;

    // prompt null waits on the turn the agent is already in; waits through permissions answered in Paseo and a steer landing as the turn ends
    async function turn(prompt, timeoutMs) {
      follow = createFollower(callbacks);
      steered = false;
      const deadline = Date.now() + timeoutMs;
      let result;
      try {
        await (prompt === null ? ready : deliver(prompt));
        result = await agent.waitForFinish(timeoutMs);
        for (let left; (left = deadline - Date.now()) > 0; ) {
          if (result.status === 'permission') await follow.nextSettle(left);
          else if (result.status === 'idle' && steered) {
            steered = false;
            await sending.catch(() => {});
            await agent.refresh().catch(() => null);
            if (agent.status !== 'running') break;
          } else break;
          result = await agent.waitForFinish(Math.max(1, deadline - Date.now()));
        }
      } catch (e) {
        result = { status: 'error', error: e.message };
      }
      follow.end();
      flush?.();
      return outcome(result, follow, timeoutMs);
    }
    const track = (p) => (inFlight = p.finally(() => (inFlight = null)));

    return {
      ...started,
      busy: () => Boolean(inFlight),
      cwd: () => agent.cwd || null,
      say(text, { timeoutMs = TIMEOUT_MS } = {}) {
        if (!inFlight) return track(turn(text, timeoutMs));
        steered = true;
        return deliver(text).then(() => ({ steered: true }));
      },
      resume: ({ timeoutMs = TIMEOUT_MS } = {}) => inFlight || track(turn(null, timeoutMs)),
      // stops following; the agent lives on
      detach: () => unsubscribe(),
      async close() {
        unsubscribe();
        await agent.archive().catch(() => {});
      },
    };
  }

  // starts the agent, follows its timeline until the turn ends (waiting through permission requests answered in Paseo), then archives it, failures included
  async function run({ prompt, timeoutMs = TIMEOUT_MS, onStart, ...opts }) {
    const s = await session(opts);
    const started = { agentId: s.agentId, workspaceId: s.workspaceId, createdWorkspace: s.createdWorkspace };
    onStart?.(started);
    try {
      return { ...started, ...(await s.say(prompt, { timeoutMs })) };
    } finally {
      await s.close();
    }
  }

  return { start, run, session, attach, archive, workspaceFor, client };
}
