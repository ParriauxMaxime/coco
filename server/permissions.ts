// What coco's agents wait on the owner for (a question, a tool to allow, a plan to approve): kept per agent from Paseo's live agent list,
// answered from coco through the SDK, gone once answered here or in Paseo.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { TITLE_PREFIX } from './paseo-agent.ts';
import { sseSink } from './events.ts';
import type { Sink } from './events.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { PaseoUsage } from './agent-usage.ts';

const WAIT_MS = 10000;
const RETRY_MS = 30000;
const PAGE = 200;
const SOURCES = ['cocopilot', 'cockpit'];

export type PermissionAction = { id: string; label: string; behavior: 'allow' | 'deny'; variant?: string; intent?: string };
export type PermissionRequest = { id: string; provider?: string; name: string; kind: string; title?: string; description?: string; input?: Record<string, unknown>; detail?: unknown; suggestions?: Record<string, unknown>[]; actions?: PermissionAction[]; metadata?: Record<string, unknown> };
export type PermissionResponse =
  | { behavior: 'allow'; selectedActionId?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[] }
  | { behavior: 'deny'; selectedActionId?: string; message?: string; interrupt?: boolean };
export type AgentSnapshot = { id: string; title?: string | null; labels?: Record<string, string>; archivedAt?: string | null; status?: string | null; updatedAt?: string | null; lastUserMessageAt?: string | null; createdAt?: string | null; workspaceId?: string | null; cwd?: string | null; pendingPermissions?: PermissionRequest[]; lastUsage?: PaseoUsage | null };
export type AgentUpdate = { kind: 'upsert'; agent: AgentSnapshot } | { kind: 'remove'; agentId: string };
type AgentListener = (agent: AgentSnapshot | null, removed?: string) => void;
type AgentPage = { entries: { agent: AgentSnapshot }[]; pageInfo?: { nextCursor?: string | null } };
export type AgentListObserver = { snapshot(s: AgentPage): void; update(m: { type: string; payload?: unknown }): void; error?(e: unknown): void };
export type PermissionClient = {
  agents: {
    list?(opts: Record<string, unknown>): Promise<AgentPage & { subscription?: { subscribe(o: AgentListObserver): () => void } }>;
    ref(id: string): { respondToPermission?(opts: { requestId: string; response: PermissionResponse }): Promise<void> };
  };
};
export type Where = { label: string; href: string };
// work, pr: from the agent's labels, the PR as a row key
export type Pending = { agentId: string; agentTitle: string | null; request: PermissionRequest; since: string; where: Where | null; work: string | null; pr: string | null };

export const isCocoAgent = (a: AgentSnapshot) => SOURCES.includes(a.labels?.source ?? '') || Boolean(a.title?.startsWith(TITLE_PREFIX));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// the body of an answer, reduced to what Paseo takes
export function parseResponse(body: unknown): PermissionResponse {
  if (!isRecord(body) || (body.behavior !== 'allow' && body.behavior !== 'deny')) throw new HttpError(400, 'behavior must be allow or deny');
  const actionId = typeof body.selectedActionId === 'string' ? { selectedActionId: body.selectedActionId } : {};
  if (body.behavior === 'deny') return { behavior: 'deny', ...actionId, ...(typeof body.message === 'string' ? { message: body.message } : {}), ...(typeof body.interrupt === 'boolean' ? { interrupt: body.interrupt } : {}) };
  if (body.updatedInput !== undefined && !isRecord(body.updatedInput)) throw new HttpError(400, 'updatedInput must be an object');
  if (body.updatedPermissions !== undefined && !(Array.isArray(body.updatedPermissions) && body.updatedPermissions.every(isRecord))) throw new HttpError(400, 'updatedPermissions must be a list of objects');
  return { behavior: 'allow', ...actionId, ...(body.updatedInput ? { updatedInput: body.updatedInput } : {}), ...(body.updatedPermissions ? { updatedPermissions: body.updatedPermissions as Record<string, unknown>[] } : {}) };
}

type AskConv = { id: string; kind: string; scope: { kind: 'global' } | { kind: 'repo'; repoId: string } | { kind: 'work'; slug: string } };
type WhereDeps = { askOf?: (agentId: string) => AskConv | null; groupKind?: (slug: string, groupId: string) => string | null; workTitle?: (slug: string) => string | null; repoName?: (id: string) => string | null };

// the coco page showing the agent's activity: its Ask conversation, review run, thread group, work or repo
export function whereOf(agent: AgentSnapshot, { askOf, groupKind, workTitle, repoName }: WhereDeps = {}): Where | null {
  const l = agent.labels || {};
  const work = (slug: string) => workTitle?.(slug) || slug;
  const conv = askOf?.(agent.id);
  if (conv?.kind === 'inbox') return { label: 'Inbox', href: '#/inbox' };
  if (conv?.scope.kind === 'work') return { label: `Ask coco · ${work(conv.scope.slug)}`, href: `#/work/${conv.scope.slug}/ask` };
  if (conv?.scope.kind === 'repo') return { label: `Ask coco · ${repoName?.(conv.scope.repoId) || conv.scope.repoId}`, href: `#/repo/${conv.scope.repoId}` };
  if (conv) return { label: 'Ask coco', href: `#/ask/${conv.id}` };
  if (l.work && l.kind === 'review' && l.run) return { label: `Review run · ${work(l.work)}`, href: `#/work/${l.work}/agent-${l.run}` };
  if (l.work && l.kind === 'stack-fix' && l.run) return { label: `Stack fix · ${work(l.work)}`, href: `#/work/${l.work}/stack-${l.run}` };
  if (l.work && l.kind === 'cc-group') return { label: `Thread · ${work(l.work)}`, href: `#/work/${l.work}/${l.group && groupKind?.(l.work, l.group) === 'decision' ? 'decisions' : 'findings'}` };
  if (l.work) return { label: work(l.work), href: `#/work/${l.work}` };
  if (l.repo) return { label: repoName?.(l.repo) || l.repo, href: `#/repo/${l.repo}` };
  return null;
}

