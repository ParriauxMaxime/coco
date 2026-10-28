// Every agent coco starts runs through the Paseo daemon (its SDK): in the workspace already open on its directory, titled `coco · …`, followed live, archived once done (a conversation's once closed).
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient as RawDaemon } from '@getpaseo/client/internal/daemon-client';
import { rowKey } from './stack.ts';
import { promptSize, systemSize } from './agent-usage.ts';
import type { UsageStore } from './agent-usage.ts';
import type { PermissionClient, PermissionRequest } from './permissions.ts';
import type { UploadRef } from './uploads.ts';
import type { SubagentApi } from './subagents.ts';

export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
export const TITLE_PREFIX = 'coco · ';
const TITLE_MAX = 60;
const DEFAULT_LISTEN = '127.0.0.1:6767';
const TIMEOUT_MS = 15 * 60 * 1000;
const HOME = os.homedir();
// the one cocopilot tool whose input is the run's result; the other proposals are cards
const COCO_TOOL = /^mcp__cocopilot__(propose_review_plan)$/;
// the server.tool names of server/mcp.ts, preapproved like any plugin preapproves its own tools
export const COCO_MCP_TOOLS = ['list_works', 'get_work', 'get_review_context', 'get_pr_findings', 'get_drift', 'list_personas', 'read_persona', 'suggest_personas', 'consult_persona', 'read_skill', 'list_paseo', 'github_pr', 'github_search', 'propose_work_scaffold', 'propose_stack_edit', 'propose_split', 'propose_pr_reply', 'propose_paseo_agent', 'propose_rules', 'propose_review_plan', 'propose_repo', 'dispatch', 'ask', 'post_blocks', 'upsert_finding', 'flag_coco_issue', 'upsert_decision', 'attach_media', 'import_artifact', 'set_kit_scope', 'set_next', 'own_deps', 'post_reply'];
// every coco agent's one line on cards (docs/agent-io.md); Claude agents also lose AskUserQuestion
export const CARDS_LINE = 'Ask the user only with the cocopilot ask tool, never AskUserQuestion: it returns at once and the answer comes back later as a new user message, so end your turn or keep working. Show rich results (tables, diagrams, code) with cocopilot post_blocks. A reply to a PR comment goes through cocopilot propose_pr_reply: the user posts it from the card, so draft it there instead of refusing or handing back a command. When the user asks for a change to coco itself, call cocopilot flag_coco_issue with their words and answer with the link it returns: never refuse, and never change coco code from another work. When the user asks what a reviewer would do or asks for a tradeoff, call cocopilot consult_persona and answer with that reviewer\'s call plus an ask card: do not start a persona review unless asked. To split a PR, create the branches and PRs, then call cocopilot propose_split once: never use the Update work replace for it. Edit code files only with the Edit or Write tools after a Read, never with sed, python or heredocs in Bash: a hook blocks those and can leave a file half-edited.';

type ExecResult = { ok: boolean; stdout: string; stderr: string };
type Exec = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<ExecResult>;
type RowKey = number | string;
type StackRow = { number?: number | null; planned?: { branch?: string } };

