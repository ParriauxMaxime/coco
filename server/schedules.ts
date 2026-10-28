// Paseo schedules (recurring agent runs) as the Paseo app manages them: list with each one's last run, its run logs, create, edit,
// pause, resume, run once, delete. Paseo's schedule API only: with the daemon away there is nothing to show. Not coco's rituals,
// which start one agent when pressed; a ritual's prompt can seed a new schedule.
// GET /api/schedules · POST /api/schedules {ScheduleInput} · GET /api/schedules/<id>/logs · PUT /api/schedules/<id> {ScheduleInput}
// POST /api/schedules/<id>/pause|resume|run-once · DELETE /api/schedules/<id>
import fs from 'node:fs';
import path from 'node:path';
import { everyMsToFiveFieldCron } from '@getpaseo/protocol/schedule/cadence';
import { validateCronExpression } from '@getpaseo/protocol/schedule/cron-expression';
import { within } from './workspace-git.ts';
import { expandHome } from './paseo-agent.ts';
import { HttpError, errorMessage, errorStatus } from './core-types.ts';
import { fillTemplate } from './schedule-view.ts';
import type { ScheduleApi } from './paseo-agent.ts';
import type { Picked } from './models.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';
import type { Cadence, ScheduleInput, ScheduleProject, ScheduleRitual, ScheduleRun, ScheduleTarget, ScheduleView } from './schedule-view.ts';

type Ritual = { kind: string; label?: string; title?: string; prompt?: string; fields?: string[] };
type Deps = {
  // the daemon's schedule calls while it is connected, else null
  daemon: () => Promise<ScheduleApi | null>;
  models: { check(pick: { provider?: unknown; thinking?: unknown }): Promise<Picked>; mode(provider: string, picked: unknown): Promise<string | undefined> };
  rituals?: () => { list: Ritual[]; vars: Record<string, string> };
  isDir?: (p: string) => boolean;
};
type Stored = Awaited<ReturnType<ScheduleApi['scheduleInspect']>>['schedule'];
type Summary = NonNullable<Awaited<ReturnType<ScheduleApi['scheduleList']>>['schedules'][number]>;

const SDK_MS = 10000;
const OUTPUT_MAX = 4000;
const PROMPT_MAX = 50000;
const NAME_MAX = 120;
const MIN_EVERY = 60 * 1000;
const MAX_EVERY = 366 * 24 * 3600 * 1000;
const ID = /^[\w-]{1,64}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const ACTIONS = ['pause', 'resume', 'run-once'] as const;

const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const runOf = (r: NonNullable<Stored>['runs'][number]): ScheduleRun => ({ id: r.id, scheduledFor: r.scheduledFor, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, agentId: r.agentId, workspaceId: r.workspaceId ?? null, output: clip(r.output, OUTPUT_MAX), error: r.error });
const targetOf = (t: Summary['target']): ScheduleTarget =>
  t.type === 'agent' ? { type: 'agent', agentId: t.agentId } : { type: 'new-agent', provider: t.config.provider, model: t.config.model ?? null, thinking: t.config.thinkingOptionId ?? null, mode: t.config.modeId ?? null, cwd: t.config.cwd, isolation: t.config.isolation ?? 'local' };
// the project holding dir: its root, else the deepest one it sits in
const projectOf = (projects: ScheduleProject[], dir: string) => {
  const inside = projects.filter((p) => dir === p.path || dir.startsWith(`${p.path}/`));
  return inside.sort((a, b) => b.path.length - a.path.length)[0] ?? null;
};
// Paseo's own answer to a call: an unknown id is a 404, anything else it refused a 409
const answered = <T extends { error: string | null }>(r: T) => {
  if (r.error) throw new HttpError(/not found|no schedule|unknown schedule/i.test(r.error) ? 404 : 409, r.error);
  return r;
};

