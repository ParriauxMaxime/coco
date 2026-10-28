// Hand off: an agent whose context fills up writes a briefing for a fresh agent, which starts in the same place (workspace, work, PR, labels, model)
// with that briefing and the owner's note as its first message; the old one is archived once the new one has started.
// An agent that gives no briefing in time (archived, busy, silent) is briefed from the end of its conversation as coco reads it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { TITLE_PREFIX, cocoTitle, timelineOf } from './paseo-agent.ts';
import type { DaemonAgent, DaemonClient } from './paseo-agent.ts';
import type { Models } from './models.ts';
import type { ReadBody, Req, Res, RowKey, Send } from './core-types.ts';

export type HandoffStep = 'summary' | 'starting' | 'done' | 'failed';
// source: who wrote the briefing, the old agent or coco from its transcript
// labels: the new agent's, saved before it starts
export type Handoff = { from: string; fromTitle: string; to: string | null; toTitle: string | null; step: HandoffStep; source: 'agent' | 'transcript' | null; note: string; file: string | null; error: string | null; archived: boolean; at: string; doneAt: string | null; labels?: Record<string, string> };
export type HandoffInput = { note?: unknown; provider?: unknown; thinking?: unknown; mode?: unknown };

type Snapshot = NonNullable<NonNullable<Awaited<ReturnType<DaemonAgent['refresh']>>>['agent']>;
type Deps = {
  DATA: string;
  owner: string;
  defaultModel: string;
  client: () => Promise<Pick<DaemonClient, 'agents'>>;
  say: (agentId: string, text: string) => Promise<unknown>;
  start: (opts: { title: string; prompt: string; labels: Record<string, string>; workspaceId: string | null; cwd: string | null; provider?: string; thinking?: string; mode?: string }) => Promise<{ agentId: string }>;
  archiveWhenDone: (agentId: string, opts?: { timeoutMs?: number }) => Promise<boolean>;
  archive: (agentId: string) => Promise<boolean>;
  // the old agent was archived once the new one started: its plain open questions close
  handedOff?: (agentId: string) => void;
  models?: Pick<Models, 'check' | 'mode'>;
  link?: { linked(): { agentId: string; key: RowKey }[]; linkAgent(a: { agentId: string; workspaceId?: string | null; cwd?: string | null; title?: string | null }): Promise<unknown>; briefed(agentId: string): unknown };
  waitMs?: number;
  pollMs?: number;
};

const WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 3000;
const ARCHIVE_WAIT_MS = 60 * 1000;
const KEEP = 500;
const NOTE_MAX = 4000;
const TRANSCRIPT_TURNS = 16;
const TURN_MAX = 2500;
export const MARK = '[coco hand-off]';
const BLOCK = /<handoff>([\s\S]*?)(?:<\/handoff>|$)/i;
const BUSY: HandoffStep[] = ['summary', 'starting'];
const RESTARTED = 'coco restarted during the hand-off';

const titleOf = (title: string | null | undefined, id: string) => (title || '').replace(TITLE_PREFIX, '').trim() || id.slice(0, 8);

// what the old agent is asked: the paseo-handoff skill's briefing, as its whole reply
export function summaryRequest(owner: string, note: string) {
  return [
    `${MARK} Your context window is nearly full: ${owner} is handing this task to a fresh agent that starts with zero context.`,
    'Stop the task and do not edit files. Reply now with one self-contained briefing for that agent, between <handoff> and </handoff>, in markdown with these sections:',
    '## Task: imperative, with the exact intent (investigate-only stays "do not edit files", a fix stays "implement the fix")',
    '## Context: why the task exists, what the new agent must know',
    '## Relevant files: `path` and what it is, the files you touched first',
    '## Current state: what is done, what works, what does not; uncommitted changes, branches, servers running',
    '## What was tried: each approach and why it failed or was dropped',
    '## Decisions: each decision and its rationale',
    '## Next steps: in order',
    `## Open questions: what is still undecided or waits on ${owner}`,
    '## Constraints: must-not and must-preserve',
    ...(note ? [`${owner}'s note for the new agent, to take into account: ${note}`] : []),
    'Call no tool and open no card for this: the briefing is your whole reply.',
  ].join('\n');
}

// the briefing in the agent's reply to the hand-off request: its <handoff> block, or null
export function briefingOf(entries: { item?: { type: string; text?: string } }[]) {
  const asked = entries.findLastIndex((e) => e.item?.type === 'user_message' && (e.item.text ?? '').includes(MARK));
  if (asked < 0) return null;
  const reply = entries.slice(asked + 1).flatMap((e) => (e.item?.type === 'assistant_message' && e.item.text ? [e.item.text] : [])).join('\n\n');
  const m = reply.match(BLOCK);
  const text = m?.[1].trim() ?? '';
  return text.length > 40 ? text : null;
}

