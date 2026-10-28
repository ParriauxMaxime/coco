import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { checkCadence, createSchedules } from './schedules.ts';
import { HttpError } from './core-types.ts';
import { dailyCron, dailyOf, describeCadence, fillTemplate } from './schedule-view.ts';
import type { ScheduleApi } from './paseo-agent.ts';

const AGENT = '6de65b19-3144-4583-aba4-01cce73787d0';
const RUN = { id: 'r1', scheduledFor: '2026-10-23T07:00:00.000Z', startedAt: '2026-10-23T07:00:01.000Z', endedAt: '2026-10-23T07:08:00.000Z', status: 'succeeded', agentId: AGENT, workspaceId: 'wks_1', output: 'done', error: null };

// a daemon holding schedules in memory, as Paseo answers: an unknown id is an error in the payload
function fakeDaemon() {
  const calls: { created: Record<string, unknown>[]; updated: Record<string, unknown>[]; acted: string[] } = { created: [], updated: [], acted: [] };
  const base = { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', nextRunAt: null, lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null };
  const all = new Map<string, Record<string, unknown> & { runs: unknown[] }>([
    ['aaaa1111', { ...base, id: 'aaaa1111', name: 'Daily', prompt: 'collect', cadence: { type: 'cron', expression: '0 7 * * *', timezone: 'Europe/Paris' }, target: { type: 'new-agent', config: { provider: 'claude-perso', cwd: '/proj/maisons/app', modeId: 'auto', model: 'sonnet' } }, status: 'paused', runs: [RUN] }],
    ['bbbb2222', { ...base, id: 'bbbb2222', name: null, prompt: 'ping', cadence: { type: 'every', everyMs: 90 * 60000 }, target: { type: 'agent', agentId: AGENT }, status: 'active', runs: [] }],
  ]);
  const summary = ({ runs: _, ...s }: Record<string, unknown>) => s;
  const missing = (id: string) => ({ requestId: 'r', schedule: null, error: `Schedule not found: ${id}` });
  const d = {
    scheduleList: async () => ({ requestId: 'r', schedules: [...all.values()].map(summary), error: null }),
    scheduleInspect: async ({ id }: { id: string }) => (all.has(id) ? { requestId: 'r', schedule: all.get(id), error: null } : missing(id)),
    scheduleLogs: async ({ id }: { id: string }) => (all.has(id) ? { requestId: 'r', runs: all.get(id)!.runs, error: null } : { requestId: 'r', runs: [], error: `Schedule not found: ${id}` }),
    scheduleCreate: async (o: Record<string, unknown>) => {
      calls.created.push(o);
      const s = { ...base, id: 'cccc3333', name: o.name ?? null, prompt: o.prompt, cadence: o.cadence, target: o.target, status: 'active', runs: [] };
      all.set(s.id, s);
      return { requestId: 'r', schedule: summary(s), error: null };
    },
    scheduleUpdate: async (o: Record<string, unknown> & { id: string }) => {
      calls.updated.push(o);
      if (!all.has(o.id)) return missing(o.id);
      const s = all.get(o.id)!;
      if (o.prompt) s.prompt = o.prompt;
      return { requestId: 'r', schedule: summary(s), error: null };
    },
    ...Object.fromEntries((['schedulePause', 'scheduleResume', 'scheduleRunOnce', 'scheduleDelete'] as const).map((k) => [k, async ({ id }: { id: string }) => {
      if (!all.has(id)) return missing(id);
      calls.acted.push(`${k}:${id}`);
      if (k === 'scheduleDelete') all.delete(id);
      else if (k !== 'scheduleRunOnce') all.get(id)!.status = k === 'schedulePause' ? 'paused' : 'active';
      return { requestId: 'r', scheduleId: id, schedule: all.get(id) ?? null, error: null };
    }])),
    listProjects: async () => ({ requestId: 'r', projects: [{ projectId: 'p1', projectDisplayName: 'maisons', projectRootPath: '/proj/maisons', projectKind: 'git' }, { projectId: 'p2', projectDisplayName: 'proj', projectRootPath: '/proj', projectKind: 'directory' }] }),
  };
  return { d: d as unknown as ScheduleApi, calls, all };
}

const models = {
  check: async ({ provider, thinking }: { provider?: unknown; thinking?: unknown }) => {
    if (provider !== 'claude/opus' && provider !== 'claude-perso/sonnet') throw new HttpError(400, `unknown model ${provider}`);
    if (thinking && thinking !== 'high') throw new HttpError(400, `no thinking level ${thinking}`);
    return { provider: provider as string, ...(thinking ? { thinking: thinking as string } : {}) };
  },
  mode: async (_p: string, picked: unknown) => {
    if (picked && picked !== 'auto' && picked !== 'plan') throw new HttpError(400, `no mode ${picked}`);
    return (picked as string) || 'auto';
  },
};

type Out = { status: number; body: Record<string, unknown> & { error: string } };
function caller(daemon: () => Promise<ScheduleApi | null>) {
  const s = createSchedules({ daemon, models, isDir: (p) => p.startsWith('/proj'), rituals: () => ({ list: [{ kind: 'map', label: 'Map', title: 'Map {login}', prompt: 'Read {briefsDir}/x.md for {login}', fields: ['login'] }], vars: { briefsDir: '/briefs' } }) });
  return async (method: string, url: string, body?: unknown): Promise<Out> => {
    const out = { status: 0, body: {} } as Out;
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = url;
    const parts = url.split('/').filter(Boolean).slice(1);
    const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    await s.handle(req, new ServerResponse(req), parts, async () => raw, (_r, status, b) => void Object.assign(out, { status, body: b }));
    return out;
  };
}

const good = { name: 'Nightly', prompt: 'do it', cadence: { type: 'cron', expression: '0 3 * * 1-5', timezone: 'Europe/Paris' }, provider: 'claude/opus', thinking: 'high', cwd: '/proj/maisons' };

test('a cadence: cron checked field by field with a real time zone, an interval as cron when it maps exactly', () => {
  assert.deepEqual(checkCadence({ type: 'cron', expression: ' 0  7 * * * ', timezone: 'Europe/Paris' }), { type: 'cron', expression: '0 7 * * *', timezone: 'Europe/Paris' });
  assert.deepEqual(checkCadence({ type: 'every', everyMs: 15 * 60000 }), { type: 'cron', expression: '*/15 * * * *' });
  assert.deepEqual(checkCadence({ type: 'every', everyMs: 90 * 60000 }), { type: 'every', everyMs: 90 * 60000 });
  for (const bad of [null, [], { type: 'daily' }, { type: 'cron', expression: '0 7 * *' }, { type: 'cron', expression: '61 7 * * *' }, { type: 'cron', expression: '0 7 * * MON' }, { type: 'cron', expression: '0 7 * * *', timezone: 'Mars/Olympus' }, { type: 'every', everyMs: 1000 }, { type: 'every', everyMs: 1.5 }, { type: 'cron', expression: '0 7 * * *\n' }]) {
    assert.throws(() => checkCadence(bad), (e: HttpError) => e.status === 400, JSON.stringify(bad));
  }
});

test('a cadence in words, a ritual template filled, the daily form shape', () => {
  const words = (expression: string, timezone?: string) => describeCadence({ type: 'cron', expression, ...(timezone ? { timezone } : {}) });
  assert.equal(words('0 7 * * *', 'Europe/Paris'), 'every day at 07:00 (Europe/Paris)');
  assert.equal(words('*/15 * * * *'), 'every 15 minutes');
  assert.equal(words('5 * * * *'), 'every hour at :05');
  assert.equal(words('0 */6 * * *'), 'every 6 hours');
  assert.equal(words('30 9 * * 1-5'), 'on weekdays at 09:30');
  assert.equal(words('0 9 * * 1'), 'every Monday at 09:00');
  assert.equal(words('0 9,14 * * 1,3'), 'on Mon, Wed at 09:00 and 14:00');
  assert.equal(words('0 9 1 * *'), 'monthly on the 1st at 09:00');
  assert.equal(words('10 20 21 10 *'), 'on 21 Oct at 20:10, yearly');
  assert.equal(words('0 9-17 * * *'), 'cron 0 9-17 * * *');
  assert.equal(describeCadence({ type: 'every', everyMs: 90 * 60000 }), 'every 90 minutes');
  assert.equal(describeCadence({ type: 'every', everyMs: 2 * 86400000 }), 'every 2 days');
  assert.equal(fillTemplate('Read {briefsDir}/x for {login|paths}', { briefsDir: '/b' }, true), 'Read /b/x for {login|paths}');
  assert.equal(fillTemplate('Read {briefsDir}/x for {login|paths}', { briefsDir: '/b', paths: 'src' }), 'Read /b/x for src');
  assert.deepEqual(dailyOf({ type: 'cron', expression: '30 9 * * 1-5' }), { time: '09:30', days: '1-5' });
  assert.equal(dailyOf({ type: 'cron', expression: '*/5 * * * *' }), null);
  assert.equal(dailyCron({ time: '07:05', days: '*' }), '5 7 * * *');
});

test('routes refuse a bad id, route, body or field before reaching Paseo', async () => {
  const { d, calls } = fakeDaemon();
  const call = caller(async () => d);
  assert.equal((await call('GET', '/api/schedules/bad!id/logs')).status, 400);
  assert.equal((await call('GET', '/api/schedules/aaaa1111/logs/x')).status, 404);
  assert.equal((await call('POST', '/api/schedules/aaaa1111/archive', {})).status, 404);
  assert.equal((await call('GET', '/api/schedules/aaaa1111')).status, 404);
  assert.equal((await call('POST', '/api/schedules', 'not json')).status, 400);
  assert.equal((await call('POST', '/api/schedules', [1])).status, 400);
  const bad = async (patch: Record<string, unknown>) => (await call('POST', '/api/schedules', { ...good, ...patch })).body.error;
  assert.match(await bad({ prompt: '  ' }), /prompt required/);
  assert.match(await bad({ prompt: 5 }), /prompt must be a string/);
  assert.match(await bad({ name: 'a\nb' }), /name: one line/);
  assert.match(await bad({ name: 'x'.repeat(200) }), /name: at most/);
  assert.match(await bad({ cadence: undefined }), /cadence required/);
  assert.match(await bad({ cadence: { type: 'cron', expression: '0 25 * * *' } }), /cadence.expression/);
  assert.match(await bad({ provider: undefined }), /provider required/);
  assert.match(await bad({ provider: 'claude' }), /<provider>\/<model>/);
  assert.match(await bad({ provider: 'codex/gpt' }), /unknown model/);
  assert.match(await bad({ thinking: 'max' }), /no thinking level/);
  assert.match(await bad({ mode: 'yolo' }), /no mode/);
  assert.match(await bad({ cwd: 'relative/dir' }), /absolute path/);
  assert.match(await bad({ cwd: '/elsewhere' }), /no folder/);
  assert.match(await bad({ isolation: 'docker' }), /isolation/);
  assert.match((await call('PUT', '/api/schedules/aaaa1111', { thinking: 'high' })).body.error, /go with a provider/);
  assert.equal((await call('PUT', '/api/schedules/bbbb2222', { cwd: '/proj' })).status, 409, 'an agent-target schedule keeps its agent');
  assert.equal((await call('PUT', '/api/schedules/zzzz9999', { prompt: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/schedules/zzzz9999/pause', {})).status, 404);
  assert.deepEqual([calls.created, calls.updated, calls.acted], [[], [], []], 'nothing reached Paseo');
});

test('list, logs, create, edit, pause, resume, run once and delete go to Paseo', async () => {
  const { d, calls, all } = fakeDaemon();
  const call = caller(async () => d);
  const list = (await call('GET', '/api/schedules')).body as unknown as { schedules: { id: string; project: unknown; lastRun: { agentId: string } | null; target: unknown; runCount: number }[]; rituals: unknown[] };
  assert.deepEqual(list.schedules.map((s) => s.id), ['aaaa1111', 'bbbb2222']);
  assert.deepEqual(list.schedules[0].project, { name: 'maisons', path: '/proj/maisons' }, 'the deepest project holding its folder');
  assert.deepEqual(list.schedules[0].target, { type: 'new-agent', provider: 'claude-perso', model: 'sonnet', thinking: null, mode: 'auto', cwd: '/proj/maisons/app', isolation: 'local' });
  assert.equal(list.schedules[0].lastRun?.agentId, AGENT);
  assert.deepEqual(list.schedules[1].target, { type: 'agent', agentId: AGENT });
  assert.deepEqual(list.rituals, [{ kind: 'map', label: 'Map', title: 'Map {login}', prompt: 'Read /briefs/x.md for {login}', fields: ['login'] }]);
  const logs = await call('GET', '/api/schedules/aaaa1111/logs');
  assert.deepEqual((logs.body.runs as { id: string }[]).map((r) => r.id), ['r1']);

  const made = await call('POST', '/api/schedules', { ...good, mode: 'plan', isolation: 'worktree' });
  assert.equal(made.status, 200);
  assert.deepEqual(calls.created[0], { prompt: 'do it', name: 'Nightly', cadence: { type: 'cron', expression: '0 3 * * 1-5', timezone: 'Europe/Paris' }, target: { type: 'new-agent', config: { provider: 'claude', cwd: '/proj/maisons', model: 'opus', thinkingOptionId: 'high', modeId: 'plan', isolation: 'worktree' } }, runOnCreate: false });

  const edited = await call('PUT', '/api/schedules/cccc3333', { name: '', prompt: 'do it better', cadence: { type: 'every', everyMs: 3600000 }, provider: 'claude-perso/sonnet', thinking: null, cwd: '~/../../proj' });
  assert.equal(edited.status, 200, edited.body.error);
  assert.deepEqual(calls.updated[0], { id: 'cccc3333', name: null, prompt: 'do it better', cadence: { type: 'cron', expression: '0 * * * *' }, newAgentConfig: { provider: 'claude-perso', model: 'sonnet', thinkingOptionId: null, modeId: 'auto', cwd: '/proj' } });
  assert.equal((await call('PUT', '/api/schedules/bbbb2222', { prompt: 'pong' })).status, 200, 'an agent-target schedule still takes a new prompt');

  assert.equal(((await call('POST', '/api/schedules/cccc3333/pause', {})).body.schedule as { status: string }).status, 'paused');
  assert.equal(((await call('POST', '/api/schedules/cccc3333/resume', {})).body.schedule as { status: string }).status, 'active');
  assert.equal((await call('POST', '/api/schedules/cccc3333/run-once', {})).status, 200);
  assert.deepEqual((await call('DELETE', '/api/schedules/cccc3333')).body, { ok: true });
  assert.deepEqual(calls.acted, ['schedulePause:cccc3333', 'scheduleResume:cccc3333', 'scheduleRunOnce:cccc3333', 'scheduleDelete:cccc3333']);
  assert.equal(all.has('cccc3333'), false);
});

test('with Paseo away the routes say so', async () => {
  const r = await caller(async () => null)('GET', '/api/schedules');
  assert.equal(r.status, 503);
  assert.match(r.body.error, /Paseo/);
});
