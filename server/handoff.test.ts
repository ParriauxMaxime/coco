import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARK, briefingOf, createHandoff, transcriptOf } from './handoff.ts';
import type { DaemonClient } from './paseo-agent.ts';

const OLD = 'old-agent-1';
const NEW = 'new-agent-2';
type Item = { type: string; text?: string };

// a Paseo agent mid-task: its timeline, what it was sent; reply is what it answers the hand-off request with (null: it stays silent)
function setup({ reply = null as string | null, archived = false, known = true, linked = false } = {}) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-handoff-'));
  const items: Item[] = [
    { type: 'user_message', text: 'Make the CSV export stream rows' },
    { type: 'assistant_message', text: 'I changed server/export.ts to stream; the test for empty files still fails.' },
    { type: 'user_message', text: 'Keep the header row' },
    { type: 'assistant_message', text: 'Header kept. Next: the empty-file test.' },
  ];
  const sent: string[] = [];
  const started: Record<string, unknown>[] = [];
  const archivedIds: string[] = [];
  const linkedTo: unknown[] = [];
  const agent = {
    id: OLD,
    cwd: '/wt/csv',
    workspaceId: 'wks_csv',
    timeline: { subscribe: () => Object.assign(() => {}, {}), refetch: async () => ({ entries: items.map((item) => ({ item })), hasOlder: false }) },
    send: async () => {},
    // silent: the turn never ends within the wait
    waitForFinish: (ms?: number) => (reply === null ? new Promise((r) => setTimeout(() => r({ status: 'timeout' }), (ms ?? 0) + 50)) : Promise.resolve({ status: 'idle' })),
    refresh: async () => (known ? { agent: { title: 'coco · CSV streaming', status: archived ? 'closed' : 'idle', provider: 'claude', model: 'opus', thinkingOptionId: 'high', currentModeId: 'auto', cwd: '/wt/csv', workspaceId: 'wks_csv', labels: { source: 'cocopilot', kind: 'agent', work: 'csv', pr: '101', ask: 'q1' } } } : null),
    archive: async () => {},
  };
  const client = async () => ({ agents: { ref: () => agent } }) as unknown as Pick<DaemonClient, 'agents'>;
  const handoff = createHandoff({
    DATA,
    owner: 'Max',
    defaultModel: 'claude/sonnet',
    client,
    say: async (_id, text) => {
      if (archived) throw new Error('this agent is archived');
      sent.push(text);
      items.push({ type: 'user_message', text });
      if (reply) items.push({ type: 'assistant_message', text: reply });
    },
    start: async (opts) => (started.push(opts), { agentId: NEW }),
    archiveWhenDone: async (id) => (archivedIds.push(id), true),
    archive: async () => false,
    link: { linked: () => (linked ? [{ agentId: OLD, key: 101 }] : []), linkAgent: async (a) => void linkedTo.push(a), briefed: (id) => linkedTo.push(`briefed ${id}`) },
    waitMs: 30,
    pollMs: 5,
  });
  return { DATA, handoff, sent, started, archivedIds, linkedTo };
}

test('the old agent is asked for a briefing; its <handoff> block starts the new agent in the same place, then the old one is archived', async () => {
  const briefing = '## Task\nStream the CSV export.\n## Current state\nThe empty-file test fails.\n## Next steps\nFix it.';
  const { DATA, handoff, sent, started, archivedIds, linkedTo } = setup({ reply: `Here it is.\n<handoff>\n${briefing}\n</handoff>`, linked: true });
  const { handoff: h, done } = await handoff.begin(OLD, { note: 'Run the full suite before you commit' });
  assert.equal(h.step, 'summary');
  await done;
  assert.equal(sent.length, 1);
  assert.ok(sent[0].startsWith(MARK) && sent[0].includes('Run the full suite'));
  assert.equal(started.length, 1);
  const s = started[0];
  assert.deepEqual({ title: s.title, provider: s.provider, thinking: s.thinking, mode: s.mode, workspaceId: s.workspaceId, cwd: s.cwd }, { title: 'CSV streaming', provider: 'claude/opus', thinking: 'high', mode: 'auto', workspaceId: 'wks_csv', cwd: '/wt/csv' });
  assert.deepEqual(s.labels, { source: 'cocopilot', kind: 'agent', work: 'csv', pr: '101' });
  assert.ok(String(s.prompt).includes(briefing) && String(s.prompt).includes("## Max's note") && String(s.prompt).includes('Run the full suite'));
  assert.deepEqual(archivedIds, [OLD]);
  assert.deepEqual(linkedTo, [{ agentId: NEW, workspaceId: 'wks_csv', cwd: '/wt/csv', title: 'CSV streaming' }, `briefed ${NEW}`]);
  const { to } = handoff.of(OLD);
  assert.equal(to?.step, 'done');
  assert.equal(to?.source, 'agent');
  assert.equal(to?.to, NEW);
  assert.equal(to?.archived, true);
  assert.equal(handoff.of(NEW).from?.from, OLD);
  assert.ok(fs.readFileSync(String(to?.file), 'utf8').includes(briefing));
  assert.ok(String(to?.file).startsWith(DATA));
});