// the end of the conversation, owner and agent turns, the hand-off request left out
export function transcriptOf(entries: { item?: { type: string; text?: string } }[], turns = TRANSCRIPT_TURNS) {
  const said = entries.flatMap((e) => {
    const it = e.item;
    if (!it?.text || (it.type !== 'user_message' && it.type !== 'assistant_message') || it.text.includes(MARK)) return [];
    const text = it.text.trim();
    return [`**${it.type === 'user_message' ? 'Owner' : 'Agent'}:** ${text.length > TURN_MAX ? `${text.slice(0, TURN_MAX)}…` : text}`];
  });
  return said.slice(-turns).join('\n\n');
}

export function firstMessage({ owner, fromTitle, from, source, briefing, note, file }: { owner: string; fromTitle: string; from: string; source: 'agent' | 'transcript'; briefing: string; note: string; file: string }) {
  const lead = source === 'agent'
    ? `You take over a task from another agent ("${fromTitle}", ${from}), handed off to start with a fresh context. It wrote the briefing below for you.`
    : `You take over a task from another agent ("${fromTitle}", ${from}), handed off to start with a fresh context. It gave no briefing in time: below is the end of its conversation, as coco recorded it. Work out the task and where it stands from it.`;
  return [
    lead,
    `Check the current state of the files it names before you act, then carry on. This briefing is saved at ${file}.`,
    '',
    source === 'agent' ? briefing : `## The end of its conversation\n\n${briefing || '(nothing recorded)'}`,
    ...(note ? ['', `## ${owner}'s note`, '', note] : []),
  ].join('\n');
}

