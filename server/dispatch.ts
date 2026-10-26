// Dispatch: start a catalog agent (ask, persona review, fix findings, a gate run) or a free prompt on a work or one of its PRs.
// Placement decides where: read-only kinds in the work's Plan workspace, editing kinds in the PR row's own workspace.
import { fileKey, isLocal, keyLabel, parseKey, rowKey } from './stack.ts';
import { gatesFor, skillName } from './gates.ts';
import { repoSetting } from './config.ts';
import { renderBrief } from './briefs.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { Config, RepoConfig } from './config.ts';
import type { ReadBody, Req, Res, RowKey, Send, Work } from './core-types.ts';

export type DispatchKind = 'ask' | 'persona-review' | 'fix-findings' | 'gate' | 'prompt';
export type CatalogEntry = { id: string; kind: DispatchKind; label: string; edits: boolean; needsPr: boolean; needsPrompt?: boolean; needsPersona?: boolean; gate?: string; skill?: string; ask?: string };
export type DispatchInput = { entry?: unknown; key?: unknown; prompt?: unknown; persona?: unknown; args?: unknown; edits?: unknown; commentIds?: unknown };
export type Dispatched = { kind: DispatchKind; title: string; agentId: string | null; workspaceId?: string | null; edits: boolean; runId?: string };

type Placed = { workspaceId: string; cwd: string };
type Scope = { kind: 'work'; slug: string } | { kind: 'row'; slug: string; key: RowKey; edits: boolean };
type BriefContext = Parameters<typeof renderBrief>[0] & { pr: { head: string; base: string; title?: string } };
type Deps = {
  config: Config;
  works: { get(slug: string): Work | null; save(w: Work, opts?: { touch?: boolean }): unknown };
  placement: { place(scope: Scope): Promise<Placed> };
  agents: { start(opts: Record<string, unknown>): Promise<{ agentId: string; workspaceId?: string | null }> };
  briefs: { context(slug: string, raw: string): Promise<BriefContext> };
  reviewAgent: { start(slug: string, key: unknown, input: { commentIds: string[]; wrap?: (prompt: string) => string }): Promise<{ runId: string; agentId: string }>; timeline(slug: string, kind: string, text: string): void };
  comments: { list(slug: string, n: RowKey): { comments?: { id: string; status?: string }[] } };
  repoOf?: (work: Work) => RepoConfig | null | undefined;
};

const PROMPT_MAX = 8000;
const TITLE_TASK = 40;

// what can be dispatched for a repo: the fixed kinds, then one gate run per gate skill, manual test always
export function catalog(config: Config, repo?: RepoConfig | null): CatalogEntry[] {
  const gateSkills = repoSetting(config, repo, 'gateSkills');
  const gates = gatesFor({ ...config, gateSkills, kitKinds: repoSetting(config, repo, 'kitKinds') });
  const runs = gates.flatMap((g) => (g.skills || []).map((s): CatalogEntry => {
    const name = skillName(s) || '';
    return { id: `gate:${g.id}:${name}`, kind: 'gate', label: `${g.label}: /${name}`, edits: true, needsPr: true, gate: g.id, skill: name, ...(typeof s === 'object' && s.ask ? { ask: s.ask } : {}) };
  }));
  const manual = skillName(gateSkills['manual-test']?.[0]);
  return [
    { id: 'ask', kind: 'ask', label: 'Ask on this PR', edits: false, needsPr: true, needsPrompt: true },
    { id: 'persona-review', kind: 'persona-review', label: 'Persona review', edits: false, needsPr: true, needsPersona: true },
    { id: 'fix-findings', kind: 'fix-findings', label: 'Fix findings', edits: true, needsPr: true },
    ...runs,
    { id: 'gate:manual-test', kind: 'gate', label: `manual test${manual ? `: /${manual}` : ''}`, edits: true, needsPr: true, gate: 'manual-test', ...(manual ? { skill: manual } : {}) },
    { id: 'prompt', kind: 'prompt', label: 'Free prompt', edits: false, needsPr: false, needsPrompt: true },
  ];
}

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{([\w|]+)\}/g, (_, keys: string) => keys.split('|').map((k) => vars[k]?.trim()).find(Boolean) || '');

