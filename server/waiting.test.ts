import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWaiting } from './waiting.ts';
import type { Card } from './cards.ts';

const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, agentId: `ag-${id}`, work: 'w', pr: '7', kind: 'choice', title: `card ${id}`, question: 'Which one?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], other: true, status: 'open', createdAt: '2026-10-20T10:00:00Z', ...extra });
const queued = (key: string, extra: Record<string, unknown> = {}) => ({ key, pr: '7', title: `thread ${key}`, link: `#/t/${key}`, busy: false, agentLast: true, code: false, at: '2026-10-20T11:00:00Z', text: 'Done: want me to dismiss it?', asks: 0, suggestion: null, ...extra });
const conv = (id: string, extra: Record<string, unknown> = {}) => ({ id, prompt: `question ${id}\nmore`, workSlug: 'w', pr: null, kind: 'ask', status: 'idle', turns: 2, text: 'Shall I go on?', agentIds: [`agent-${id}`], lastActivity: '2026-10-20T12:00:00Z', ...extra });

const perm = (agentId: string, id: string, extra: Record<string, unknown> = {}) => ({ agentId, agentTitle: `coco · ${agentId}`, request: { id, kind: 'tool', name: 'Bash', title: 'npm test' }, since: '2026-10-20T09:00:00Z', where: null, work: 'w', pr: '7', ...extra });

type Setup = { cards?: Card[]; queue?: ReturnType<typeof queued>[]; asks?: ReturnType<typeof conv>[]; perms?: ReturnType<typeof perm>[]; ready?: { commit: string; subject: string; stat: string } | null; DATA?: string; archived?: boolean; at?: string };
const make = ({ cards = [], queue = [], asks = [], perms = [], ready = null, DATA, archived, at = '2026-10-21T12:00:00Z' }: Setup = {}) =>
  createWaiting({
    DATA,
    now: () => Date.parse(at),
    works: { list: () => [{ slug: 'w', title: 'W', archived }, { slug: 'other', title: 'Other' }] },
    cards: { open: () => cards.filter((c) => c.status === 'open') },
    threads: { queue: (slug) => (slug === 'w' ? queue : []), ready: async () => ready },
    ask: { list: () => asks },
    permissions: { list: () => perms },
  });
const ids = async (w: ReturnType<typeof make>, slug?: string) => (await w.view(slug)).items.map((i) => i.id);

test("an agent's last word left two days unanswered stops waiting on you; its open card does not", async () => {
  const card = { id: 'c1', agentId: 'agent-a1', work: 'w', pr: null, kind: 'confirm', title: 'Go?', question: 'Go?', status: 'open', createdAt: '2026-10-20T10:00:00Z' } as unknown as Card;
  const w = make({ asks: [conv('a2')], queue: [queued('k1')], cards: [card], at: '2026-10-23T12:00:00Z' });
  assert.deepEqual(await ids(w), ['card:c1']);
});

test('an open choice card is a card item with its options as buttons, a reply and a dismiss; answered and cancelled ones are not listed', async () => {
  const w = make({ cards: [card('c1'), card('c2', { status: 'answered' }), card('c3', { status: 'cancelled' })] });
  const { items, count } = await w.view();
  assert.equal(count, 1);
  const [i] = items;
  assert.deepEqual([i.id, i.kind, i.work, i.pr, i.title, i.excerpt], ['card:c1', 'card', 'w', '7', 'card c1', 'Which one?']);
  assert.deepEqual(i.actions.map((a) => [a.kind, a.label]), [['pick', 'A'], ['pick', 'B'], ['reply', 'Send'], ['dismiss', 'Dismiss']]);
  assert.deepEqual(i.actions[0], { id: 'pick:a', kind: 'pick', label: 'A', url: '/api/cards/c1/answer', body: { picked: ['a'] } });
  assert.equal(i.actions[2].field, 'other');
  assert.equal(i.actions[3].url, '/api/cards/c1/cancel');
});

test('a confirm card offers approve and reject, a multi-choice or form card only a link and a dismiss', async () => {
  const w = make({ cards: [card('k', { kind: 'confirm', options: undefined, other: false }), card('m', { multi: true, other: false }), card('f', { kind: 'form', other: false })] });
  const by = Object.fromEntries((await w.view()).items.map((i) => [i.id, i.actions.map((a) => a.id)]));
  assert.deepEqual(by['card:k'], ['approve', 'reject', 'dismiss']);
  assert.deepEqual(by['card:m'], ['dismiss']);
  assert.deepEqual(by['card:f'], ['dismiss']);
});

