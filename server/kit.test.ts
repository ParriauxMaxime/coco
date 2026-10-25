import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKit, kitPieces } from './kit.ts';

const kinds = ['body', 'diagram', 'video', 'docs'];
const flags = { body: true, diagram: true, video: false, docs: false };
const head = { sha: 'bbbbbbbbbbbb', at: '2026-10-21T12:00:00Z' };

test('a kit piece made for an older head is stale; a GitHub piece edited after the last commit is fresh; an unexpected piece is off', () => {
  const artifacts = [
    { name: 'pr-7-body.md', meta: { pr: '7', kind: 'body', headSha: 'aaaaaaaaaaa', at: '2026-10-21T11:30:00Z' } },
    { name: 'pr-8-body.md', meta: { pr: '8', kind: 'body', headSha: 'bbbbbbbbbbb', at: '2026-10-21T13:00:00Z' } },
  ];
  const pieces = Object.fromEntries(kitPieces({ kinds, flags, artifacts, n: 7, body: '```mermaid\nflowchart LR\n```', bodyAt: '2026-10-21T12:30:00Z', head }).map((p) => [p.id, p.state]));
  assert.deepEqual(pieces, { body: 'stale', diagram: 'fresh', video: 'off', docs: 'off', notion: 'off' });
  const later = kitPieces({ kinds, flags, artifacts: [], n: 7, body: 'text', bodyAt: '2026-10-21T11:00:00Z', head, links: { docs: { at: '2026-10-21T12:05:00Z' } }, notion: { at: '2026-10-21T12:10:00Z' } });
  assert.deepEqual(later.map((p) => p.state), ['stale', 'missing', 'off', 'fresh', 'fresh']);
});

const BODY_AT = '2026-10-22T19:00:00Z';
const work = { slug: 'w', stack: [{ number: 7 }], links: [] };
// pr: { sha, commits: [[authoredDate, committedDate]] }; patchIds: { [sha]: patch-id }, none = the sha is not in the clone
type KitPr = { sha: string; commits: string[][] };
const kitFor = (DATA: string, pr: KitPr, patchIds: Record<string, string>, artifacts: { name: string; meta: { pr: string; kind: string; headSha: string; at: string } }[] = []) =>
  createKit({
    REPO: '/repo',
    DATA,
    config: { repo: { github: 'o/r', defaultBranch: 'main' }, kitKinds: ['body', 'diagram', 'video'] },
    works: { get: () => work, listArtifacts: () => artifacts },
    exec: async (cmd, args) => {
      const last = args.at(-1) ?? '';
      if (cmd === 'sh') return { ok: true, stdout: patchIds[last] ? `${patchIds[last]} ${last}\n` : '' };
      const commits = pr.commits.map(([authoredDate, committedDate]) => ({ commit: { authoredDate, committedDate } }));
      return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { body: 'text\n```mermaid\nflowchart LR\n```', lastEditedAt: BODY_AT, headRefOid: pr.sha, baseRefOid: 'base', commits: { nodes: commits } } } } }) };
    },
  });
const states = async (kit: ReturnType<typeof createKit>) => Object.fromEntries((await kit.view('w', '7')).pieces.map((p) => [p.id, p.state]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));

test('a rebase keeps the body, diagram and artifacts fresh: same own change, new sha and commit date', async () => {
  const DATA = tmp();
  assert.deepEqual(await states(kitFor(DATA, { sha: 'old1', commits: [['2026-10-22T18:00:00Z', '2026-10-22T18:00:00Z']] }, { old1: 'P' })), { body: 'fresh', diagram: 'fresh', video: 'missing', notion: 'off' });
  const video = [{ name: 'demo.mp4', meta: { pr: '7', kind: 'video', headSha: 'old1', at: '2026-10-22T18:30:00Z' } }];
  const rebased = kitFor(DATA, { sha: 'new1', commits: [['2026-10-22T18:00:00Z', '2026-10-23T10:00:00Z']] }, { new1: 'P' }, video);
  assert.deepEqual(await states(rebased), { body: 'fresh', diagram: 'fresh', video: 'fresh', notion: 'off' });
});

test('a commit that changes the PR own diff after the body makes it stale, even once rebased', async () => {
  const DATA = tmp();
  await states(kitFor(DATA, { sha: 'old1', commits: [['2026-10-22T18:00:00Z', '2026-10-22T18:00:00Z']] }, { old1: 'P' }));
  const moved = { sha: 'new2', commits: [['2026-10-22T18:00:00Z', '2026-10-23T10:00:00Z'], ['2026-10-23T09:00:00Z', '2026-10-23T10:00:00Z']] };
  assert.deepEqual(await states(kitFor(DATA, moved, { new2: 'Q' })), { body: 'stale', diagram: 'stale', video: 'missing', notion: 'off' });
});

test('without a patch-id, a piece is compared to the last authored commit, not the last committed one', async () => {
  const rebasedOnly = { sha: 'x', commits: [['2026-10-22T18:00:00Z', '2026-10-23T10:00:00Z']] };
  assert.equal((await states(kitFor(tmp(), rebasedOnly, {}))).body, 'fresh');
  const authoredAfter = { sha: 'y', commits: [['2026-10-22T18:00:00Z', '2026-10-23T10:00:00Z'], ['2026-10-23T09:00:00Z', '2026-10-23T10:00:00Z']] };
  assert.equal((await states(kitFor(tmp(), authoredAfter, {}))).body, 'stale');
  const DATA = tmp();
  assert.equal((await states(kitFor(DATA, authoredAfter, { y: 'Q' }))).body, 'stale');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'kit-patch-ids.json'), 'utf8'))['7'], { heads: { y: 'Q' } });
});
