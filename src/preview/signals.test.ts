import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSignals, byWork, isQuiet, lastStep, ownPart, rowsTotal, workSignals, workTotal } from './signals.ts';
import type { Job, WorkAgent } from '../types.ts';

const agent = (x: Partial<WorkAgent>): WorkAgent => ({ id: 'a', agentId: 'a', askId: null, kind: 'agent', title: 'Fix', pr: null, status: 'running', updatedAt: '2026-10-30T00:00:00Z', openCards: 0, promptTokens: null, systemTokens: null, inputTokens: null, costUsd: null, ...x });
const job = (x: Partial<Job>): Job => ({ id: 'j', work: 'w', pr: null, action: 'x', label: 'Rebase', kind: 'command', state: 'running', agentId: null, startedAt: '2026-10-30T00:00:00Z', endedAt: null, output: '', error: '', ...x });
const wait = (pr: string | null, agentId: string | null = null, work = 'w') => ({ work, pr, agentId });
const work = { slug: 'w', rows: [{ key: '12', state: 'changes', ci: null }, { key: '13', state: 'review', ci: 'failure' }, { key: '14', state: 'draft', ci: 'success' }] };

test('each PR row and the work itself carry their own agents, jobs, waiting items and attention', () => {
  const s = workSignals(work, [agent({ id: 'a1', agentId: 'g1', pr: '12' }), agent({ id: 'a2', agentId: 'g2', pr: null }), agent({ id: 'a3', agentId: 'g3', pr: '14', status: 'done' })], [wait('12', 'g1'), wait('12'), wait('12', null, 'other')], [job({ id: 'j1', pr: '14' }), job({ id: 'j2', pr: '13', state: 'failed' }), job({ id: 'j3', work: 'other' })]);
  assert.deepEqual(s.get('12')?.running.map((a) => a.id), ['a1']);
  assert.equal(s.get('12')?.waiting, 2);
  assert.equal(s.get('12')?.waitingOwn, 1);
  assert.equal(s.get('12')?.attention, true);
  assert.deepEqual(s.get('')?.running.map((a) => a.id), ['a2']);
  assert.deepEqual(s.get('14')?.running.map((a) => a.id), ['j1']);
  assert.equal(s.get('14')?.attention, false);
  assert.equal(s.get('13')?.failed, 1);
  assert.equal(s.get('13')?.attention, true);
});

test('an agent job stops counting once its agent lists, so a starting agent is not counted twice', () => {
  const s = workSignals({ slug: 'w' }, [agent({ id: 'a1', agentId: 'ag1', pr: '12' })], [], [job({ id: 'j1', kind: 'agent', agentId: 'ag1', pr: '12' }), job({ id: 'j2', kind: 'agent', agentId: 'ag2', pr: '12' })]);
  assert.deepEqual(s.get('12')?.running.map((a) => a.id), ['a1', 'j2']);
});

test('a folded work, fold row or repo adds up everything under it', () => {
  const s = workSignals(work, [agent({ id: 'a1', pr: '12' }), agent({ id: 'a2', pr: null })], [wait('13')], [job({ id: 'j2', pr: '13', state: 'lost' })]);
  const total = workTotal(s);
  assert.equal(total.running.length, 2);
  assert.equal(total.waiting, 1);
  assert.equal(total.failed, 1);
  assert.equal(total.attention, true);
  const fold = rowsTotal(s, ['13', '14']);
  assert.deepEqual([fold.running.length, fold.waiting, fold.failed], [0, 1, 1]);
  assert.equal(isQuiet(rowsTotal(s, ['99'])), true);
  assert.equal(addSignals([total, total]).waiting, 2);
});

test('an unfolded row keeps its jobs, its failures and the items no agent row under it shows', () => {
  const s = workSignals({ slug: 'w' }, [agent({ id: 'a1', agentId: 'g1', pr: '12' })], [wait('12', 'g1'), wait('12')], [job({ id: 'j1', pr: '12' }), job({ id: 'j2', pr: '12', state: 'failed' })]);
  const own = ownPart(s.get('12')!);
  assert.deepEqual(own.running.map((a) => a.id), ['j1']);
  assert.equal(own.waiting, 1);
  assert.equal(own.failed, 1);
});

test('jobs and waiting items group by work, those of no work left out', () => {
  const by = byWork([job({ id: 'a', work: 'w' }), job({ id: 'b', work: 'x' }), job({ id: 'c', work: 'w' }), job({ id: 'd', work: null })]);
  assert.deepEqual([...by.keys()], ['w', 'x']);
  assert.deepEqual(by.get('w')?.map((j) => j.id), ['a', 'c']);
});

test('the step a running agent is on is its last tool line, thoughts left out', () => {
  assert.equal(lastStep('[Read] src/a.ts\n[Thought] hmm\n[Shell] npm test\n[Thought] next\nplain text'), 'Shell · npm test');
  assert.equal(lastStep('[Thought] only thinking'), null);
  assert.equal(lastStep(''), null);
});