type Options = { client: () => Promise<PermissionClient>; locate?: (agent: AgentSnapshot) => Where | null; waitMs?: number; retryMs?: number };

export function createPermissions({ client, locate = () => null, waitMs = WAIT_MS, retryMs = RETRY_MS }: Options) {
  const held = new Map<string, { agent: AgentSnapshot; since: Map<string, string> }>();
  // the latest snapshot of every agent in Paseo's live list
  const live = new Map<string, AgentSnapshot>();
  const listeners = new Set<() => void>();
  const agentListeners = new Set<AgentListener>();
  let booting: Promise<void> | null = null;

  const changed = () => [...listeners].forEach((l) => l());
  const idsOf = (agentId: string) => (held.get(agentId)?.agent.pendingPermissions || []).map((r) => r.id).join(',');
  const isPending = (agentId: string, requestId: string) => Boolean(held.get(agentId)?.agent.pendingPermissions?.some((r) => r.id === requestId));

  function keep(agent: AgentSnapshot) {
    live.set(agent.id, agent);
    const pending = !agent.archivedAt && isCocoAgent(agent) ? agent.pendingPermissions || [] : [];
    if (!pending.length) return held.delete(agent.id);
    const before = held.get(agent.id)?.since;
    held.set(agent.id, { agent, since: new Map(pending.map((r) => [r.id, before?.get(r.id) || new Date().toISOString()])) });
  }
  function apply(update: AgentUpdate) {
    const id = update.kind === 'upsert' ? update.agent.id : update.agentId;
    const before = idsOf(id);
    if (update.kind === 'upsert') keep(update.agent);
    else {
      held.delete(id);
      live.delete(id);
    }
    if (idsOf(id) !== before) changed();
    agentListeners.forEach((l) => (update.kind === 'upsert' ? l(update.agent) : l(null, id)));
  }
  function reset(agents: AgentSnapshot[]) {
    held.clear();
    live.clear();
    agents.forEach(keep);
    changed();
    agentListeners.forEach((l) => l(null));
  }

  // the first page of live agents, most recently updated first, then every change Paseo pushes; a reconnect brings a fresh page
  function boot() {
    booting ||= (async () => {
      const c = await client();
      if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
      const first = await c.agents.list({ subscribe: {}, includeBackground: true, filter: { includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: PAGE } });
      reset(first.entries.map((e) => e.agent));
      first.subscription?.subscribe({
        snapshot: (s) => reset(s.entries.map((e) => e.agent)),
        update: (m) => m.type === 'agent_update' && isRecord(m.payload) && apply(m.payload as AgentUpdate),
        error: () => retry(),
      });
    })().catch(retry);
    return booting;
  }
  function retry(e?: unknown) {
    if (e) console.error(`permissions: ${errorMessage(e)}`);
    booting = null;
    setTimeout(() => void boot(), retryMs).unref();
  }

  function list(): Pending[] {
    return [...held.values()].flatMap(({ agent, since }) => {
      const where = locate(agent);
      const work = agent.labels?.work || null;
      const pr = agent.labels?.pr ? agent.labels.pr.replaceAll('~', ':') : null;
      return (agent.pendingPermissions || []).map((request) => ({ agentId: agent.id, agentTitle: agent.title ?? null, request, since: since.get(request.id) || '', where, work, pr }));
    });
  }

  const gone = (agentId: string, requestId: string) =>
    new Promise<boolean>((resolve) => {
      const check = () => {
        if (isPending(agentId, requestId)) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => (listeners.delete(check), resolve(false)), waitMs);
      listeners.add(check);
      check();
    });

  // resolves once Paseo reports the request answered; Paseo keeps an answer it refuses pending, which reads as an error here
  async function respond(agentId: string, requestId: string, response: PermissionResponse) {
    if (!isPending(agentId, requestId)) throw new HttpError(404, 'this request is no longer pending: answered in Paseo, or the agent moved on');
    const agent = (await client()).agents.ref(agentId);
    if (!agent.respondToPermission) throw new HttpError(501, 'this Paseo client cannot answer permissions');
    const answered = gone(agentId, requestId);
    await agent.respondToPermission({ requestId, response });
    if (!(await answered)) throw new HttpError(502, 'Paseo did not take the answer: the request is still pending');
    return { ok: true };
  }

  function watch(sink: Sink) {
    const write = () => sink.send(JSON.stringify({ pending: list() }));
    write();
    listeners.add(write);
    sink.onClose(() => listeners.delete(write));
  }

  // GET /api/permissions · GET /api/permissions/events (SSE) · POST /api/agents/<agentId>/permissions/<requestId>
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b, c] = parts;
    try {
      if (root === 'permissions' && a === 'events' && req.method === 'GET') return watch(sseSink(req, res));
      if (root === 'permissions' && !a && req.method === 'GET') return send(res, 200, { pending: list() });
      if (root === 'agents' && a && b === 'permissions' && c && req.method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        return send(res, 200, await respond(a, c, parseResponse(body)));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return {
    boot,
    apply,
    reset,
    list,
    agents: () => [...live.values()],
    respond,
    handle,
    watch,
    onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    // every change Paseo pushes on any agent: the agent, or null when it is gone (its id with it) or the whole list was reloaded
    onAgent: (l: AgentListener) => (agentListeners.add(l), () => agentListeners.delete(l)),
  };
}
