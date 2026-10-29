import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDecisions, summaryRows } from './work-summary.ts';
import type { Work } from './core-types.ts';

const work = (stack: Work['stack'], decisions: Work['decisions'] = []) => ({ slug: 'w', title: 'W', stack, decisions }) as Work;

test('a stack row reads its state, title and CI from the last snapshot, a planned or landed row from the work', () => {
  const w = work([{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }, { planned: { title: 'Later', branch: 'feat/later' } }, { planned: { branch: 'feat/done' }, landed: { sha: 'abc', at: '2026-10-29', by: 'agent' } }]);
  const rows = summaryRows(w, {
    1: { title: 'Merged one', state: 'MERGED', ci: 'success' },
    2: { title: 'Draft', state: 'OPEN', isDraft: true, ci: 'none' },
    3: { state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', ci: 'failure' },
    4: { title: 'Approved', state: 'OPEN', reviewDecision: 'APPROVED' },
  });
  assert.deepEqual(rows.map((r) => [r.key, r.state, r.title, r.ci]), [
    ['1', 'merged', 'Merged one', 'success'],
    ['2', 'draft', 'Draft', null],
    ['3', 'changes', '#3', 'failure'],
    ['4', 'approved', 'Approved', null],
    ['5', 'review', '#5', null],
    ['b:feat:later', 'planned', 'Later', null],
    ['b:feat:done', 'landed', 'feat/done', null],
  ]);
});

test('open decisions leave out taken and archived ones', () => {
  const d = (x: object) => ({ id: 'x', title: 'x', options: [], ...x });
  assert.equal(openDecisions(work([], [d({}), d({ choice: 'a' }), d({ decidedAt: '2026-10-29' }), d({ archivedAt: '2026-10-29' })] as Work['decisions'])), 1);
});
