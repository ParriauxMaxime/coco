// The brief writer: a short fast-model run through Paseo, in the work's Plan workspace, writes each dispatch's brief from the template facts, the dispatch and the repo's brief lessons.
// Once a dispatched run ends, the judge picks the user's follow-ups to it that supplied context its brief lacked: they become lessons of the repo (data/repos/<id>/brief-lessons.json).
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './core-types.ts';
import type { Config } from './config.ts';
import type { Judge } from './judge.ts';
import type { AgentHistory } from './paseo-agent.ts';

export type Lesson = { text: string; at?: string; work?: string; agentId?: string; decision?: string };
export type BriefDispatch = { slug: string; repoId: string | null; title: string; label: string; pr: string | null; edits: boolean; persona?: string; task: string };
export type Written = { brief: string | null; error?: string };
type Placed = { workspaceId: string; cwd: string };
type RunOpts = { title: string; prompt: string; provider: string; labels: Record<string, unknown>; workspaceId: string; cwd: string; timeoutMs: number };
type Tracked = { agentId: string; slug: string; repoId: string; title: string; message: string; at: string; reviewed: number; tries: number };
type Deps = {
  DATA: string;
  config: Pick<Config, 'models'>;
  agents: { run(opts: RunOpts): Promise<{ status: string; error?: string | null; finalText: string }>; history(agentId: string): Promise<AgentHistory | null> };
  judge: Judge;
  place: (slug: string) => Promise<Placed>;
  now?: () => number;
  writerMs?: number;
  idleMs?: number;
};

const WRITER_MS = 90_000;
const JUDGE_MS = 3 * 60_000;
const IDLE_MS = 60 * 60_000;
const KEEP_MS = 3 * 24 * 60 * 60_000;
const SWEEP_MS = 10 * 60_000;
const MAX_TRIES = 3;
const LESSONS_IN_BRIEF = 40;
const LESSON_MAX = 300;
const BRIEF_MAX = 20_000;
const REPO_ID = /^[\w.-]+$/;

const lessonsFile = (DATA: string, repoId: string) => path.join(DATA, 'repos', repoId, 'brief-lessons.json');

// the repo's lessons, oldest first; a plain string counts as a lesson
export function readLessons(DATA: string, repoId: string): Lesson[] {
  if (!REPO_ID.test(repoId)) return [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(lessonsFile(DATA, repoId), 'utf8'));
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    return list.map((l): Lesson => (typeof l === 'string' ? { text: l } : { ...(l as Lesson), text: String((l as Lesson)?.text || '') })).filter((l) => l.text);
  } catch {
    return [];
  }
}

const bullets = (lessons: Lesson[]) => lessons.map((l) => `- ${l.text}`).join('\n');

export function writerPrompt(d: BriefDispatch, facts: string | null, lessons: Lesson[]) {
  return [
    'Write the context brief for an agent coco is starting. The agent gets its task verbatim, then your brief under it.',
    '',
    'Use only the facts and lessons below: keep what this task needs, drop what it does not (an agent that only reads does not commit, ship a kit or report gates), apply the lessons that fit, invent nothing. Keep paths, branches, PR numbers and commands exact. Name the worktree and branch from the facts as settled; never tell the agent to check which branch it is on or to look for another worktree. Markdown, under 400 words, no title, no preamble, do not restate the task. Answer with the brief only, without using any tool.',
    '',
    '## Dispatch',
    '',
    `- Agent: ${d.label}${d.persona ? ` as ${d.persona}` : ''}, ${d.edits ? 'works on the PR branch' : 'read-only'}, on ${d.pr || 'the whole work'}.`,
    '- Task:',
    '',
    '<task>',
    d.task.trim(),
    '</task>',
    '',
    '## Facts',
    '',
    facts?.trim() || '(none)',
    ...(lessons.length ? ['', '## Lessons from past runs in this repo', '', bullets(lessons)] : []),
  ].join('\n');
}

export function lessonPrompt(message: string, followUps: string[], lessons: Lesson[]) {
  return [
    'coco started an agent with the first message below. While it ran, the user sent the follow-ups below.',
    'A follow-up is a lesson when it supplied context the brief lacked that future briefs in this repo should carry: a fact about the repo, where something lives, a convention, a constraint. Steering, approvals, new requests, questions and what only fits this one task are not lessons; neither is what the existing lessons already say.',
    '',
    'Answer with a JSON array of lessons only, each one short general sentence; [] when none. Do not use any tool.',
    '',
    '## First message',
    '',
    message.trim(),
    '',
    '## Follow-ups',
    '',
    followUps.map((f, i) => `${i + 1}. ${f.trim()}`).join('\n'),
    ...(lessons.length ? ['', '## Existing lessons', '', bullets(lessons)] : []),
  ].join('\n');
}

export function cleanBrief(text: string) {
  const t = String(text || '').trim();
  const fenced = t.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1].trim() : t).slice(0, BRIEF_MAX);
}

// the lessons in an answer, or null when it holds no JSON array
export function parseLessons(text: string): string[] | null {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const raw: unknown = JSON.parse(m[0]);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, LESSON_MAX)).filter(Boolean) : null;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\W+/g, ' ').trim();

