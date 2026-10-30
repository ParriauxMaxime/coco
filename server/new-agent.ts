// New agent: an agent the owner starts from coco as Paseo's own new-agent screen does (a message with files, a model, thinking and mode),
// in a repo's clone, a work's Plan workspace, one of its PR worktrees or a fresh worktree off the default branch; one on a work gets its brief.
import { randomUUID } from 'node:crypto';
import { fileKey, keyLabel, parseKey, rowKey } from './stack.ts';
import { firstMessage, workFacts } from './dispatch.ts';
import { renderBrief } from './briefs.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { FILES_ONLY, agentInput, uploadRef } from './uploads.ts';
import { startThinking } from './models.ts';
import type { Upload, Uploads } from './uploads.ts';
import type { Config, RepoConfig } from './config.ts';
import type { PrInfo, ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';
import type { Models } from './models.ts';
import type { Readier } from './review-agent.ts';
import type { Placed, Scope } from './placement.ts';

export type Place = { kind: 'repo'; repoId: string } | { kind: 'fresh'; repoId: string } | { kind: 'work'; slug: string } | { kind: 'row'; slug: string; key: RowKey };
export type NewAgentInput = { place?: unknown; prompt?: unknown; attachments?: unknown; provider?: unknown; thinking?: unknown; mode?: unknown };

type BriefContext = Parameters<typeof renderBrief>[0];
type Deps = {
  config: Pick<Config, 'repos' | 'models' | 'baseUrl'>;
  works: { get(slug: string): Work | null; list(): Work[] };
  placement: { place(scope: Scope): Promise<Placed>; freshWorkspace(repoId: string, opts: { branch: string; title: string }): Promise<Placed>; appRepoId(): string | null };
  agents: { start(opts: Record<string, unknown>): Promise<{ agentId: string; workspaceId?: string | null }> };
  briefs: { context(slug: string, raw: string): Promise<BriefContext> };
  prInfo?: (work: Work, n: number) => Promise<PrInfo | null>;
  models?: Pick<Models, 'check' | 'mode'>;
  uploads?: Pick<Uploads, 'resolve' | 'record'>;
  link?: { linkAgent(a: { agentId: string; workspaceId?: string | null; cwd?: string | null; title?: string | null }): Promise<unknown>; briefed(agentId: string): unknown };
  readier?: Readier;
};

const PROMPT_MAX = 20000;
const TITLE_MAX = 60;
const ENDED = ['MERGED', 'CLOSED'];

// the workflow of coco's own checkout, put in the composer for the owner to keep, edit or delete
export const APP_NOTE = [
  'This is coco\'s own checkout. When the change is done: commit it on main (one descriptive sentence, no push),',
  'restart coco with the cocopilot restart_coco tool (it waits until coco is back), then check the UI with the cocopilot screenshot tool before you report.',
].join(' ');

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').split('-').filter(Boolean).slice(0, 4).join('-').slice(0, 30) || 'agent';
export const freshBranch = (prompt: string) => `agent/${slugOf(prompt.split('\n')[0])}-${randomUUID().slice(0, 4)}`;

export function createNewAgent({ config, works, placement, agents, briefs, prInfo, models, uploads, link, readier }: Deps) {
  const repoOf = (id: unknown): RepoConfig | null => config.repos.find((r) => r.id === id) || null;

  // the place as sent, checked against the repos and live works
  function placeOf(raw: unknown): Place {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if ((p.kind === 'repo' || p.kind === 'fresh') && repoOf(p.repoId)) return { kind: p.kind, repoId: String(p.repoId) };
    const work = typeof p.slug === 'string' ? works.get(p.slug) : null;
    if ((p.kind === 'work' || p.kind === 'row') && work && !work.archived) {
      if (p.kind === 'work') return { kind: 'work', slug: work.slug };
      const key = parseKey(p.key);
      if (key !== null && (work.stack || []).some((s) => rowKey(s) === key)) return { kind: 'row', slug: work.slug, key };
      throw new HttpError(400, `unknown place: ${p.key == null ? 'no PR' : String(p.key)} is not in ${work.slug}`);
    }
    throw new HttpError(400, `unknown place ${JSON.stringify(raw ?? null).slice(0, 120)}`);
  }

  function check(input: NewAgentInput) {
    const place = placeOf(input.place);
    const files: Upload[] = uploads?.resolve(input.attachments) ?? [];
    const prompt = (typeof input.prompt === 'string' ? input.prompt.trim().slice(0, PROMPT_MAX) : '') || (files.length ? FILES_ONLY : '');
    if (!prompt) throw new HttpError(400, 'a new agent needs a message');
    return { place, files, prompt };
  }

  const where = async (place: Place, title: string, prompt: string) =>
    place.kind === 'fresh'
      ? placement.freshWorkspace(place.repoId, { branch: freshBranch(prompt), title })
      : placement.place(place.kind === 'row' ? { kind: 'row', slug: place.slug, key: place.key, edits: true } : place);

  // a work's facts, or the PR's brief naming the worktree the agent runs in
  async function briefOf(place: Place, cwd: string) {
    if (place.kind === 'repo' || place.kind === 'fresh') return null;
    const work = works.get(place.slug);
    if (!work) return null;
    if (place.kind === 'work') return workFacts(work);
    try {
      return renderBrief({ ...(await briefs.context(work.slug, String(place.key))), worktree: cwd });
    } catch (e) {
      return `${workFacts(work)}\n\n(The PR brief could not be rendered: ${errorMessage(e).slice(0, 200)}. Use the cocopilot MCP get_work ${work.slug}.)`;
    }
  }

  async function start(input: NewAgentInput) {
    const { place, files, prompt } = check(input);
    const fallback = config.models.default;
    const pick = models ? await models.check({ provider: input.provider, thinking: input.thinking }, fallback) : {};
    const provider = pick.provider || fallback;
    const mode = models ? await models.mode(provider, input.mode) : undefined;
    const title = prompt.split('\n')[0].slice(0, TITLE_MAX);
    const placed = await where(place, title, prompt);
    const edits = place.kind === 'row' || place.kind === 'fresh';
    const setup = edits && readier ? await readier.ready(placed.cwd).catch(() => []) : [];
    const message = [firstMessage({ title: null, task: prompt, edits: true, brief: await briefOf(place, placed.cwd) }), ...(setup.length ? ['', ...setup] : [])].join('\n');
    const messageId = files.length ? randomUUID() : null;
    const slug = place.kind === 'work' || place.kind === 'row' ? place.slug : null;
    const key = place.kind === 'row' ? place.key : null;
    const labels = { source: 'cocopilot', kind: 'agent', ...(slug ? { work: slug } : {}), ...(key === null ? {} : { pr: fileKey(key) }) };
    const thinking = pick.thinking || startThinking(config.models, provider);
    const started = await agents.start({ title, provider, ...(thinking ? { thinking } : {}), ...(mode ? { mode } : {}), prompt: message, ...(messageId ? { input: { ...agentInput(files), messageId } } : {}), labels, workspaceId: placed.workspaceId, cwd: placed.cwd });
    if (messageId) uploads?.record(started.agentId, { messageId, text: message, at: new Date().toISOString(), attachments: files.map(uploadRef) });
    if (edits) readier?.started(started.agentId, placed.cwd, { slug: slug ?? undefined, key });
    if (key !== null && link) {
      await link.linkAgent({ agentId: started.agentId, workspaceId: placed.workspaceId, cwd: placed.cwd, title }).catch(() => null);
      link.briefed(started.agentId);
    }
    return { agentId: started.agentId, workspaceId: placed.workspaceId, cwd: placed.cwd, title };
  }

  // where a new agent can run: each repo's clone and a fresh worktree off its default branch, each live work's Plan, and with ?work its open PRs
  async function places(slug: string | null) {
    const app = placement.appRepoId();
    const live = works.list().filter((w) => !w.archived);
    const work = slug ? live.find((w) => w.slug === slug) : null;
    const rows = work
      ? (await Promise.all((work.stack || []).map(async (s) => {
          const key = rowKey(s);
          if (key === null || s.landed) return [];
          const pr = s.number && prInfo ? await prInfo(work, s.number).catch(() => null) : null;
          return pr?.state && ENDED.includes(pr.state) ? [] : [{ key: String(key), label: keyLabel(key), title: pr?.title || s.planned?.title || '' }];
        }))).flat()
      : [];
    return {
      app,
      appNote: APP_NOTE,
      repos: config.repos.map((r) => ({ id: r.id, name: r.name, defaultBranch: r.defaultBranch, app: r.id === app })),
      works: live.map((w) => ({ slug: w.slug, title: w.title, repo: w.repo || config.repos[0]?.id || null })),
      rows,
    };
  }

  // GET /api/new-agent[?work=<slug>] · POST /api/new-agent
  async function handle(req: Req, res: Res, _parts: string[], readBody: ReadBody, send: Send) {
    try {
      if (req.method === 'GET') return send(res, 200, await places(new URL(req.url || '/', 'http://local').searchParams.get('work')));
      if (req.method !== 'POST') return send(res, 404, { error: 'no route' });
      let body: NewAgentInput;
      try {
        body = JSON.parse((await readBody(req)) || '{}') || {};
      } catch {
        throw new HttpError(400, 'invalid JSON body');
      }
      return send(res, 200, await start(body));
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { check, start, places, handle };
}
