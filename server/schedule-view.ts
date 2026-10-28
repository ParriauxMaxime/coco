// A Paseo schedule as the Schedules page shows it, and its cadence in words; pure, shared by server/schedules.ts and the page.

export type Cadence = { type: 'every'; everyMs: number } | { type: 'cron'; expression: string; timezone?: string };
export type ScheduleRun = { id: string; scheduledFor: string; startedAt: string; endedAt: string | null; status: 'running' | 'succeeded' | 'failed'; agentId: string | null; workspaceId: string | null; output: string | null; error: string | null };
// new-agent: each run starts an agent with this config; agent: each run sends the prompt to that one agent
export type ScheduleTarget =
  | { type: 'new-agent'; provider: string; model: string | null; thinking: string | null; mode: string | null; cwd: string; isolation: 'local' | 'worktree' }
  | { type: 'agent'; agentId: string };
export type ScheduleView = {
  id: string;
  name: string | null;
  prompt: string;
  cadence: Cadence;
  status: 'active' | 'paused' | 'completed';
  target: ScheduleTarget;
  // the Paseo project its runs start in, when cwd is one's root or inside it
  project: { name: string; path: string } | null;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  expiresAt: string | null;
  maxRuns: number | null;
  runCount: number;
  lastRun: ScheduleRun | null;
};
export type ScheduleProject = { name: string; path: string };
// a ritual's prompt with {briefsDir} and {owner} filled, its own fields left for the form
export type ScheduleRitual = { kind: string; label: string; title: string; prompt: string; fields: string[] };
export type SchedulesResponse = { schedules: ScheduleView[]; projects: ScheduleProject[]; rituals: ScheduleRitual[] };
// what the form sends to create or edit one: provider is `<provider>/<model>` as the model picker gives it
export type ScheduleInput = { name?: string | null; prompt?: string; cadence?: Cadence; provider?: string; thinking?: string | null; mode?: string | null; cwd?: string; isolation?: 'local' | 'worktree' };

// {field} or {a|b} (first non-empty) from vars; keep leaves a placeholder no var fills as it is
export const fillTemplate = (template: string, vars: Record<string, unknown>, keep = false) =>
  template.replace(/\{([\w|]+)\}/g, (all, keys: string) => keys.split('|').map((k) => String(vars[k] ?? '').trim()).find(Boolean) || (keep ? all : ''));

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NUM = /^\d+$/;
const pad = (n: string | number) => String(n).padStart(2, '0');
const plural = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

export function describeEvery(ms: number) {
  const min = ms / 60000;
  if (Number.isInteger(min / 1440)) return plural(min / 1440, 'day');
  if (Number.isInteger(min / 60)) return plural(min / 60, 'hour');
  if (Number.isInteger(min)) return plural(min, 'minute');
  return plural(Math.round(ms / 1000), 'second');
}

function days(dow: string) {
  if (dow === '1-5') return 'on weekdays';
  if (dow === '0,6' || dow === '6,0') return 'on weekends';
  const list = dow.split(',');
  if (!list.every((d) => NUM.test(d) && Number(d) < 7)) return null;
  return list.length === 1 ? `every ${DAYS[Number(list[0])]}` : `on ${list.map((d) => DAYS[Number(d)].slice(0, 3)).join(', ')}`;
}

// the five fields in words for the usual shapes, else null; once: a date that comes back yearly only runs once
function cronWords(expression: string, once: boolean) {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
  const anyDay = dom === '*' && mon === '*' && dow === '*';
  if (anyDay && min === '*' && hour === '*') return 'every minute';
  if (anyDay && step(min) && hour === '*') return plural(Number(step(min)), 'minute');
  if (!NUM.test(min)) return null;
  if (anyDay && hour === '*') return Number(min) ? `every hour at :${pad(min)}` : 'every hour';
  if (anyDay && step(hour)) return `${plural(Number(step(hour)), 'hour')}${Number(min) ? ` at :${pad(min)}` : ''}`;
  const hours = hour.split(',');
  if (!hours.every((h) => NUM.test(h))) return null;
  const at = `at ${hours.map((h) => `${pad(h)}:${pad(min)}`).join(' and ')}`;
  if (anyDay) return `every day ${at}`;
  if (dom === '*' && mon === '*') {
    const d = days(dow);
    return d && `${d} ${at}`;
  }
  if (dow !== '*' || !NUM.test(dom)) return null;
  if (mon === '*') return `monthly on the ${ordinal(Number(dom))} ${at}`;
  if (NUM.test(mon) && Number(mon) >= 1 && Number(mon) <= 12) return `${once ? 'once, ' : ''}on ${Number(dom)} ${MONTHS[Number(mon) - 1]} ${at}${once ? '' : ', yearly'}`;
  return null;
}

// maxRuns: Paseo's run limit, 1 for a one-shot timer
export function describeCadence(c: Cadence, maxRuns?: number | null) {
  if (c.type === 'every') return describeEvery(c.everyMs);
  const words = cronWords(c.expression, maxRuns === 1) ?? `cron ${c.expression.trim()}`;
  return `${words}${c.timezone ? ` (${c.timezone})` : ''}`;
}

// the form's daily shape: minute and hour fixed, any day of the month, every day or some week days
export type Daily = { time: string; days: string };
export function dailyOf(c: Cadence): Daily | null {
  if (c.type !== 'cron') return null;
  const [min, hour, dom, mon, dow, ...rest] = c.expression.trim().split(/\s+/);
  if (rest.length || !NUM.test(min ?? '') || !NUM.test(hour ?? '') || dom !== '*' || mon !== '*' || !dow || (dow !== '*' && !days(dow))) return null;
  return { time: `${pad(hour)}:${pad(min)}`, days: dow };
}
export const dailyCron = (d: Daily) => {
  const [h, m] = d.time.split(':').map(Number);
  return `${m || 0} ${h || 0} * * ${d.days || '*'}`;
};