function text(v: unknown, name: string, max: number, { required = false, line = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  if (required && !v.trim()) throw new HttpError(400, `${name} required`);
  if (v.length > max) throw new HttpError(400, `${name}: at most ${max} characters`);
  if (line && CONTROL.test(v)) throw new HttpError(400, `${name}: one line, no control characters`);
  return v;
}

// a cron cadence with a known time zone, or an interval from a minute to a year (as cron when it maps exactly, as Paseo's CLI does)
export function checkCadence(v: unknown): Cadence {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'cadence required: { type: "cron", expression, timezone? } or { type: "every", everyMs }');
  const c = v as Record<string, unknown>;
  if (c.type === 'every') {
    if (!Number.isInteger(c.everyMs) || (c.everyMs as number) < MIN_EVERY || (c.everyMs as number) > MAX_EVERY) throw new HttpError(400, 'cadence.everyMs: a whole number of ms from one minute to a year');
    const cron = everyMsToFiveFieldCron(c.everyMs as number);
    return cron ? { type: 'cron', expression: cron } : { type: 'every', everyMs: c.everyMs as number };
  }
  if (c.type !== 'cron') throw new HttpError(400, 'cadence.type: cron or every');
  const expression = text(c.expression, 'cadence.expression', 200, { required: true, line: true })!.trim().replace(/\s+/g, ' ');
  const bad = validateCronExpression(expression);
  if (bad) throw new HttpError(400, `cadence.expression: ${bad} (minute hour day-of-month month day-of-week, numbers, *, ranges, lists and steps)`);
  const timezone = text(c.timezone, 'cadence.timezone', 100, { line: true })?.trim();
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new HttpError(400, `cadence.timezone: unknown time zone ${timezone}`);
    }
  }
  return { type: 'cron', expression, ...(timezone ? { timezone } : {}) };
}