export type ToolDetail = { type: string; command?: string; filePath?: string; query?: string; url?: string; text?: string; label?: string; description?: string; input?: unknown; output?: unknown; content?: string; result?: string; log?: string; unifiedDiff?: string; oldString?: string; newString?: string };
type TimelineItem = { type: string; text?: string; messageId?: string; callId?: string; status?: string; name?: string; detail?: ToolDetail; error?: unknown; message?: string };
export type TimelineEvent = { type: string; provider?: string; item?: TimelineItem; request?: PermissionRequest; requestId?: string; resolution?: unknown; usage?: { totalCostUsd?: number }; error?: unknown };
type TimelineMessage = { agentId?: string; event?: TimelineEvent } | null;
export type Entry = { type: string; text?: string; id?: string | null; name?: string; kind?: string; input?: unknown; output?: string; status?: string; error?: string | null };
export type ToolStart = { type: 'tool'; id?: string; name?: string; kind: string; input: unknown; text: string; output: string; status: string; error: string | null };
export type PermissionEvent = { type: 'permission'; agentId: string | null; request: PermissionRequest } | { type: 'permission_resolved'; agentId: string | null; requestId: string; resolution: unknown };
export type ActivityEvent = { type: string; id?: string | null; name?: string; kind?: string; summary?: string; input?: string; output?: string; status?: string; text?: string; agentId?: string | null; request?: PermissionRequest; requestId?: string; resolution?: unknown; attachments?: UploadRef[] };
export type FollowerCallbacks = { onEntry?: (e: Entry) => void; onDelta?: (text: string, kind?: 'text' | 'think') => void; onToolStart?: (e: ToolStart) => void; onPermission?: (e: PermissionEvent) => void };
export type WaitResult = { status: string; error?: string | null; lastMessage?: string | null; final?: { lastUsage?: { totalCostUsd?: number } | null } | null };
type Unsubscribe = (() => void) & { ready?: Promise<unknown> };
type Cursor = { epoch: string; seq: number };
type TimelinePage = { entries: { item?: TimelineItem; timestamp?: string }[]; startCursor?: Cursor | null; hasOlder?: boolean };
export type DaemonAgent = {
  id: string;
  workspaceId?: string | null;
  cwd?: string | null;
  status?: string | null;
  timeline: { subscribe(handler: (m: TimelineMessage) => void): Unsubscribe; refetch?(opts: { direction: 'tail' | 'before'; cursor?: Cursor; limit: number; projection: 'projected' }): Promise<TimelinePage> };
  send(text: string, opts?: { activeTurnBehavior?: string } & AgentInput): Promise<unknown>;
  waitForFinish(timeoutMs?: number): Promise<WaitResult>;
  refresh(): Promise<{ agent?: { archivedAt?: unknown; status?: string | null; updatedAt?: string | null; title?: string | null; labels?: Record<string, string>; provider?: string | null; model?: string | null; thinkingOptionId?: string | null } | null } | null>;
  archive(): Promise<unknown>;
} & ReturnType<PermissionClient['agents']['ref']>;
export type WorkspaceEntry = { id: string; projectId?: string; workspaceDirectory?: string; archivingAt?: unknown; name?: string | null; title?: string | null; projectDisplayName?: string | null; activityAt?: string | null; lastUserMessageAt?: string | null; createdAt?: string | null };
export type WorkspaceHandle = { id: string; agents: { create(opts: Record<string, unknown>): Promise<DaemonAgent> } };
export type DaemonClient = {
  workspaces: {
    list(opts: { page: { limit: number; cursor?: string } }): Promise<{ entries: WorkspaceEntry[]; pageInfo?: { nextCursor?: string } }>;
    ref(w: string | WorkspaceEntry): WorkspaceHandle;
    open(cwd: string): Promise<WorkspaceHandle>;
    create(opts: Record<string, unknown>): Promise<WorkspaceHandle>;
    archive?(workspaceId: string): Promise<{ error?: string | null }>;
  };
  agents: { ref(id: string): DaemonAgent; list?: PermissionClient['agents']['list'] };
  providers?: { listModels(provider: string): Promise<{ models?: { id: string; label?: string; description?: string; isSelectable?: boolean; aliases?: string[]; thinkingOptions?: { id: string; label?: string }[]; defaultThinkingOptionId?: string }[]; error?: string | null }> };
  setAgentModel?(agentId: string, modelId: string | null): Promise<unknown>;
  setAgentThinkingOption?(agentId: string, thinkingOptionId: string | null): Promise<unknown>;
} & SubagentApi;
type Worktree = { mode: string; newBranch?: string; base?: string; branch?: string; prNumber?: number | string; slug?: string };

// The server may run inside a Paseo agent's shell: its PASEO_AGENT_ID would make every CLI launch that agent's subagent and pin it to that agent's workspace.
const AMBIENT_PASEO = ['PASEO_AGENT_ID', 'PASEO_AGENT_CWD', 'PASEO_WORKSPACE_ID'];
export const launcherEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !AMBIENT_PASEO.includes(k)));
export const expandHome = (p: unknown) => String(p || '').replace(/^~(?=\/|$)/, HOME);
export const sameDir = (a: string, b: string) => path.resolve(expandHome(a)) === path.resolve(expandHome(b));
export const cocoTitle = (title: unknown) => `${TITLE_PREFIX}${String(title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX)}`;

const parseJson = (text: string, fallback: unknown) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

// PASEO_URL wins; otherwise the endpoint `paseo status` reports for the local daemon
export async function daemonUrl(exec: Exec = defaultExec) {
  if (process.env.PASEO_URL) return process.env.PASEO_URL;
  const r = await exec('paseo', ['status', '--json'], { env: launcherEnv(), timeout: 15000 });
  const listen = r.ok ? parseJson(r.stdout, null)?.listen : null;
  return `ws://${/^[\w.[\]-]+:\d+$/.test(listen || '') ? listen : DEFAULT_LISTEN}/ws`;
}