test('an old agent silent past the wait is briefed from the end of its conversation, and the hand-off still happens', async () => {
  const { handoff, started, archivedIds } = setup({ reply: null });
  await (await handoff.begin(OLD, {})).done;
  const { to } = handoff.of(OLD);
  assert.equal(to?.step, 'done');
  assert.equal(to?.source, 'transcript');
  const prompt = String(started[0].prompt);
  assert.match(prompt, /gave no briefing in time/);
  assert.match(prompt, /\*\*Owner:\*\* Make the CSV export stream rows/);
  assert.match(prompt, /\*\*Agent:\*\* Header kept/);
  assert.ok(!prompt.includes(MARK), 'the hand-off request is left out');
  assert.deepEqual(archivedIds, [OLD]);
});

test('an archived old agent cannot write a briefing: coco briefs the new one from its transcript', async () => {
  const { handoff, sent, started } = setup({ archived: true });
  await (await handoff.begin(OLD, {})).done;
  assert.deepEqual(sent, []);
  assert.equal(handoff.of(OLD).to?.source, 'transcript');
  assert.match(String(started[0].prompt), /Keep the header row/);
});

test('a reply without a <handoff> block falls back to the transcript', async () => {
  const { handoff } = setup({ reply: 'Sure, I will write it later.' });
  await (await handoff.begin(OLD, {})).done;
  assert.equal(handoff.of(OLD).to?.source, 'transcript');
});

test('one hand-off per agent; an agent Paseo does not know is refused', async () => {
  const { handoff } = setup({ reply: '<handoff>## Task\nDo the thing, all of it, carefully.</handoff>' });
  const first = await handoff.begin(OLD, {});
  await assert.rejects(handoff.begin(OLD, {}), (e: Error & { status?: number }) => e.status === 409);
  await first.done;
  await assert.rejects(handoff.begin(OLD, {}), /already handed off/);
  await assert.rejects(setup({ known: false }).handoff.begin(OLD, {}), (e: Error & { status?: number }) => e.status === 404);
});

test('a hand-off cut short by a restart reads as failed', async () => {
  const { DATA } = setup();
  fs.writeFileSync(path.join(DATA, 'handoffs.json'), JSON.stringify([{ from: OLD, fromTitle: 'x', to: null, toTitle: null, step: 'summary', source: null, note: '', file: null, error: null, archived: false, at: '2026-10-01', doneAt: null }]));
  const again = createHandoff({ DATA, owner: 'Max', defaultModel: 'claude/sonnet', client: async () => ({}) as Pick<DaemonClient, 'agents'>, say: async () => {}, start: async () => ({ agentId: NEW }), archiveWhenDone: async () => true, archive: async () => true });
  assert.equal(again.of(OLD).to?.step, 'failed');
});

test('briefingOf reads only the reply after the hand-off request; transcriptOf keeps the last turns', () => {
  const entries = [
    { item: { type: 'assistant_message', text: '<handoff>an old block, long enough to count as one</handoff>' } },
    { item: { type: 'user_message', text: `${MARK} write it` } },
    { item: { type: 'assistant_message', text: 'Briefing:' } },
    { item: { type: 'assistant_message', text: '<handoff>## Task\nThe new one, long enough to count.' } },
  ];
  assert.equal(briefingOf(entries), '## Task\nThe new one, long enough to count.');
  assert.equal(briefingOf(entries.slice(0, 1)), null);
  const many = Array.from({ length: 30 }, (_, i) => ({ item: { type: i % 2 ? 'assistant_message' : 'user_message', text: `turn ${i}` } }));
  const t = transcriptOf(many, 4);
  assert.equal(t.split('\n\n').length, 4);
  assert.match(t, /turn 26/);
  assert.doesNotMatch(t, /turn 25/);
});