test('a card with an external effect (action, thread, option effect) gets Open and Dismiss, no inline Approve or pick', async () => {
  const effect = { type: 'x' } as never;
  const w = make({ cards: [
    card('k', { kind: 'confirm', options: undefined, other: false }),
    card('a', { kind: 'confirm', options: undefined, other: false, action: { type: 'pr_reply', input: {} } }),
    card('t', { thread: 'c.7.aa11' }),
    card('e', { options: [{ key: 'a', label: 'A', effect }], other: true }),
  ] });
  const by = Object.fromEntries((await w.view()).items.map((i) => [i.id, i.actions.map((a) => a.id)]));
  assert.deepEqual(by['card:k'], ['approve', 'reject', 'dismiss']);
  for (const id of ['card:a', 'card:t', 'card:e']) assert.deepEqual(by[id], ['open', 'dismiss']);
});

test('ack takes at most 100 ids of 200 chars and prunes acks older than 30 days', () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'));
  let t = Date.parse('2026-01-01T00:00:00Z');
  const w = createWaiting({ DATA, now: () => t, works: { list: () => [] }, cards: { open: () => [] }, threads: { queue: () => [], ready: async () => null }, ask: { list: () => [] } });
  assert.throws(() => w.ack(Array.from({ length: 101 }, (_, i) => `i${i}`)), /at most 100/);
  assert.throws(() => w.ack(['x'.repeat(201)]), /200 chars/);
  w.ack(['old']);
  t += 31 * 24 * 3600 * 1000;
  w.ack(['new']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'waiting-acks.json'), 'utf8'))), ['new']);
});

test('a cc-group thread whose agent has the last word is a question; one still running, with no reply, or with an open card is not', async () => {
  const w = make({ queue: [queued('c.7.aa11'), queued('c.7.bb22', { busy: true }), queued('c.7.cc33', { agentLast: false }), queued('c.7.dd44', { asks: 1 }), queued('c.7.ee55', { text: '' })] });
  const { items } = await w.view();
  assert.deepEqual(items.map((i) => i.id), ['thread:w:c.7.aa11']);
  const [i] = items;
  assert.deepEqual([i.kind, i.work, i.pr, i.key, i.link, i.excerpt], ['thread', 'w', '7', 'c.7.aa11', '#/t/c.7.aa11', 'Done: want me to dismiss it?']);
  assert.deepEqual(i.actions.map((a) => [a.kind, a.url]), [['reply', '/api/works/w/threads/c.7.aa11'], ['ack', '/api/waiting/ack']]);
});

test('an open suggestion is an Approve item with the ready commit named; approve and dismiss call the suggestion route', async () => {
  const suggestion = { msg: 'm1', kind: 'commit', commit: 'abcdef1234', files: ['a.ts'] };
  const w = make({ queue: [queued('c.7.aa11', { suggestion, code: true })], ready: { commit: 'abcdef1234', subject: 'Fix the null', stat: '1 file changed' } });
  const [i] = (await w.view()).items;
  assert.equal(i.kind, 'approve');
  assert.match(i.excerpt, /^commit abcdef1 ready: Fix the null \(1 file changed\)\./);
  assert.deepEqual(i.actions[0], { id: 'open', kind: 'open', label: 'Open', url: '#/t/c.7.aa11' });
  assert.deepEqual(i.actions.slice(1, 3).map((a) => [a.kind, a.url, a.body]), [['approve', '/api/works/w/threads/c.7.aa11/suggestions/m1', { action: 'approve' }], ['dismiss', '/api/works/w/threads/c.7.aa11/suggestions/m1', { action: 'dismiss' }]]);
  const card = make({ queue: [queued('d.x', { suggestion: { msg: 'm2', kind: 'card' }, pr: null })] });
  assert.match((await card.view()).items[0].excerpt, /^card change ready/);
});

test('an Ask chat is a question once its agent is idle or parked after a turn; a running, closed, one-shot or still empty one is not', async () => {
  const w = make({ asks: [conv('a1'), conv('a2', { status: 'parked' }), conv('a3', { status: 'running' }), conv('a4', { status: 'closed' }), conv('a5', { once: true }), conv('a6', { turns: 0 }), conv('a7', { workSlug: null })] });
  assert.deepEqual((await ids(w)).sort(), ['ask:a1', 'ask:a2', 'ask:a7']);
  const i = (await w.view()).items.find((x) => x.id === 'ask:a1');
  assert.deepEqual([i?.title, i?.link, i?.actions[0].url], ['question a1', '#/work/w/ask-a1', '/api/ask/a1/messages']);
  assert.equal((await w.view()).items.find((x) => x.id === 'ask:a7')?.link, '#/ask/a7');
});

test('an Ask chat whose agent has an open card shows the card, not the chat', async () => {
  const w = make({ asks: [conv('a1', { agentIds: ['ag-c1'] })], cards: [card('c1')] });
  assert.deepEqual(await ids(w), ['card:c1']);
});

