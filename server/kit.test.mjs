import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kitPieces } from './kit.mjs';

const kinds = ['body', 'diagram', 'video', 'docs'];
const flags = { body: true, diagram: true, video: false, docs: false };
const head = { sha: 'bbbbbbbbbbbb', at: '2026-10-21T12:00:00Z' };

test('a kit piece made for an older head is stale; a GitHub piece edited after the last commit is fresh; an unexpected piece is off', () => {
  const artifacts = [
    { name: 'pr-7-body.md', meta: { pr: '7', kind: 'body', headSha: 'aaaaaaaaaaa', at: '2026-10-21T13:00:00Z' } },
    { name: 'pr-8-body.md', meta: { pr: '8', kind: 'body', headSha: 'bbbbbbbbbbb', at: '2026-10-21T13:00:00Z' } },
  ];
  const pieces = Object.fromEntries(kitPieces({ kinds, flags, artifacts, n: 7, body: '```mermaid\nflowchart LR\n```', bodyAt: '2026-10-21T12:30:00Z', head }).map((p) => [p.id, p.state]));
  assert.deepEqual(pieces, { body: 'stale', diagram: 'fresh', video: 'off', docs: 'off', notion: 'off' });
  const later = kitPieces({ kinds, flags, artifacts: [], n: 7, body: 'text', bodyAt: '2026-10-21T11:00:00Z', head, links: { docs: { at: '2026-10-21T12:05:00Z' } }, notion: { at: '2026-10-21T12:10:00Z' } });
  assert.deepEqual(later.map((p) => p.state), ['stale', 'missing', 'off', 'fresh', 'fresh']);
});
