// What can be cleaned off the machine: Paseo agents, git worktrees, Paseo workspaces, each with a purge or keep call; nothing goes without an explicit POST.
import fs from 'node:fs';
import path from 'node:path';
import { rowKey, fileKey, keyLabel } from './stack.ts';
import { defaultExec } from './placement.ts';
import { TITLE_PREFIX } from './paseo-agent.ts';
import { isCocoAgent } from './permissions.ts';
import { gitWorktrees, removeWorktree, worktreeState } from './worktrees.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Exec } from './placement.ts';
import type { WorkspaceEntry } from './paseo-agent.ts';
import type { AgentSnapshot, PermissionClient } from './permissions.ts';
import type { RepoConfig } from './config.ts';
import type { PrInfo, ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const AGENT_STALE = 3 * DAY;
const WORKTREE_STALE = 14 * DAY;
const TTL_MS = 30000;
const GH_TTL_MS = 5 * 60 * 1000;
const PARALLEL = 6;
const HELPERS = /^(brief-writer|brief-lessons|review-plan|notion-.+|gate)$/;
const RUNNING = ['running', 'initializing'];
const ORDER: PurgeKind[] = ['agent', 'worktree', 'workspace'];

export type PurgeKind = 'agent' | 'worktree' | 'workspace';
export type Recommendation = 'purge' | 'keep';
export type Verdict = { recommendation: Recommendation; reason: string };
type PrRef = { number: number | null; state: string; label: string; headOid?: string | null };
type WorkRef = { slug: string; title: string; archived: boolean };
export type AgentFacts = { kind: 'agent'; status: string; pending: number; activityAt: string | null; helper: string | null; self: boolean; work: WorkRef | null; pr: PrRef | null };
export type WorktreeFacts = { kind: 'worktree'; main: boolean; self: boolean; dirty: number; unpushed: number; error?: string; liveAgents: number; work: WorkRef | null; pr: PrRef | null; onRemote: boolean | null; activityAt: string | null };
export type WorkspaceFacts = { kind: 'workspace'; dirExists: boolean; agents: number; liveAgents: number; duplicate: boolean };
export type Facts = AgentFacts | WorktreeFacts | WorkspaceFacts;

export type Fact = { text: string; tone?: 'ok' | 'warn' | 'bad' | 'info' };
export type PurgeItem = Verdict & {
  id: string;
  kind: PurgeKind;
  title: string;
  status: string;
  activityAt: string | null;
  where: { repo?: string; work?: { slug: string; title: string }; pr?: string; path?: string };
  facts: Fact[];
  // never acted on, even when forced: coco's own agent and checkout, a main checkout
  locked: boolean;
};
export type PurgeList = { items: PurgeItem[]; at: string; errors: string[] };
export type PurgeResult = { kind: PurgeKind; id: string; ok: boolean; error?: string; note?: string };

type PurgeClient = { agents: { list?: PermissionClient['agents']['list']; ref(id: string): { archive(): Promise<unknown> } }; workspaces: { archive?(id: string): Promise<{ error?: string | null }> } };
type Linked = { agentId: string; slug: string; key: RowKey };
type Deps = {
  APP: string;
  exec?: Exec;
  client: () => Promise<PurgeClient>;
  listWorkspaces: () => Promise<WorkspaceEntry[]>;
  repos: RepoConfig[];
  extraDirs?: () => string[];
  works: { list(): Work[] };
  prInfo: (work: Work, n: number) => Promise<PrInfo | null | undefined>;
  linked?: () => Linked[];
  selfAgentId?: string | null;
  now?: () => number;
  ttlMs?: number;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function ago(ms: number) {
  if (!Number.isFinite(ms)) return 'never';
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}
const since = (at: string | null, now: number) => (at ? now - new Date(at).getTime() : Infinity);
const latest = (...dates: (string | null | undefined)[]) => dates.filter((d): d is string => Boolean(d)).sort().at(-1) || null;
const isDone = (pr: PrRef | null) => pr?.state === 'MERGED' || pr?.state === 'CLOSED';
const prText = (pr: PrRef) => `PR ${pr.label} ${pr.state.toLowerCase()}`;
const samePath = (a?: string | null, b?: string | null) => Boolean(a && b) && path.resolve(a as string) === path.resolve(b as string);
const inside = (dir: string | null | undefined, root: string) => Boolean(dir) && (samePath(dir, root) || path.resolve(dir as string).startsWith(path.resolve(root) + path.sep));

// one rule set for all three kinds: keep wins until a reason to purge is found
export function recommend(f: Facts, now = Date.now()): Verdict {
  const keep = (reason: string): Verdict => ({ recommendation: 'keep', reason });
  const purge = (reason: string): Verdict => ({ recommendation: 'purge', reason });
  if (f.kind === 'agent') {
    const idle = since(f.activityAt, now);
    if (f.self) return keep('coco runs inside this agent');
    if (RUNNING.includes(f.status)) return keep('running');
    if (f.pending) return keep(`waiting on you: ${plural(f.pending, 'request')}`);
    if (f.helper && idle > HOUR) return purge(`one-shot ${f.helper} helper, done ${ago(idle)} ago`);
    if (idle < DAY) return keep(`active ${ago(idle)} ago`);
    if (f.work?.archived) return purge(`its work “${f.work.title}” is archived`);
    if (f.pr && isDone(f.pr)) return purge(prText(f.pr));
    if (f.status === 'closed') return purge(`session closed, last active ${ago(idle)} ago`);
    if (idle > AGENT_STALE) return purge(`${f.status} for ${ago(idle)}`);
    return keep(`${f.status} ${ago(idle)}, recent`);
  }
  if (f.kind === 'worktree') {
    const idle = since(f.activityAt, now);
    if (f.main) return keep('main checkout');
    if (f.self) return keep('coco runs from here');
    if (f.error) return keep(`git state unreadable: ${f.error}`);
    if (f.dirty) return keep(plural(f.dirty, 'uncommitted file'));
    if (f.unpushed) return keep(plural(f.unpushed, 'unpushed commit'));
    if (f.liveAgents) return keep(`${plural(f.liveAgents, 'live agent')} here`);
    if (f.work && !f.work.archived && !isDone(f.pr)) return keep(f.pr?.state === 'OPEN' ? `PR ${f.pr.label} open in “${f.work.title}”` : `row of “${f.work.title}”`);
    if (f.pr && isDone(f.pr)) return purge(prText(f.pr));
    if (f.work?.archived) return purge(`its work “${f.work.title}” is archived`);
    if (f.pr?.state === 'OPEN') return keep(`PR ${f.pr.label} open`);
    if (idle < DAY) return keep(`active ${ago(idle)} ago`);
    if (f.onRemote === false && !f.pr) return purge('branch gone from origin, no PR, nothing unpushed');
    if (idle >= WORKTREE_STALE) return purge(`no activity for ${ago(idle)}, in no live work`);
    return keep(`last active ${ago(idle)} ago`);
  }
  const along = f.agents ? `; its ${plural(f.agents, 'agent')} ${f.agents === 1 ? 'is' : 'are'} up for purge too` : '';
  if (f.liveAgents) return keep(plural(f.liveAgents, 'live agent'));
  if (!f.dirExists) return purge(`its folder is gone${along}`);
  if (f.duplicate) return purge(`another workspace covers this folder${along}`);
  return keep(f.agents ? plural(f.agents, 'agent') : 'the only workspace on this folder');
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

type Act = () => Promise<string | void>;
type Scan = PurgeList & { acts: Map<string, Act> };
type Tree = { path: string; branch: string; main: boolean; repo: { name: string; path: string; github: string | null } };
const keyOf = (kind: PurgeKind, id: string) => `${kind}:${id}`;

export function createPurge({ APP, exec = defaultExec, client, listWorkspaces, repos, extraDirs = () => [], works, prInfo, linked = () => [], selfAgentId = null, now = Date.now, ttlMs = TTL_MS }: Deps) {
  let cached: { at: number; scan: Promise<Scan> } | null = null;
  const ghCache = new Map<string, { at: number; pr: Promise<PrRef | null> }>();

  async function listAgents(c: PurgeClient) {
    if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
    const out: AgentSnapshot[] = [];
    for (let cursor: string | null | undefined, pages = 0; pages < 10; pages++) {
      const page = await c.agents.list({ includeBackground: true, filter: { includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: 200, ...(cursor ? { cursor } : {}) } });
      out.push(...page.entries.map((e) => e.agent));
      cursor = page.pageInfo?.nextCursor;
      if (!cursor) break;
    }
    return out.filter((a) => !a.archivedAt);
  }

  async function allTrees(): Promise<Tree[]> {
    const seen = new Set<string>();
    const out: Tree[] = [];
    const add = (trees: { path: string; branch: string }[], repo: Tree['repo']) =>
      trees.forEach((t, i) => {
        const p = path.resolve(t.path);
        if (seen.has(p)) return;
        seen.add(p);
        out.push({ ...t, path: p, main: i === 0, repo });
      });
    for (const r of repos) if (r.path) add(await gitWorktrees(exec, r.path), { name: r.name, path: r.path, github: r.github || null });
    for (const dir of extraDirs()) {
      if (seen.has(path.resolve(dir))) continue;
      const trees = await gitWorktrees(exec, dir);
      if (trees.length) add(trees, { name: path.basename(trees[0].path), path: trees[0].path, github: null });
    }
    return out;
  }

  const remoteBranches = async (repoPath: string) => {
    const r = await exec('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes']);
    return r.ok ? new Set(r.stdout.split('\n').filter(Boolean)) : null;
  };

  function prOfBranch(github: string, branch: string): Promise<PrRef | null> {
    const key = `${github}#${branch}`;
    const hit = ghCache.get(key);
    if (hit && now() - hit.at < GH_TTL_MS) return hit.pr;
    const pr = exec('gh', ['pr', 'list', '--repo', github, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state,headRefOid']).then((r) => {
      if (!r.ok) throw new Error(r.stderr.trim().slice(0, 200));
      const [found] = JSON.parse(r.stdout || '[]') as { number: number; state: string; headRefOid?: string }[];
      return found ? { number: found.number, state: found.state, label: `#${found.number}`, headOid: found.headRefOid || null } : null;
    });
    ghCache.set(key, { at: now(), pr });
    pr.catch(() => ghCache.delete(key));
    return pr;
  }

  async function lastActivity(dir: string) {
    const [log, ref] = await Promise.all([exec('git', ['-C', dir, 'log', '-1', '--format=%cI']), exec('git', ['-C', dir, 'rev-parse', '--git-path', 'logs/HEAD'])]);
    const reflog = ref.ok ? fs.statSync(path.resolve(dir, ref.stdout.trim()), { throwIfNoEntry: false })?.mtime.toISOString() : null;
    return latest(log.ok ? new Date(log.stdout.trim()).toISOString() : null, reflog);
  }

  async function scan(): Promise<Scan> {
    const errors: string[] = [];
    const fail = (what: string) => (e: unknown) => {
      errors.push(`${what}: ${errorMessage(e)}`);
      return [];
    };
    const at = now();
    const [agents, spaces, trees] = await Promise.all([
      client().then(listAgents).catch(fail('Paseo agents')),
      listWorkspaces().then((l) => l.filter((w) => !w.archivingAt)).catch(fail('Paseo workspaces')),
      allTrees().catch(fail('git worktrees')),
    ]);

    // every stack row's branch and PR, live works last so they win a shared branch
    const workRef = (w: Work): WorkRef => ({ slug: w.slug, title: w.title, archived: Boolean(w.archived) });
    const byBranch = new Map<string, { work: WorkRef; pr: PrRef | null }>();
    const byKey = new Map<string, { work: WorkRef; pr: PrRef | null }>();
    const allWorks = works.list().sort((a, b) => Number(Boolean(b.archived)) - Number(Boolean(a.archived)));
    const rows = allWorks.flatMap((w) => (w.stack || []).map((row) => ({ w, row })));
    const infos = await pool(rows, PARALLEL, ({ w, row }) => (row.number ? prInfo(w, row.number).catch(() => null) : Promise.resolve(null)));
    rows.forEach(({ w, row }, i) => {
      const info = infos[i];
      const key = rowKey(row);
      const pr: PrRef | null = row.number && info?.state && !info.error ? { number: row.number, state: info.state, label: `#${row.number}`, headOid: info.headOid || null } : null;
      const entry = { work: workRef(w), pr };
      const branch = row.planned?.branch || info?.head;
      if (branch) byBranch.set(branch, entry);
      if (key !== null) byKey.set(`${w.slug}|${fileKey(key)}`, entry);
    });

    const remotes = new Map(await Promise.all([...new Set(trees.map((t) => t.repo.path))].map(async (p) => [p, await remoteBranches(p)] as const)));
    const self = (dir: string) => inside(APP, dir) || inside(process.cwd(), dir);
    const treeBase = await pool(trees, PARALLEL, async (t) => {
      const row = t.branch ? byBranch.get(t.branch) : undefined;
      let pr = row?.pr || null;
      if (!pr && !t.main && t.branch && t.repo.github) pr = await prOfBranch(t.repo.github, t.branch).catch(() => null);
      const [state, activityAt] = t.main ? [{ dirty: 0, unpushed: 0 }, null] : await Promise.all([worktreeState(exec, t.path, pr?.headOid), lastActivity(t.path)]);
      const remote = remotes.get(t.repo.path);
      return { t, work: row?.work || null, pr, state, activityAt, onRemote: t.main || !t.branch || !remote ? null : remote.has(t.branch) };
    });
    const treeOf = (dir: string | null | undefined) => treeBase.filter((b) => !b.t.main && inside(dir, b.t.path)).sort((x, y) => y.t.path.length - x.t.path.length)[0];

    const workBySlug = new Map(allWorks.map((w) => [w.slug, w]));
    const links = new Map(linked().map((l) => [l.agentId, l]));
    const spaceDir = new Map(spaces.map((w) => [w.id, w.workspaceDirectory || null]));
    const items: PurgeItem[] = [];
    const acts = new Map<string, Act>();
    const verdicts = new Map<string, Verdict>();

    for (const a of agents) {
      const l = a.labels || {};
      const link = links.get(a.id);
      const slug = l.work || link?.slug;
      const w = slug ? workBySlug.get(slug) : undefined;
      const prKey = l.pr || (link ? fileKey(link.key) : undefined);
      const row = slug && prKey ? byKey.get(`${slug}|${prKey}`) : undefined;
      const dir = a.cwd || (a.workspaceId ? spaceDir.get(a.workspaceId) : null) || null;
      const tree = treeOf(dir);
      const pr = row?.pr || tree?.pr || null;
      const status = a.status || 'unknown';
      const pending = (a.pendingPermissions || []).length;
      const activityAt = latest(a.updatedAt, a.lastUserMessageAt, a.createdAt);
      const kind = l.kind || null;
      const isSelf = Boolean(selfAgentId) && a.id === selfAgentId;
      const facts: AgentFacts = { kind: 'agent', status, pending, activityAt, helper: kind && HELPERS.test(kind) && isCocoAgent(a) ? kind : null, self: isSelf, work: w ? workRef(w) : null, pr };
      const v = recommend(facts, at);
      verdicts.set(a.id, v);
      const shown: Fact[] = [
        { text: pending ? 'waiting on you' : status, tone: pending ? 'warn' : RUNNING.includes(status) ? 'info' : status === 'error' ? 'bad' : undefined },
        { text: activityAt ? `${ago(since(activityAt, at))} ago` : 'no activity' },
        ...(isCocoAgent(a) ? [{ text: kind ? `coco · ${kind}` : 'coco' }] : []),
        ...(pr ? [{ text: prText(pr), tone: (pr.state === 'MERGED' ? 'ok' : pr.state === 'CLOSED' ? 'bad' : 'info') as Fact['tone'] }] : []),
        ...(w?.archived ? [{ text: 'work archived' }] : []),
      ];
      items.push({ id: a.id, kind: 'agent', title: (a.title || '').replace(TITLE_PREFIX, '').trim() || a.id.slice(0, 8), status: pending ? 'waiting' : status, activityAt, where: { ...(tree ? { repo: tree.t.repo.name } : {}), ...(w ? { work: { slug: w.slug, title: w.title } } : {}), ...(pr ? { pr: pr.label } : prKey ? { pr: keyLabel(String(prKey).replaceAll('~', ':')) } : {}), ...(dir ? { path: dir } : {}) }, facts: shown, locked: isSelf, ...v });
      acts.set(keyOf('agent', a.id), async () => void (await (await client()).agents.ref(a.id).archive()));
    }

    const live = (a: AgentSnapshot) => verdicts.get(a.id)?.recommendation === 'keep';
    const agentDir = (a: AgentSnapshot) => a.cwd || (a.workspaceId ? spaceDir.get(a.workspaceId) : null) || null;
    for (const b of treeBase) {
      const { t, state } = b;
      const isSelf = self(t.path);
      const liveAgents = agents.filter((a) => live(a) && treeOf(agentDir(a))?.t.path === t.path).length;
      const facts: WorktreeFacts = { kind: 'worktree', main: t.main, self: isSelf, ...state, liveAgents, work: b.work, pr: b.pr, onRemote: b.onRemote, activityAt: b.activityAt };
      const v = recommend(facts, at);
      const ids = spaces.filter((w) => samePath(w.workspaceDirectory, t.path)).map((w) => w.id);
      const shown: Fact[] = [
        { text: t.branch || 'detached' },
        ...(state.dirty ? [{ text: `${plural(state.dirty, 'uncommitted file')}`, tone: 'warn' as const }] : []),
        ...(state.unpushed ? [{ text: `${plural(state.unpushed, 'unpushed commit')}`, tone: 'warn' as const }] : []),
        ...(b.pr ? [{ text: prText(b.pr), tone: (b.pr.state === 'MERGED' ? 'ok' : b.pr.state === 'CLOSED' ? 'bad' : 'info') as Fact['tone'] }] : []),
        ...(b.onRemote === false ? [{ text: 'not on any remote' }] : []),
        ...(liveAgents ? [{ text: plural(liveAgents, 'live agent'), tone: 'info' as const }] : []),
        ...(b.activityAt ? [{ text: `${ago(since(b.activityAt, at))} ago` }] : []),
        ...(ids.length ? [{ text: plural(ids.length, 'workspace') }] : []),
      ];
      items.push({ id: t.path, kind: 'worktree', title: t.main ? `${t.repo.name} (main checkout)` : path.basename(t.path), status: t.main ? 'main' : state.dirty || state.unpushed ? 'dirty' : 'clean', activityAt: b.activityAt, where: { repo: t.repo.name, ...(b.work ? { work: { slug: b.work.slug, title: b.work.title } } : {}), ...(b.pr ? { pr: b.pr.label } : {}), path: t.path }, facts: shown, locked: t.main || isSelf, ...v });
      if (!t.main && !isSelf) acts.set(keyOf('worktree', t.path), async () => {
        const r = await removeWorktree(exec, t.repo.path, t.path, ids);
        if (!r.ok) throw new Error(r.why);
        return r.unarchived.length ? `workspaces left: ${r.unarchived.map((u) => `${u.workspaceId} (${u.why})`).join(', ')}` : undefined;
      });
    }

    // on a folder several workspaces share, the one with live agents (else the latest active) stays; the others are duplicates
    const folders = new Map<string, WorkspaceEntry[]>();
    for (const w of spaces) if (w.workspaceDirectory) folders.set(path.resolve(w.workspaceDirectory), [...(folders.get(path.resolve(w.workspaceDirectory)) || []), w]);
    const mine = (w: WorkspaceEntry) => agents.filter((a) => a.workspaceId === w.id);
    const activity = (w: WorkspaceEntry) => latest(w.activityAt, w.lastUserMessageAt, w.createdAt, ...mine(w).map((a) => a.updatedAt));
    const keeper = new Map([...folders].map(([dir, list]) => [dir, [...list].sort((x, y) => mine(y).filter(live).length - mine(x).filter(live).length || (activity(y) || '').localeCompare(activity(x) || ''))[0].id]));
    for (const w of spaces) {
      const dir = w.workspaceDirectory ? path.resolve(w.workspaceDirectory) : null;
      const own = mine(w);
      const liveAgents = own.filter(live).length;
      const dirExists = Boolean(dir && fs.existsSync(dir));
      const copies = dir ? (folders.get(dir) || []).length : 1;
      const facts: WorkspaceFacts = { kind: 'workspace', dirExists, agents: own.length - liveAgents, liveAgents, duplicate: Boolean(dir) && keeper.get(dir as string) !== w.id };
      const v = recommend(facts, at);
      const activityAt = activity(w);
      const tree = treeOf(dir);
      const shown: Fact[] = [
        { text: own.length ? plural(own.length, 'agent') : 'no agent' },
        ...(liveAgents ? [{ text: `${liveAgents} live`, tone: 'info' as const }] : []),
        ...(!dirExists ? [{ text: 'folder gone', tone: 'bad' as const }] : []),
        ...(copies > 1 ? [{ text: `×${copies} on this folder` }] : []),
        ...(activityAt ? [{ text: `${ago(since(activityAt, at))} ago` }] : []),
      ];
      items.push({ id: w.id, kind: 'workspace', title: w.title || w.name || w.id, status: liveAgents ? 'live' : dirExists ? 'idle' : 'gone', activityAt, where: { ...(w.projectDisplayName ? { repo: w.projectDisplayName } : tree ? { repo: tree.t.repo.name } : {}), ...(dir ? { path: dir } : {}) }, facts: shown, locked: false, ...v });
      acts.set(keyOf('workspace', w.id), async () => {
        const c = await client();
        if (!c.workspaces.archive) throw new Error('this Paseo client cannot archive workspaces');
        const r = await c.workspaces.archive(w.id);
        if (r?.error) throw new Error(r.error);
      });
    }

    const rank = (i: PurgeItem) => (i.recommendation === 'purge' ? 0 : 1);
    items.sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || rank(x) - rank(y) || (y.activityAt || '').localeCompare(x.activityAt || ''));
    return { items, at: new Date(at).toISOString(), errors, acts };
  }

  function list(fresh = false) {
    if (fresh || !cached || now() - cached.at >= ttlMs) {
      if (fresh) ghCache.clear();
      const next = { at: now(), scan: scan() };
      next.scan.catch(() => cached === next && (cached = null));
      cached = next;
    }
    return cached.scan;
  }

  // re-checked on fresh data first: an item now kept is refused unless forced, a locked one always; agents go before worktrees before workspaces
  async function perform(asked: { kind: PurgeKind; id: string; force?: boolean }[]): Promise<PurgeResult[]> {
    const { items, acts } = await list(true);
    const out: PurgeResult[] = [];
    for (const q of [...asked].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind))) {
      const item = items.find((i) => i.kind === q.kind && i.id === q.id);
      const act = acts.get(keyOf(q.kind, q.id));
      if (!item || !act) {
        out.push({ kind: q.kind, id: q.id, ok: false, error: item?.locked ? `never purged: ${item.reason}` : 'no longer listed' });
        continue;
      }
      if (item.locked) {
        out.push({ kind: q.kind, id: q.id, ok: false, error: `never purged: ${item.reason}` });
        continue;
      }
      if (item.recommendation === 'keep' && !q.force) {
        out.push({ kind: q.kind, id: q.id, ok: false, error: `now recommended to keep: ${item.reason}` });
        continue;
      }
      try {
        const note = await act();
        out.push({ kind: q.kind, id: q.id, ok: true, ...(note ? { note } : {}) });
      } catch (e) {
        out.push({ kind: q.kind, id: q.id, ok: false, error: errorMessage(e) });
      }
    }
    cached = null;
    return out;
  }

  const parseItems = (body: unknown) => {
    const raw = typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items) ? body.items : null;
    if (!raw?.length) throw new HttpError(400, 'items required: [{ kind, id }]');
    return raw.map((x: unknown) => {
      const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
      if (!ORDER.includes(o.kind as PurgeKind) || typeof o.id !== 'string' || !o.id) throw new HttpError(400, 'each item needs a kind (agent, worktree, workspace) and an id');
      return { kind: o.kind as PurgeKind, id: o.id, force: o.force === true };
    });
  };

  // GET /api/purge[?refresh=1] · POST /api/purge { items: [{ kind, id, force? }] }
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      if (parts.length > 1) return send(res, 404, { error: 'no route' });
      if (req.method === 'GET') {
        const fresh = new URL(req.url || '/', 'http://local').searchParams.has('refresh');
        const { items, at, errors } = await list(fresh);
        return send(res, 200, { items, at, errors });
      }
      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        return send(res, 200, { results: await perform(parseItems(body)) });
      }
      return send(res, 405, { error: 'GET or POST' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { list, perform, handle };
}