// the local daemon's id, the host part of the Paseo app's deep links
export async function daemonServerId(exec: Exec = defaultExec): Promise<string | null> {
  const r = await exec('paseo', ['status', '--json'], { env: launcherEnv(), timeout: 15000 });
  const id = r.ok ? parseJson(r.stdout, null)?.serverId : null;
  return typeof id === 'string' && id ? id : null;
}

export async function connectDaemon({ exec = defaultExec }: { exec?: Exec } = {}): Promise<DaemonClient> {
  const url = await daemonUrl(exec);
  // the SDK's own client, plus the model and thinking setters only its inner daemon client has
  const raw = new RawDaemon({ url, clientId: 'cocopilot', clientType: 'cli', password: process.env.PASEO_PASSWORD || undefined, reconnect: { enabled: true } });
  const api = createPaseoApi(raw);
  const close = () => api.dispose().finally(() => raw.close());
  const client = { ...api, close, setAgentModel: (id: string, m: string | null) => raw.setAgentModel(id, m), setAgentThinkingOption: (id: string, t: string | null) => raw.setAgentThinkingOption(id, t) };
  Object.assign(client, { listProviderSubagents: (id: string) => raw.listProviderSubagents(id), fetchProviderSubagentTimeline: (id: string, sub: string, opts?: Parameters<RawDaemon['fetchProviderSubagentTimeline']>[2]) => raw.fetchProviderSubagentTimeline(id, sub, opts) });
  try {
    await raw.connect();
  } catch (e) {
    await close().catch(() => {});
    throw new Error(`cannot reach the Paseo daemon at ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return client as unknown as DaemonClient;
}

export async function worktreeFor(repo: string, branch: string, exec: Exec = defaultExec) {
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
export async function workCwd({ repo, work, key = null, prInfo, exec = defaultExec }: { repo: string; work?: { stack?: StackRow[] } | null; key?: RowKey | null; prInfo: (n: number) => Promise<{ state?: string; head?: string | null } | null | undefined>; exec?: Exec }) {
  const rows = work?.stack || [];
  const ordered = [...rows.filter((s) => key && rowKey(s) === key), ...[...rows].reverse().filter((s) => !key || rowKey(s) !== key)];
  for (const s of ordered) {
    const pr = s.number ? await prInfo(s.number) : null;
    if (pr && (pr.state === 'MERGED' || pr.state === 'CLOSED') && rowKey(s) !== key) continue;
    const branch = pr?.head || s.planned?.branch;
    const wt = branch ? await worktreeFor(repo, branch, exec) : null;
    if (wt) return wt;
  }
  return repo;
}

const toolText = (d?: ToolDetail | null): string => (!d ? '' : d.type === 'shell' ? d.command || '' : d.type === 'read' || d.type === 'edit' || d.type === 'write' ? d.filePath || '' : d.type === 'search' ? d.query || '' : d.type === 'fetch' ? d.url || '' : d.type === 'plain_text' ? d.text || d.label || '' : d.type === 'sub_agent' ? d.description || '' : d.type === 'unknown' ? JSON.stringify(d.input ?? null) : '');
const marked = (text: unknown, mark: string) => (text == null || text === '' ? [] : String(text).split('\n').map((l) => `${mark} ${l}`));
const editDiff = (d: ToolDetail) => d.unifiedDiff || [...marked(d.oldString, '-'), ...marked(d.newString, '+')].join('\n');
const toolOutput = (d?: ToolDetail | null): string => (!d ? '' : d.type === 'shell' ? (d.output as string) || '' : d.type === 'read' || d.type === 'search' ? d.content || '' : d.type === 'fetch' ? d.result || '' : d.type === 'edit' ? editDiff(d) : d.type === 'write' ? d.content || '' : d.type === 'sub_agent' ? d.log || '' : d.type === 'unknown' ? (d.output == null ? '' : typeof d.output === 'string' ? d.output : JSON.stringify(d.output)) : '');

// Turns timeline events into entries: text and thinking once their message is complete (their deltas go to onDelta(text, 'text' | 'think') as they stream),
// a tool call once it has its result; onToolStart sees a running call each time what it shows changes.
export function createFollower({ onEntry, onDelta, onToolStart, onPermission, agentId = null }: FollowerCallbacks & { agentId?: string | null } = {}) {
  const entries: Entry[] = [];
  const submitted: Record<string, unknown> = {};
  const done = new Set<string | undefined>();
  const shown = new Map<string | undefined, string>();
  const waiters = new Set<() => void>();
  let chain: { type: string; id?: string; text: string } | null = null;
  let cost: number | null = null;
  let failure: unknown = null;
  const emit = (e: Entry) => {
    entries.push(e);
    onEntry?.(e);
  };
  const close = () => {
    const text = chain?.text.trim();
    if (chain && text) emit({ type: chain.type, text });
    chain = null;
  };
  const settle = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };
  function push(message: TimelineMessage | undefined) {
    const ev = message?.event;
    if (!ev) return;
    if (ev.type === 'timeline') {
      const it = ev.item;
      if (!it) return;
      if (it.type === 'user_message') return;
      if (it.type === 'assistant_message' || it.type === 'reasoning') {
        const type = it.type === 'reasoning' ? 'think' : 'text';
        if (!chain || chain.type !== type || (it.messageId && chain.id && chain.id !== it.messageId)) {
          close();
          chain = { type, id: it.messageId, text: '' };
        }
        chain.text += it.text;
        onDelta?.(it.text ?? '', type);
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
        const m = (it.name ?? '').match(COCO_TOOL);
        if (m?.[1] && it.status === 'completed') submitted[m[1]] = input;
        emit({ type: 'tool', id: it.callId, name: it.name, kind: it.detail?.type || 'unknown', input, text: toolText(it.detail), output: toolOutput(it.detail), status: it.status, error: it.error ? String(it.error) : null });
      }
      if (it.type === 'error') emit({ type: 'error', text: it.message });
      return;
    }
    if (ev.type === 'permission_requested' && ev.request?.id) {
      close();
      onPermission?.({ type: 'permission', agentId, request: ev.request });
    }
    if (ev.type === 'permission_resolved' && ev.requestId) onPermission?.({ type: 'permission_resolved', agentId, requestId: ev.requestId, resolution: ev.resolution ?? null });
    if (ev.type === 'turn_completed') cost = ev.usage?.totalCostUsd ?? cost;
    if (ev.type === 'turn_failed') failure = ev.error;
    if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(ev.type)) close();
    if (['permission_resolved', 'turn_completed', 'turn_failed', 'turn_canceled'].includes(ev.type)) settle();
  }
  // resolves on the next permission answer or turn end, or after ms
  const nextSettle = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      waiters.add(() => (clearTimeout(timer), resolve()));
    });
  return { push, end: close, nextSettle, entries, submitted, cost: () => cost, failure: () => failure };
}
type Follower = ReturnType<typeof createFollower>;

const EXCERPT = 2000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
// what logs keep of a request: long strings (a file to write, a long command) cut, the live list keeps them whole
const clipDeep = (v: unknown): unknown => (typeof v === 'string' ? clip(v, EXCERPT) : Array.isArray(v) ? v.map(clipDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x)])) : v);
export const toolEvent = (e: Entry): ActivityEvent => ({ type: 'tool', id: e.id || null, name: e.name, kind: e.kind || 'unknown', summary: clip(String(e.text || ''), 300), input: e.kind === 'unknown' && e.input != null ? clip(JSON.stringify(e.input), EXCERPT) : '', output: clip(String(e.error || e.output || ''), EXCERPT), status: e.status });

// the follower callbacks every conversation surface uses: keep() gets what is stored and replayed (text, think, tool running then settled under one id, stderr, meta),
// live() what only a watcher sees (delta and think_delta, batched)
export function activityEvents({ keep, live, deltaMs = 100 }: { keep: (ev: ActivityEvent) => void; live: (ev: ActivityEvent) => void; deltaMs?: number }) {
  const buffer = { delta: '', think_delta: '' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const type of ['think_delta', 'delta'] as const) {
      if (buffer[type]) live({ type, text: buffer[type] });
      buffer[type] = '';
    }
  };
  return {
    onDelta: (text: string, kind: 'text' | 'think' = 'text') => {
      buffer[kind === 'think' ? 'think_delta' : 'delta'] += text;
      timer ||= setTimeout(flush, deltaMs);
    },
    onToolStart: (e: ToolStart) => {
      flush();
      keep(toolEvent(e));
    },
    onEntry: (e: Entry) => {
      if (e.type === 'text' || e.type === 'think') {
        buffer[e.type === 'text' ? 'delta' : 'think_delta'] = '';
        flush();
        keep({ type: e.type, text: e.text });
      } else if (e.type === 'tool') {
        flush();
        keep(toolEvent(e));
      } else if (e.type === 'error') keep({ type: 'stderr', text: (e.text ?? '').slice(0, EXCERPT) });
    },
    onPermission: (e: PermissionEvent) => {
      flush();
      keep(e.type === 'permission' ? { ...e, request: clipDeep(e.request) as PermissionRequest } : e);
    },
    flush,
  };
}

const HISTORY_PAGE = 200;
const HISTORY_PAGES = 20;

// an agent's whole timeline, oldest first, deltas merged into their messages
export async function timelineOf(agent: Pick<DaemonAgent, 'timeline'>, maxPages = HISTORY_PAGES) {
  const { timeline } = agent;
  if (!timeline.refetch) return [];
  const pages: TimelinePage[] = [];
  let page = await timeline.refetch({ direction: 'tail', limit: HISTORY_PAGE, projection: 'projected' });
  pages.unshift(page);
  while (page.hasOlder && page.startCursor && pages.length < maxPages) {
    page = await timeline.refetch({ direction: 'before', cursor: page.startCursor, limit: HISTORY_PAGE, projection: 'projected' });
    pages.unshift(page);
  }
  return pages.flatMap((p) => p.entries);
}
export type AgentHistory = { status: string | null; archived: boolean; updatedAt: string | null; userMessages: { text: string; at: string | null }[] };
export type Outcome = { status: string; error: string | null; entries: Entry[]; submitted: Record<string, unknown>; text: string; finalText: string; cost: number | null };
export type Started = { agentId: string; workspaceId: string | null | undefined; createdWorkspace: string | null };
type AgentConfig = { provider?: string; thinking?: string; systemPrompt?: string; mcp?: boolean };
// every coco agent works on its own; a brief saying not to touch code is what keeps one read-only
export const AGENT_MODE = 'auto';
// files sent with a message: images inline, other files by path (Paseo's uploaded_file attachment)
export type AgentInput = { images?: { data: string; mimeType: string }[]; attachments?: { type: 'uploaded_file'; id: string; fileName: string; mimeType: string; size: number; path: string }[]; messageId?: string };
type StartOptions = AgentConfig & { title: string; prompt?: string; input?: AgentInput; labels?: Record<string, unknown>; cwd?: string | null; workspaceId?: string | null; worktree?: Worktree | null };
export type SessionOptions = Omit<StartOptions, 'prompt' | 'title'> & { title?: string } & FollowerCallbacks & { agentId?: string | null; flush?: () => void };
export type AgentSession = Started & {
  busy(): boolean;
  cwd(): string | null;
  say(text: string, opts?: { timeoutMs?: number; input?: AgentInput }): Promise<Outcome | { steered: true }>;
  resume(opts?: { timeoutMs?: number }): Promise<Outcome>;
  detach(): void;
  close(): Promise<void>;
};

export function createPaseoAgents({ APP = null, connect = connectDaemon, usage = null }: { APP?: string | null; connect?: () => Promise<DaemonClient>; usage?: Pick<UsageStore, 'record'> | null } = {}) {
  let pending: Promise<DaemonClient> | null = null;
  const client = () =>
    (pending ||= connect().catch((e) => {
      pending = null;
      throw e;
    }));

  // the workspace already open on cwd (the biggest project's when several share it); opening one only when there is none
  async function listWorkspaces() {
    const c = await client();
    const entries: WorkspaceEntry[] = [];
    for (let cursor: string | undefined, page: Awaited<ReturnType<typeof c.workspaces.list>> | undefined; !page || cursor; ) {
      page = await c.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      entries.push(...page.entries);
      cursor = page.pageInfo?.nextCursor;
    }
    return entries;
  }

  async function workspaceFor(cwd: string) {
    const c = await client();
    const entries = await listWorkspaces();
    const size = (p?: string) => entries.filter((w) => w.projectId === p).length;
    const [best] = entries.filter((w) => !w.archivingAt && w.workspaceDirectory && sameDir(w.workspaceDirectory, cwd)).sort((a, b) => size(b.projectId) - size(a.projectId));
    if (best) return { workspace: c.workspaces.ref(best), created: false };
    const workspace = await c.workspaces.open(path.resolve(expandHome(cwd)));
    return { workspace, created: !entries.some((w) => w.id === workspace.id) };
  }

  // worktree: { mode: 'branch-off', newBranch, base, slug } | { mode: 'checkout-branch', branch } | { mode: 'checkout-pr', prNumber }, opened from the repo at cwd
  async function worktreeWorkspace(cwd: string | null, wt: Worktree) {
    const action =
      wt.mode === 'branch-off' ? { action: 'branch-off', branchName: wt.newBranch, ...(wt.base ? { baseBranch: wt.base } : {}) } : wt.mode === 'checkout-branch' ? { action: 'checkout', refName: wt.branch } : { action: 'checkout', checkoutSource: { kind: 'change_request', number: Number(wt.prNumber) } };
    const workspace = await (await client()).workspaces.create({ source: { kind: 'worktree', cwd, ...(wt.slug ? { worktreeSlug: wt.slug } : {}), ...action } });
    return { workspace, created: true };
  }

  const configFor = ({ provider, thinking, systemPrompt, mcp = true }: AgentConfig) => {
    const system = mcp ? [systemPrompt, CARDS_LINE].filter(Boolean).join('\n') : systemPrompt;
    return {
      provider,
      modeId: AGENT_MODE,
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      ...(system ? { systemPrompt: system } : {}),
      ...(mcp
        ? {
            mcpServers: { cocopilot: { type: 'stdio', command: process.execPath, args: [path.join(APP ?? '', 'server/mcp.ts')], alwaysLoad: true } },
            toolPolicy: { preapproved: COCO_MCP_TOOLS.map((tool) => ({ kind: 'mcp', server: 'cocopilot', tool })) },
            ...(String(provider).startsWith('claude/') ? { options: { disallowedTools: ['AskUserQuestion'] } } : {}),
          }
        : {}),
    };
  };
  const cleanLabels = (labels?: Record<string, unknown>) => Object.fromEntries(Object.entries(labels || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));

  // places and creates the agent; with a prompt it starts right away, coco does not follow it
  async function start({ title, prompt, input, labels, cwd = null, workspaceId = null, worktree = null, ...config }: StartOptions) {
    const { workspace, created } = workspaceId ? { workspace: (await client()).workspaces.ref(workspaceId), created: false } : worktree ? await worktreeWorkspace(cwd, worktree) : await workspaceFor(cwd ?? '');
    const { messageId, ...files } = input || {};
    const agentConfig = configFor(config);
    const agent = await workspace.agents.create({ title: cocoTitle(title), config: agentConfig, labels: cleanLabels(labels), ...(prompt ? { prompt, ...files, ...(messageId ? { clientMessageId: messageId } : {}) } : {}) });
    usage?.record(agent.id, { ...promptSize(prompt), ...systemSize(agentConfig.systemPrompt) });
    return { agent, agentId: agent.id, workspaceId: workspace.id, createdWorkspace: created ? workspace.id : null };
  }

  // an agent coco started earlier, or null once it is archived or unknown to the daemon (an unreachable daemon throws)
  async function attach(agentId: string) {
    const agent = (await client()).agents.ref(agentId);
    const found = await agent.refresh();
    return found?.agent && !found.agent.archivedAt && found.agent.status !== 'closed' ? agent : null;
  }

  async function archive(agentId: string) {
    const agent = await attach(agentId);
    if (agent) await agent.archive();
    return Boolean(agent);
  }

  // archives a one-off agent once its turn ends well; one still waiting on the owner, failed or out of time is left for them to see
  async function archiveWhenDone(agentId: string, { timeoutMs = TIMEOUT_MS, pollMs = 5000 } = {}) {
    const agent = await attach(agentId);
    if (!agent) return false;
    const deadline = Date.now() + timeoutMs;
    for (let left; (left = deadline - Date.now()) > 0; ) {
      const r = await agent.waitForFinish(left);
      if (r.status === 'idle') return Boolean(await agent.archive());
      if (r.status !== 'permission') return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return false;
  }

  // what the user sent an agent, oldest first (its first prompt included), archived agents too; null once the daemon no longer knows it
  async function history(agentId: string): Promise<AgentHistory | null> {
    const agent = (await client()).agents.ref(agentId);
    const found = (await agent.refresh())?.agent;
    if (!found || !agent.timeline.refetch) return null;
    const userMessages = (await timelineOf(agent)).flatMap((e) => (e.item?.type === 'user_message' && e.item.text ? [{ text: e.item.text, at: e.timestamp || null }] : []));
    return { status: found.status || null, archived: Boolean(found.archivedAt) || found.status === 'closed', updatedAt: found.updatedAt || null, userMessages };
  }

  const outcome = (result: WaitResult, follow: Follower, timeoutMs: number): Outcome => {
    const status = result.status === 'idle' ? 'done' : result.status === 'permission' ? 'timeout' : result.status;
    const texts = follow.entries.filter((e) => e.type === 'text').map((e) => e.text ?? '');
    const failure = follow.failure();
    const error = status === 'timeout' ? `no answer within ${Math.round(timeoutMs / 60000)} min` : status === 'error' ? result.error || (failure ? String(failure) : null) || 'the Paseo agent failed' : null;
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
  async function session(opts: SessionOptions & { agentId: string }): Promise<AgentSession | null>;
  async function session(opts: SessionOptions & { agentId?: null }): Promise<AgentSession>;
  async function session({ agentId = null, onEntry, onDelta, onToolStart, onPermission, flush, ...opts }: SessionOptions): Promise<AgentSession | null> {
    let agent: DaemonAgent;
    let started: Started;
    if (agentId) {
      const found = await attach(agentId);
      if (!found) return null;
      agent = found;
      started = { agentId, workspaceId: agent.workspaceId, createdWorkspace: null };
    } else {
      const { agent: created, ...rest } = await start({ ...opts, title: opts.title ?? '' });
      agent = created;
      started = rest;
    }
    const callbacks = { onEntry, onDelta, onToolStart, onPermission, agentId: started.agentId };
    let follow = createFollower(callbacks);
    const unsubscribe = agent.timeline.subscribe((m) => follow.push(m));
    const { ready } = unsubscribe;
    ready?.catch(() => {});
    // messages leave in order, once the timeline is followed; one reaching a busy agent joins its turn
    let sending: Promise<unknown> = Promise.resolve();
    const deliver = (text: string, input?: AgentInput) => (sending = sending.catch(() => {}).then(() => ready).then(() => agent.send(text, { activeTurnBehavior: 'steer', ...input })));
    let inFlight: Promise<Outcome> | null = null;
    let steered = false;
    let first = !agentId;

    // prompt null waits on the turn the agent is already in; waits through permissions answered in coco or Paseo and a steer landing as the turn ends
    async function turn(prompt: string | null, timeoutMs: number, input?: AgentInput): Promise<Outcome> {
      follow = createFollower(callbacks);
      steered = false;
      if (first && prompt !== null) usage?.record(started.agentId, promptSize(prompt), { onlyIfMissing: true });
      first = false;
      const deadline = Date.now() + timeoutMs;
      let result: WaitResult;
      try {
        await (prompt === null ? ready : deliver(prompt, input));
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
        result = { status: 'error', error: e instanceof Error ? e.message : String(e) };
      }
      follow.end();
      flush?.();
      return outcome(result, follow, timeoutMs);
    }
    const track = (p: Promise<Outcome>) => (inFlight = p.finally(() => (inFlight = null)));

    return {
      ...started,
      busy: () => Boolean(inFlight),
      cwd: () => agent.cwd || null,
      say(text, { timeoutMs = TIMEOUT_MS, input } = {}) {
        if (!inFlight) return track(turn(text, timeoutMs, input));
        steered = true;
        return deliver(text, input).then(() => ({ steered: true }));
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

  // starts the agent, follows its timeline until the turn ends (waiting through permission requests answered in coco or Paseo), then archives it, failures included
  async function run({ prompt, timeoutMs = TIMEOUT_MS, onStart, ...opts }: Omit<SessionOptions, 'agentId'> & { prompt: string; timeoutMs?: number; onStart?: (started: Started) => void }) {
    const s = await session(opts);
    const started = { agentId: s.agentId, workspaceId: s.workspaceId, createdWorkspace: s.createdWorkspace };
    onStart?.(started);
    try {
      const result = await s.say(prompt, { timeoutMs });
      if ('steered' in result) throw new Error('the Paseo agent was already working');
      return { ...started, ...result };
    } finally {
      await s.close();
    }
  }

  return { start, run, session, attach, archive, archiveWhenDone, history, workspaceFor, listWorkspaces, client };
}