test('items group by work for the per-work view, newest first, and archived works are left out', async () => {
  const w = make({ cards: [card('c1', { work: 'other' }), card('c2', { createdAt: '2026-10-21T10:00:00Z' })], queue: [queued('c.7.aa11')], asks: [conv('a1')] });
  assert.deepEqual(await ids(w), ['card:c2', 'ask:a1', 'thread:w:c.7.aa11', 'card:c1']);
  assert.deepEqual((await ids(w, 'other')), ['card:c1']);
  assert.equal((await w.view('w')).count, 3);
  assert.deepEqual(await ids(make({ cards: [card('c1')], archived: true })), []);
});

test('dismissing a question hides it until the agent speaks again; the ack survives a restart', async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-'));
  const asks = [conv('a1')];
  const w = make({ asks, queue: [queued('c.7.aa11')], DATA });
  assert.equal((await w.view()).count, 2);
  w.ack(['ask:a1', 'thread:w:c.7.aa11']);
  assert.equal((await w.view()).count, 0);
  assert.equal((await make({ asks, queue: [queued('c.7.aa11')], DATA }).view()).count, 0);
  const later = make({ asks: [conv('a1', { lastActivity: new Date(Date.now() + 60000).toISOString() })], DATA });
  assert.deepEqual(await ids(later), ['ask:a1']);
  assert.throws(() => w.ack('x'), /ids must list/);
});

test('the queue is cached until something touches it, and a watcher hears the change', async () => {
  let n = 0;
  const open: Card[] = [];
  const w = createWaiting({ works: { list: () => [{ slug: 'w', title: 'W' }] }, cards: { open: () => (n++, open) }, threads: { queue: () => [], ready: async () => null }, ask: { list: () => [] } });
  await w.view();
  await w.view();
  assert.equal(n, 1);
  const sent: string[] = [];
  const closers: (() => void)[] = [];
  await w.watch({ send: (j) => void sent.push(j), onClose: (f) => void closers.push(f), closed: false });
  assert.equal(sent.length, 1);
  open.push(card('c1'));
  w.touch();
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(sent[1]).count, 1);
  closers.forEach((f) => f());
});

test('a pending Paseo permission is an item of its agent and work, opened where the agent shows; byAgent and byWork count every kind', async () => {
  const w = make({
    cards: [card('c1', { agentId: 'A' })],
    perms: [perm('B', 'r1'), perm('C', 'r2', { work: null, pr: null }), perm('D', 'r3', { work: 'gone' })],
    queue: [queued('c.7.aa11', { agentId: 'A', suggestion: { msg: 'm1', kind: 'card' } })],
    asks: [conv('a1')],
  });
  const v = await w.view();
  const p = v.items.find((i) => i.id === 'perm:B:r1');
  assert.deepEqual([p?.kind, p?.agentId, p?.work, p?.pr, p?.title, p?.excerpt, p?.link], ['permission', 'B', 'w', '7', 'Allow Bash', 'coco · B · npm test', '#/agents/B/waiting']);
  assert.equal(v.items.find((i) => i.id === 'perm:C:r2')?.work, null);
  assert.ok(!v.items.some((i) => i.id === 'perm:D:r3'), 'a permission of a work no longer live is left out');
  assert.equal(v.count, 5);
  assert.deepEqual(v.byAgent, { A: 2, B: 1, C: 1, 'agent-a1': 1 });
  assert.deepEqual(v.byWork, { w: 4 });
  assert.deepEqual((await w.view('w')).byAgent, { A: 2, B: 1, 'agent-a1': 1 });
});

test('one thing counts once: a question asked both as a card and through Paseo is the card; an agent held on a permission is not also waiting for your word', async () => {
  const w = make({
    cards: [card('c1', { agentId: 'A' })],
    perms: [
      perm('A', 'q1', { request: { id: 'q1', kind: 'question', name: 'AskUserQuestion' } }),
      perm('A', 'q2', { request: { id: 'q2', kind: 'tool', name: 'mcp__cocopilot__ask' } }),
      perm('A', 't1'),
      perm('B', 'q3', { request: { id: 'q3', kind: 'question', name: 'AskUserQuestion', title: 'Which base?' } }),
      perm('T', 't2'),
    ],
    asks: [conv('a1', { agentIds: ['B'] })],
    queue: [queued('c.7.aa11', { agentId: 'T' }), queued('c.7.bb22', { agentId: 'U' })],
  });
  const v = await w.view();
  assert.deepEqual(v.items.map((i) => i.id).sort(), ['card:c1', 'perm:A:t1', 'perm:B:q3', 'perm:T:t2', 'thread:w:c.7.bb22']);
  assert.equal(v.items.find((i) => i.id === 'perm:B:q3')?.title, 'Which base?');
  assert.deepEqual(v.byAgent, { A: 2, B: 1, T: 1, U: 1 });
});