const deadline = <T>(p: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no brief within ${Math.round(ms / 1000)}s`)), ms)))]).finally(() => clearTimeout(timer));
};

export function createBriefWriter({ DATA, config, agents, judge, place, now = Date.now, writerMs = WRITER_MS, idleMs = IDLE_MS }: Deps) {
  const provider = config.models.fast || config.models.default;
  const runsFile = path.join(DATA, 'brief-runs.json');
  const readRuns = (): Tracked[] => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  };
  const writeRuns = (runs: Tracked[]) => {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify(runs, null, 1));
  };
  const updateRun = (agentId: string, patch: Partial<Tracked> | null) => writeRuns(readRuns().flatMap((r) => (r.agentId !== agentId ? [r] : patch ? [{ ...r, ...patch }] : [])));

  const lessons = (repoId: string) => readLessons(DATA, repoId);

  function addLessons(repoId: string, texts: string[], meta: { work: string; agentId: string; decision?: string }) {
    if (!REPO_ID.test(repoId)) return [];
    const have = lessons(repoId);
    const known = new Set(have.map((l) => norm(l.text)));
    const fresh = texts.filter((t) => !known.has(norm(t)) && known.add(norm(t)));
    if (!fresh.length) return [];
    const at = new Date(now()).toISOString();
    fs.mkdirSync(path.dirname(lessonsFile(DATA, repoId)), { recursive: true });
    fs.writeFileSync(lessonsFile(DATA, repoId), JSON.stringify([...have, ...fresh.map((text) => ({ text, at, ...meta }))], null, 1));
    return fresh;
  }

  // the user drops a wrong lesson: gone from future briefs, and counted against the judge decision that made it
  function dropLesson(repoId: string, text: string) {
    const have = lessons(repoId);
    const gone = have.find((l) => norm(l.text) === norm(text));
    if (!gone) return null;
    fs.writeFileSync(lessonsFile(DATA, repoId), JSON.stringify(have.filter((l) => l !== gone), null, 1));
    if (gone.decision) judge.drop(gone.decision, gone.text);
    return gone;
  }

  // the brief for this dispatch, or null with why: the caller then falls back to the template brief
  async function write(d: BriefDispatch, facts: string | null): Promise<Written> {
    const job = (async () => {
      const where = await place(d.slug);
      const prompt = writerPrompt(d, facts, d.repoId ? lessons(d.repoId).slice(-LESSONS_IN_BRIEF) : []);
      const out = await agents.run({ title: `Brief · ${d.title}`, prompt, provider, labels: { source: 'cocopilot', kind: 'brief-writer', work: d.slug }, ...where, timeoutMs: writerMs });
      if (out.status !== 'done') throw new Error(out.error || `the brief writer ended ${out.status}`);
      const brief = cleanBrief(out.finalText);
      if (!brief) throw new Error('the brief writer answered nothing');
      return brief;
    })();
    job.catch(() => {});
    try {
      return { brief: await deadline(job, writerMs) };
    } catch (e) {
      return { brief: null, error: errorMessage(e) };
    }
  }

  // a dispatched agent whose follow-ups get reviewed once its run ends
  function track(run: { agentId: string | null | undefined; slug: string; repoId: string | null; title: string; message: string }) {
    if (!run.agentId || !run.repoId) return;
    writeRuns([...readRuns().filter((r) => r.agentId !== run.agentId), { agentId: run.agentId, slug: run.slug, repoId: run.repoId, title: run.title, message: run.message, at: new Date(now()).toISOString(), reviewed: 0, tries: 0 }]);
  }

  async function judgeLessons(run: Tracked, followUps: string[]) {
    const where = await place(run.slug);
    return judge.decide({ kind: 'brief-lessons', repo: run.repoId, parse: parseLessons, title: `Brief lessons · ${run.title}`, prompt: lessonPrompt(run.message, followUps, lessons(run.repoId)), labels: { source: 'cocopilot', kind: 'brief-lessons', work: run.slug }, ...where, timeoutMs: JUDGE_MS });
  }

  // once the run ended (archived, or idle for an hour), its new follow-ups are judged; an archived run is then forgotten
  async function review(run: Tracked, ended: boolean): Promise<string[]> {
    const h = await agents.history(run.agentId);
    if (!h) return (updateRun(run.agentId, null), []);
    const done = ended || h.archived;
    const quiet = h.status !== 'running' && h.status !== 'initializing' && now() - Date.parse(h.updatedAt || run.at) > idleMs;
    if (!done && !quiet) return [];
    const first = h.userMessages.findIndex((m) => m.text.trim() === run.message.trim());
    const followUps = h.userMessages.slice(first >= 0 ? first + 1 : 1).map((m) => m.text.trim()).filter(Boolean);
    const fresh = followUps.slice(run.reviewed);
    let kept: string[] = [];
    if (fresh.length) {
      try {
        const { output, id } = await judgeLessons(run, fresh);
        kept = addLessons(run.repoId, output, { work: run.slug, agentId: run.agentId, decision: id });
      } catch (e) {
        const tries = run.tries + 1;
        updateRun(run.agentId, tries >= MAX_TRIES ? null : { tries });
        throw e;
      }
    }
    updateRun(run.agentId, done || now() - Date.parse(run.at) > KEEP_MS ? null : { reviewed: followUps.length, tries: 0 });
    return kept;
  }

  const reviewing = new Map<string, Promise<string[]>>();
  const reviewOnce = (run: Tracked, ended: boolean) => {
    const held = reviewing.get(run.agentId);
    if (held) return held;
    const p = review(run, ended).finally(() => reviewing.delete(run.agentId));
    reviewing.set(run.agentId, p);
    return p;
  };

  // Paseo archived this agent
  async function ended(agentId: string) {
    const run = readRuns().find((r) => r.agentId === agentId);
    return run ? reviewOnce(run, true) : [];
  }

  let sweeping = false;
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const run of readRuns()) await reviewOnce(run, false).catch((e) => console.error(`brief lessons of ${run.agentId}: ${errorMessage(e)}`));
    } finally {
      sweeping = false;
    }
  }

  const boot = () => setInterval(() => sweep().catch(() => {}), SWEEP_MS).unref();

  return { write, track, ended, sweep, boot, lessons, addLessons, dropLesson };
}