// the dispatched agent's first message: its task, then the template brief of the PR as context (slice 7 replaces this with the brief writer)
export function firstMessage({ title, task, edits, brief, read }: { title: string; task: string; edits: boolean; brief: string | null; read?: { head: string; base: string; n: RowKey } | null }) {
  const readOnly = !edits && read
    ? [`Read-only: do not edit files, commit or push. The PR's branch is not checked out here: \`git fetch origin\`, then read the change with \`git diff ${read.base}...${read.head}\`${isLocal(read.n) ? '' : ` or \`gh pr diff ${read.n}\``}.`, '']
    : !edits ? ['Read-only: do not edit files, commit or push.', ''] : [];
  return [`# ${title}`, '', task.trim(), '', ...readOnly, ...(brief ? ['---', '', 'The brief below is context about the work and the PR; your task is the one above.', '', brief] : [])].join('\n').trimEnd();
}

export function createDispatch({ config, works, placement, agents, briefs, reviewAgent, comments, repoOf }: Deps) {
  const repoFor = (work: Work) => repoOf?.(work) || null;
  const entriesFor = (work: Work) => catalog(config, repoFor(work));

  function resolve(slug: string, input: DispatchInput) {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const entry = entriesFor(work).find((e) => e.id === input.entry);
    if (!entry) throw new HttpError(400, `unknown dispatch ${String(input.entry ?? '')}`);
    const key = input.key == null || input.key === '' ? null : parseKey(input.key);
    if (input.key != null && input.key !== '' && key === null) throw new HttpError(400, 'bad pr number or branch key');
    const index = key === null ? -1 : (work.stack || []).findIndex((s) => rowKey(s) === key);
    if (key !== null && index < 0) throw new HttpError(404, `${keyLabel(key)} is not in this work`);
    if (entry.needsPr && key === null) throw new HttpError(400, `${entry.label} needs a PR`);
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, PROMPT_MAX) : '';
    if (entry.needsPrompt && !prompt) throw new HttpError(400, `${entry.label} needs a prompt`);
    const persona = typeof input.persona === 'string' ? input.persona.trim() : '';
    if (entry.needsPersona && !/^[\w.-]+$/.test(persona)) throw new HttpError(400, 'persona review needs a persona login');
    const edits = entry.kind === 'prompt' ? key !== null && input.edits === true : entry.edits;
    return { work, entry, key, index, prompt, persona, edits };
  }

  function taskOf(entry: CatalogEntry, key: RowKey | null, { prompt, persona, args }: { prompt: string; persona: string; args: string }) {
    const pr = key === null ? '' : isLocal(key) ? '' : String(key);
    if (entry.kind === 'persona-review') {
      const ritual = config.rituals.find((r) => r.kind === 'review-as' && r.prompt);
      return ritual?.prompt ? fill(ritual.prompt, { login: persona, pr, owner: config.owner.name }).trim() :`Review this PR as ${persona} would: read \`${persona}.md\` in ${config.personasDir} ("What they check"), then report each finding with its file, line, severity and confidence.`;
    }
    if (entry.kind === 'gate') {
      if (!entry.skill) return `Test this PR by hand: run it locally, exercise every surface it changes, and report pass or fail per scenario with what you saw.${prompt ? `\n\n${prompt}` : ''}`;
      return `/${entry.skill} ${args || pr}`.trim() + (prompt ? `\n\n${prompt}` : '');
    }
    return prompt;
  }

  // a tab in the PR's own workspace needs no PR in its title; one in the shared Plan workspace does
  const titleOf = (entry: CatalogEntry, key: RowKey | null, edits: boolean, { prompt, persona }: { prompt: string; persona: string }) => {
    const detail = entry.kind === 'persona-review' ? persona : entry.kind === 'ask' || entry.kind === 'prompt' ? prompt.split('\n')[0].slice(0, TITLE_TASK) : '';
    return [entry.label.replace(/ on this PR$/, ''), detail, key === null || edits ? '' : keyLabel(key)].filter(Boolean).join(' · ');
  };

  async function briefOf(slug: string, key: RowKey | null) {
    if (key === null) return { brief: null, read: null };
    try {
      const ctx = await briefs.context(slug, String(key));
      return { brief: renderBrief(ctx), read: { head: ctx.pr.head, base: ctx.pr.base, n: key } };
    } catch (e) {
      return { brief: `(The PR brief could not be rendered: ${errorMessage(e).slice(0, 200)}. Use the cocopilot MCP get_work ${slug}.)`, read: null };
    }
  }

  const markGate = (slug: string, key: RowKey, gate: string, record: { state: string; at: string; skill: string; agentId: string | null }) => {
    const w = works.get(slug);
    if (!w) return;
    w.stack = (w.stack || []).map((s) => (rowKey(s) === key ? { ...s, gates: { ...(s.gates || {}), [gate]: record } } : s));
    works.save(w);
  };

  async function start(slug: string, input: DispatchInput): Promise<Dispatched> {
    const { work, entry, key, prompt, persona, edits } = resolve(slug, input);
    const args = typeof input.args === 'string' ? input.args.trim() : '';
    const title = titleOf(entry, key, edits, { prompt, persona });

    if (entry.kind === 'fix-findings' && key !== null) {
      const given = Array.isArray(input.commentIds) ? input.commentIds.filter((x): x is string => typeof x === 'string') : [];
      const commentIds = given.length ? given : (comments.list(slug, key).comments || []).filter((c) => c.status === 'open').map((c) => c.id);
      if (!commentIds.length) throw new HttpError(400, `no open finding to fix on ${keyLabel(key)}`);
      const { brief } = await briefOf(slug, key);
      const run = await reviewAgent.start(slug, key, { commentIds, wrap: (task) => firstMessage({ title, task, edits: true, brief }) });
      return { kind: entry.kind, title, agentId: run.agentId, edits: true, runId: run.runId };
    }

    const scope: Scope = key === null ? { kind: 'work', slug } : { kind: 'row', slug, key, edits };
    const placed = await placement.place(scope);
    const { brief, read } = await briefOf(slug, key);
    const task = taskOf(entry, key, { prompt, persona, args });
    const labels: Record<string, unknown> = { source: 'cocopilot', kind: 'dispatch', dispatch: entry.id, work: slug, ...(key === null ? {} : { pr: fileKey(key) }) };
    const started = await agents.start({ title, provider: config.models.default, thinking: 'high', prompt: firstMessage({ title, task, edits, brief, read }), labels, workspaceId: placed.workspaceId, cwd: placed.cwd });
    if (entry.kind === 'gate' && entry.gate && key !== null) markGate(slug, key, entry.gate, { state: 'running', at: new Date().toISOString(), skill: entry.skill || entry.gate, agentId: started.agentId });
    reviewAgent.timeline(work.slug, 'agent', `dispatch ${title}: started agent ${String(started.agentId || '').slice(0, 8)} in the ${edits ? 'PR' : 'Plan'} workspace ${placed.workspaceId}`);
    return { kind: entry.kind, title, agentId: started.agentId, workspaceId: placed.workspaceId, edits };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug] = parts;
      const work = works.get(slug);
      if (!work) throw new HttpError(404, 'no such work');
      if (req.method === 'GET') return send(res, 200, { catalog: entriesFor(work) });
      if (req.method === 'POST') {
        let body: DispatchInput;
        try {
          body = JSON.parse((await readBody(req)) || '{}') || {};
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
        return send(res, 200, await start(slug, body));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { catalog: entriesFor, start, handle };
}