export function createSchedules({ daemon, models, rituals = () => ({ list: [], vars: {} }), isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false }: Deps) {
  const api = async () => {
    const d = await within(daemon(), 2000).catch(() => null);
    if (!d) throw new HttpError(503, 'Paseo is not connected: schedules live in its daemon');
    return d;
  };

  async function projects(d: ScheduleApi): Promise<ScheduleProject[]> {
    const r = await within(d.listProjects(), SDK_MS).catch(() => null);
    return (r?.projects ?? []).map((p) => ({ name: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath }));
  }

  const viewOf = (s: Summary, runs: ScheduleRun[], known: ScheduleProject[]): ScheduleView => {
    const target = targetOf(s.target);
    return {
      id: s.id, name: s.name, prompt: s.prompt, cadence: s.cadence, status: s.status, target,
      project: target.type === 'new-agent' ? projectOf(known, target.cwd) : null,
      createdAt: s.createdAt, updatedAt: s.updatedAt, nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt, pausedAt: s.pausedAt, expiresAt: s.expiresAt, maxRuns: s.maxRuns,
      runCount: runs.length,
      lastRun: runs.reduce<ScheduleRun | null>((last, r) => (!last || r.startedAt > last.startedAt ? r : last), null),
    };
  };

  async function inspect(d: ScheduleApi, id: string) {
    const r = answered(await within(d.scheduleInspect({ id }), SDK_MS));
    if (!r.schedule) throw new HttpError(404, `no schedule ${id}`);
    return r.schedule;
  }

  async function list() {
    const d = await api();
    const [r, known] = await Promise.all([within(d.scheduleList(), SDK_MS).then(answered), projects(d)]);
    // the list carries no runs: each one's own inspect gives its last run
    const runsOf = (id: string) => inspect(d, id).then((s) => s.runs.map(runOf), () => []);
    const schedules = await Promise.all(r.schedules.map(async (s) => viewOf(s, await runsOf(s.id), known)));
    const { list: rs, vars } = rituals();
    const ritualList: ScheduleRitual[] = rs.filter((x) => x.prompt).map((x) => ({ kind: x.kind, label: x.label || x.kind, title: fillTemplate(x.title || x.label || x.kind, vars, true), prompt: fillTemplate(x.prompt || '', vars, true), fields: x.fields || [] }));
    return { schedules, projects: known, rituals: ritualList };
  }

  async function view(d: ScheduleApi, id: string) {
    const s = await inspect(d, id);
    return viewOf(s, s.runs.map(runOf), await projects(d));
  }

  // the new-agent config a form asks for: a model the picker offers, a thinking level and mode of it, an existing absolute folder
  async function agentConfig(input: Record<string, unknown>, required: boolean) {
    const provider = text(input.provider, 'provider', 200, { required, line: true });
    const cwdRaw = text(input.cwd, 'cwd', 1000, { required, line: true });
    if (input.isolation !== undefined && input.isolation !== 'local' && input.isolation !== 'worktree') throw new HttpError(400, 'isolation: local or worktree');
    const out: { provider?: string; model?: string; thinkingOptionId?: string | null; modeId?: string | null; cwd?: string; isolation?: 'local' | 'worktree' } = {};
    if (provider !== undefined) {
      if (!provider.includes('/')) throw new HttpError(400, 'provider: <provider>/<model>, as the model picker gives it');
      const picked = await models.check({ provider, thinking: input.thinking ?? undefined });
      const [family, ...model] = picked.provider!.split('/');
      Object.assign(out, { provider: family, model: model.join('/'), thinkingOptionId: picked.thinking ?? null, modeId: (await models.mode(picked.provider!, input.mode)) ?? null });
    } else if (input.thinking != null || input.mode != null) throw new HttpError(400, 'thinking and mode go with a provider');
    if (cwdRaw !== undefined) {
      const cwd = path.resolve(expandHome(cwdRaw.trim()));
      if (!path.isAbsolute(expandHome(cwdRaw.trim()))) throw new HttpError(400, 'cwd: an absolute path (or ~/…)');
      if (!isDir(cwd)) throw new HttpError(400, `cwd: no folder ${cwd}`);
      out.cwd = cwd;
    }
    if (input.isolation) out.isolation = input.isolation as 'local' | 'worktree';
    return out;
  }

  async function create(body: Record<string, unknown>) {
    const name = text(body.name, 'name', NAME_MAX, { line: true })?.trim();
    const prompt = text(body.prompt, 'prompt', PROMPT_MAX, { required: true })!;
    const cadence = checkCadence(body.cadence);
    const cfg = await agentConfig(body, true);
    const d = await api();
    const config = { provider: cfg.provider!, cwd: cfg.cwd!, model: cfg.model, ...(cfg.thinkingOptionId ? { thinkingOptionId: cfg.thinkingOptionId } : {}), ...(cfg.modeId ? { modeId: cfg.modeId } : {}), ...(cfg.isolation ? { isolation: cfg.isolation } : {}) };
    // the SDK's type only names cron, its daemon takes an interval too
    const r = answered(await within(d.scheduleCreate({ prompt, ...(name ? { name } : {}), cadence: cadence as Extract<Cadence, { type: 'cron' }>, target: { type: 'new-agent', config }, runOnCreate: false }), SDK_MS));
    if (!r.schedule) throw new HttpError(409, 'Paseo made no schedule');
    return { schedule: viewOf(r.schedule, [], await projects(d)) };
  }

  async function update(id: string, body: Record<string, unknown>) {
    const name = body.name === undefined ? undefined : text(body.name, 'name', NAME_MAX, { line: true })?.trim() || null;
    const prompt = text(body.prompt, 'prompt', PROMPT_MAX);
    if (prompt !== undefined && !prompt.trim()) throw new HttpError(400, 'prompt required');
    const cadence = body.cadence === undefined ? undefined : checkCadence(body.cadence);
    const cfg = await agentConfig(body, false);
    const d = await api();
    const now = await inspect(d, id);
    if (Object.keys(cfg).length && now.target.type !== 'new-agent') throw new HttpError(409, 'this schedule sends its prompt to one agent: only its name, prompt and cadence change');
    const r = answered(await within(d.scheduleUpdate({ id, ...(name !== undefined ? { name } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(cadence ? { cadence: cadence as Extract<Cadence, { type: 'cron' }> } : {}), ...(Object.keys(cfg).length ? { newAgentConfig: cfg } : {}) }), SDK_MS));
    if (!r.schedule) throw new HttpError(409, 'Paseo returned no schedule');
    return { schedule: await view(d, id) };
  }

  async function act(id: string, action: (typeof ACTIONS)[number]) {
    const d = await api();
    const call = action === 'pause' ? d.schedulePause({ id }) : action === 'resume' ? d.scheduleResume({ id }) : d.scheduleRunOnce({ id });
    answered(await within(call, SDK_MS));
    return { schedule: await view(d, id) };
  }

  async function logs(id: string) {
    const d = await api();
    const r = answered(await within(d.scheduleLogs({ id }), SDK_MS));
    return { runs: r.runs.map(runOf).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) };
  }

  async function remove(id: string) {
    const d = await api();
    answered(await within(d.scheduleDelete({ id }), SDK_MS));
    return { ok: true };
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, id, action, extra] = parts;
    try {
      if (id !== undefined && !ID.test(id)) throw new HttpError(400, 'bad schedule id');
      if (extra !== undefined) throw new HttpError(404, 'no route');
      const body = async () => {
        let b: unknown;
        try {
          b = JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'the body is not JSON');
        }
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'the body must be an object');
        return b as Record<string, unknown>;
      };
      const m = req.method;
      if (!id && m === 'GET') return send(res, 200, await list());
      if (!id && m === 'POST') return send(res, 200, await create(await body()));
      if (id && !action && m === 'PUT') return send(res, 200, await update(id, await body()));
      if (id && !action && m === 'DELETE') return send(res, 200, await remove(id));
      if (id && action === 'logs' && m === 'GET') return send(res, 200, await logs(id));
      if (id && m === 'POST' && ACTIONS.includes(action as (typeof ACTIONS)[number])) return send(res, 200, await act(id, action as (typeof ACTIONS)[number]));
      throw new HttpError(404, 'no route');
    } catch (e) {
      return send(res, errorStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, list };
}