export function createHandoff({ DATA, owner, defaultModel, client, say, start, archiveWhenDone, archive, handedOff = () => {}, models, link, waitMs = WAIT_MS, pollMs = POLL_MS }: Deps) {
  const FILE = path.join(DATA, 'handoffs.json');
  const DIR = path.join(DATA, 'handoffs');
  const load = (): Handoff[] => {
    try {
      const list: Handoff[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      // a hand-off cut short by a restart cannot resume; one cut while starting its new agent is looked up in Paseo first (recover)
      return list.map((h) => (h.step === 'summary' ? { ...h, step: 'failed', error: RESTARTED } : h));
    } catch {
      return [];
    }
  };
  const list = load();
  const save = () => {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-KEEP)));
    fs.renameSync(tmp, FILE);
  };
  const update = (h: Handoff, patch: Partial<Handoff>) => {
    Object.assign(h, patch);
    save();
  };
  const of = (agentId: string) => ({ to: list.findLast((h) => h.from === agentId) ?? null, from: list.findLast((h) => h.to === agentId) ?? null });
  // agents whose hand-off is being set up, before its record is listed
  const opening = new Set<string>();
  const cut = new Set(list.filter((h) => h.step === 'starting'));

  // a hand-off cut while starting its new agent: an agent created since with its title and labels is the one it started; none, it failed.
  // Paseo unreachable leaves it starting (no second start), tried again on the next hand-off of that agent
  let recovering: Promise<void> | null = null;
  function recover() {
    recovering ||= (async () => {
      const c = await client();
      if (!c.agents.list) throw new Error('this Paseo client cannot list agents');
      for (const h of [...cut]) {
        const labels = Object.entries(h.labels ?? {}).filter(([, v]) => v !== '');
        const page = await c.agents.list({ includeBackground: true, filter: { labels: Object.fromEntries(labels), includeArchived: true, includeBackground: true }, sort: [{ key: 'updated_at', direction: 'desc' }], page: { limit: 50 } });
        const found = page.entries.map((e) => e.agent).find((a) => a.id !== h.from && a.title === cocoTitle(h.fromTitle) && (a.createdAt ?? '') >= h.at && labels.every(([k, v]) => a.labels?.[k] === v));
        cut.delete(h);
        if (found) await settle(h, found.id, found.workspaceId ?? null, found.cwd ?? null).catch(() => {});
        else update(h, { step: 'failed', error: RESTARTED });
      }
    })().finally(() => (recovering = null));
    return recovering;
  }
  if (cut.size) recover().catch(() => {});

  // the model, thinking and mode picked, else the old agent's own
  async function setupOf(found: Snapshot, input: HandoffInput) {
    const current = found.provider && found.model ? `${found.provider}/${found.model}` : null;
    const picked = models ? await models.check({ provider: input.provider, thinking: input.thinking }, current ?? defaultModel) : {};
    const provider = picked.provider || current || defaultModel;
    const same = provider.split('/')[0] === found.provider;
    const thinking = picked.thinking || (provider === current ? found.thinkingOptionId : null) || undefined;
    const kept = same ? found.currentModeId || null : null;
    const pickMode = async () => {
      if (!models) return (input.mode as string) || kept || undefined;
      if (input.mode) return models.mode(provider, input.mode);
      return kept ? models.mode(provider, kept).catch(() => models.mode(provider, null)) : models.mode(provider, null);
    };
    const mode = await pickMode();
    return { provider, ...(thinking ? { thinking } : {}), ...(mode ? { mode } : {}) };
  }

  // the old agent's briefing, or null once it is archived, fails or stays silent past waitMs
  async function askBriefing(agent: DaemonAgent, from: string, note: string) {
    try {
      await say(from, summaryRequest(owner, note));
    } catch {
      return null;
    }
    const deadline = Date.now() + waitMs;
    for (let left; (left = deadline - Date.now()) > 0; ) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([
        agent.waitForFinish(left).catch((e) => ({ status: 'error', error: errorMessage(e) })),
        new Promise<{ status: string }>((resolve) => (timer = setTimeout(() => resolve({ status: 'timeout' }), left))),
      ]).finally(() => clearTimeout(timer));
      if (r.status !== 'permission') break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
    }
    return briefingOf(await timelineOf(agent, 1).catch(() => []));
  }

  async function run(h: Handoff, agent: DaemonAgent, found: Snapshot, setup: Record<string, string>) {
    try {
      const told = await askBriefing(agent, h.from, h.note);
      const briefing = told ?? transcriptOf(await timelineOf(agent).catch(() => []));
      const source = told ? 'agent' : 'transcript';
      fs.mkdirSync(DIR, { recursive: true });
      const file = path.join(DIR, `${h.from}.md`);
      fs.writeFileSync(file, `# Hand-off from ${h.fromTitle} (${h.from})\n\n${briefing}\n${h.note ? `\n## ${owner}'s note\n\n${h.note}\n` : ''}`);
      // an Ask conversation's agent goes on as a plain agent of its work
      const labels = Object.fromEntries(Object.entries(found.labels ?? {}).filter(([k]) => k !== 'ask'));
      const cwd = found.cwd ?? agent.cwd ?? null;
      const workspaceId = found.workspaceId ?? agent.workspaceId ?? null;
      const prompt = firstMessage({ owner, fromTitle: h.fromTitle, from: h.from, source, briefing, note: h.note, file });
      // saved before the start, so a restart cut here finds the new agent by its title and labels
      update(h, { step: 'starting', source, file, labels });
      const started = await start({ title: h.fromTitle, ...setup, prompt, labels, workspaceId, cwd });
      await settle(h, started.agentId, workspaceId, cwd);
    } catch (e) {
      update(h, { step: 'failed', error: errorMessage(e) });
    }
  }

  // the new agent runs: it takes the old one's PR link, then the old one is archived and its plain questions close
  async function settle(h: Handoff, to: string, workspaceId: string | null, cwd: string | null) {
    update(h, { step: 'done', to, toTitle: h.fromTitle, doneAt: new Date().toISOString() });
    if (link?.linked().some((l) => l.agentId === h.from)) {
      await link.linkAgent({ agentId: to, workspaceId, cwd, title: h.fromTitle }).catch(() => null);
      link.briefed(to);
    }
    const archived = await archiveWhenDone(h.from, { timeoutMs: ARCHIVE_WAIT_MS }).catch(() => false) || (await archive(h.from).catch(() => false));
    update(h, { archived });
    if (archived) handedOff(h.from);
  }

  // starts the hand-off and returns at once; done() resolves when it ends (tests)
  async function begin(from: string, input: HandoffInput) {
    if (opening.has(from)) throw new HttpError(409, 'this agent is already handing off');
    // held from here until the record is listed, so a second click during the awaits below cannot start a second agent
    opening.add(from);
    try {
      const cutShort = of(from).to;
      if (cutShort && cut.has(cutShort)) {
        await recover().catch(() => {});
        if (cut.has(cutShort)) throw new HttpError(409, 'coco restarted while this hand-off was starting its new agent, and Paseo cannot tell yet whether it did: try again once Paseo answers');
      }
      const prior = of(from).to;
      if (prior && BUSY.includes(prior.step)) throw new HttpError(409, 'this agent is already handing off');
      if (prior?.step === 'done') throw new HttpError(409, `this agent was already handed off to ${prior.toTitle ?? prior.to}`);
      const agent = (await client()).agents.ref(from);
      const found = (await agent.refresh())?.agent as Snapshot | undefined;
      if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
      const note = typeof input.note === 'string' ? input.note.trim().slice(0, NOTE_MAX) : '';
      const setup = await setupOf(found, input);
      const h: Handoff = { from, fromTitle: titleOf(found.title, from), to: null, toTitle: null, step: 'summary', source: null, note, file: null, error: null, archived: false, at: new Date().toISOString(), doneAt: null };
      if (prior) list.splice(list.indexOf(prior), 1);
      list.push(h);
      save();
      const done = run(h, agent, found, setup);
      return { handoff: { ...h }, done };
    } finally {
      opening.delete(from);
    }
  }

  // GET /api/agent-chat/<agentId>/handoff · POST /api/agent-chat/<agentId>/handoff {note, provider, thinking, mode}
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const id = parts[1];
    try {
      if (req.method === 'GET') return send(res, 200, of(id));
      if (req.method !== 'POST') return send(res, 404, { error: 'no route' });
      let body: HandoffInput;
      try {
        body = JSON.parse((await readBody(req)) || '{}') || {};
      } catch {
        throw new HttpError(400, 'invalid JSON body');
      }
      const { handoff } = await begin(id, body);
      return send(res, 200, { handoff });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  // the agents hand-offs started
  const successors = () => list.flatMap((h) => (h.to ? [h.to] : []));
  return { begin, of, successors, handle };
}
