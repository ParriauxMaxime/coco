import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimOf, confidenceOf, createFindings, findingKey, githubSourceOf, reviewerOf, reviewSource, settle, severityOf } from './findings.ts';
import type { AgentComment, Work } from './core-types.ts';

const raw = (r: { key: string; path?: string; claim: string }) => ({ n: null, source: 'review-as:bob', body: '', url: null, ...r });

test('a finding dismissed once stays dismissed when the same reviewer raises it again on another line', () => {
  const first = findingKey('review-as:bob', 'a/b.ts', claimOf('### 1. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:100`'));
  const again = findingKey('review-as:bob', 'a/b.ts', claimOf('### 3. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:112`'));
  const other = findingKey('review-as:carol', 'a/b.ts', claimOf('### 3. Medium · PR 1 · Default `true` on the export flag, `a/b.ts:112`'));
  assert.equal(first, again);
  assert.notEqual(first, other);
  const [row] = settle([raw({ key: again, path: 'a/b.ts', claim: 'Default true on the export flag' })], { ledger: { [first]: { status: 'dismissed', at: '2026-10-21', reason: 'decision 4' } } });
  assert.equal(row?.status, 'dismissed');
  assert.equal(row?.dismissed?.reason, 'decision 4');
});

test('an accepted finding shows its comment status and the comment is not listed twice', () => {
  const comment = { id: 'c1', path: 'a/b.ts', startLine: 3, endLine: 3, body: 'Silent error for the customer, is that okay?', status: 'fixed', author: 'bob', createdAt: '2026-10-21' };
  const rows = settle([raw({ key: 'k1', path: 'a/b.ts', claim: claimOf(comment.body) })], { comments: [comment] });
  assert.deepEqual(rows.map((r) => [r.key, r.status, r.commentId]), [['k1', 'fixed', 'c1']]);
});

test("the owner's own comments are local, anyone else's are not", () => {
  const mine = { id: 'c1', path: 'a/b.ts', startLine: 1, endLine: 1, body: 'Rename this.', status: 'open', author: 'alice', createdAt: '2026-10-21' };
  const theirs = { ...mine, id: 'c2', body: 'Split this.', author: 'bob' };
  const rows = settle([], { comments: [mine, theirs], me: 'alice' });
  assert.deepEqual(rows.map((r) => r.source), ['local', 'local:bob']);
});

test('an unanchored issue is a board row without a file', () => {
  const issue = { id: 'c1', kind: 'issue', path: '', startLine: 0, endLine: 0, title: 'Read local head', body: 'coco reads origin', status: 'open', author: 'coco-issue', createdAt: '2026-10-27' };
  const [row] = settle([], { comments: [issue], me: 'alice' });
  assert.deepEqual([row.claim, row.status, row.commentId, row.path, row.source], ['Read local head', 'open', 'c1', '', 'local:coco-issue']);
});

test('claims and severities from both review page shapes', () => {
  assert.equal(claimOf('1. **Check 4 (silent failure)**, `x/y.js:2574`\n   > Silent error for the customer, is that okay?'), 'Check 4 (silent failure): Silent error for the customer, is that okay?');
  assert.equal(severityOf('**Non-blocking.** The export still downloads'), 'minor');
  assert.equal(severityOf('### 1. High · PR 2 · Gate skipped'), 'major');
  assert.equal(reviewSource('2026-10-16-review-as-bobsmith.md'), 'review-as:bobsmith');
  assert.equal(reviewSource('Review-bob', '# Review as Bob Smith (`bobsmith`): stack'), 'review-as:bobsmith');
  assert.equal(reviewSource('x.md', '# Review as carol42 (Carol), front-end only'), 'review-as:carol42');
  assert.equal(reviewSource('review-2026-10-14-151356.md', '# Local review'), 'review-local');
});

test('a review agent comment shows its claim, not its Class / Severity header, and its confidence', () => {
  const body = '**Class:** In-stack bug · **Severity:** major · **Confidence:** 80%\n**Recommendation:** Fix in #42.\n\n`handleExportError` retries the download only.';
  assert.equal(claimOf(body), '`handleExportError` retries the download only');
  assert.equal(confidenceOf(body), 80);
  assert.deepEqual([reviewerOf('review-as:bobsmith'), reviewerOf('local'), reviewerOf('local:opus-review'), reviewerOf('ci')].map((x) => x.group), ['personas', 'me', 'agents', 'ci']);
});

test('bot groups from config name their own reviewer group', () => {
  const bots = { tracker: 'errbot' };
  assert.equal(githubSourceOf('ErrBot-io[bot]', bots), 'tracker');
  assert.equal(githubSourceOf('helper[bot]', bots), 'bot:helper');
  assert.equal(githubSourceOf('bob', bots), 'github:bob');
  assert.equal(reviewerOf('tracker', bots).group, 'tracker');
  assert.equal(reviewerOf('tracker').group, 'agents');
});

// a board on one planned row holding two agent comments; threads records what accept and dismiss send
function board() {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-findings-'));
  const key = 'b:feat:x';
  const stored = [
    { id: 'c1', path: 'a.ts', startLine: 1, endLine: 1, body: 'Null check missing', author: 'agent', status: 'open', createdAt: '2026-10-29' },
    { id: 'c2', path: 'b.ts', startLine: 2, endLine: 2, body: 'Wrong default', author: 'agent', status: 'open', createdAt: '2026-10-29' },
  ];
  const posts: { key: string; text: string; groupId?: string | null }[] = [];
  const released: string[] = [];
  const make = () => createFindings({
    DATA,
    REPO: DATA,
    config: { owner: { login: 'alice' }, repo: { github: 'acme/widgets', reviewsDir: 'reviews' } },
    works: { get: () => ({ slug: 'w', title: 'W', stack: [{ number: null, planned: { branch: 'feat/x', title: 'X' } }] }) as unknown as Work, remark: () => null },
    comments: { list: () => ({ comments: stored as unknown as AgentComment[] }), add: async () => ({ id: 'new' }), update: async () => null },
    code: { ensureRefs: async () => ({ headSha: 'abc' }), prFilesFromGit: async () => [{ filename: 'a.ts' }, { filename: 'b.ts' }] },
    reviewPlan: { planState: () => ({ plan: null, watch: null }), watch: () => null },
    reviewAgent: { worktreeFor: async () => null, rowPr: async () => ({ head: 'feat/x' }) },
    threads: {
      release: async (_slug, k) => (released.push(k), { key: k, outcome: 'none' }),
      post: async (_slug, k, input) => (posts.push({ key: k, text: input.text, groupId: input.groupId }), { groupId: 'g1' }),
    },
  });
  const findings = make();
  const keyOf = async (id: string) => (await findings.collect('w')).rows.find((r) => r.commentId === id)!.key;
  const settled = () => new Promise((ok) => setTimeout(ok, 10));
  return { findings, make, stored, key, posts, released, keyOf, settled };
}

type Served = { rows: unknown[]; stale?: boolean };
const getBoard = async (findings: ReturnType<typeof createFindings>) => {
  let out: Served | null = null;
  await findings.handle({ method: 'GET', url: '/api/works/w/findings' } as never, {} as never, ['works', 'w', 'findings'], async () => '', ((_res: unknown, _status: number, body: Served) => void (out = body)) as never);
  return out as unknown as Served;
};

test('the board GET answers from the saved board at once, refreshes it behind, and its topic says when the refresh differs', async () => {
  const { findings, make, stored, settled } = board();
  const first = await getBoard(findings);
  assert.equal(first.stale, undefined);
  assert.equal(first.rows.length, 2);
  // after a restart: the saved board at once, flagged stale while it is asked again
  const again = make();
  const heard: unknown[] = [];
  again.watch({ send: (json) => void heard.push(JSON.parse(json)), onClose: () => {}, closed: false }, 'w');
  stored.pop();
  const served = await getBoard(again);
  assert.equal(served.stale, true);
  assert.equal(served.rows.length, 2);
  await settled();
  assert.deepEqual(heard, [{ slug: 'w' }]);
  const now = await getBoard(again);
  assert.equal(now.stale, undefined);
  assert.equal(now.rows.length, 1);
});

test('accepting findings starts a fix agent per finding with the note, and releases nothing', async () => {
  const { findings, key, posts, released, keyOf, settled } = board();
  assert.equal(findings.acceptedComment('w', key, 'c1'), false);
  const res = await findings.act('w', { action: 'accept', keys: [await keyOf('c1'), await keyOf('c2')], note: 'keep the API', pr: null });
  await settled();
  assert.equal(res.dispatched, 2);
  assert.deepEqual(posts.map((p) => [p.key, p.groupId]), [[`c.${key.replaceAll(':', '~')}.c1`, undefined], [`c.${key.replaceAll(':', '~')}.c2`, undefined]]);
  assert.match(posts[0].text, /^Accepted: fix this finding\.[\s\S]*\n\nkeep the API$/);
  assert.deepEqual(released, []);
  assert.equal(findings.acceptedComment('w', key, 'c1'), true);
});

test('accepting together puts the findings of a PR in one new agent', async () => {
  const { findings, posts, keyOf, settled } = board();
  await findings.act('w', { action: 'accept', keys: [await keyOf('c1'), await keyOf('c2')], together: true, pr: null });
  await settled();
  assert.deepEqual(posts.map((p) => p.groupId), ['new', 'g1']);
});

test("new inline GitHub comments become findings by their reviewer, once, never the owner's own", async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-findings-gh-'));
  const inline = [
    { id: 101, user: 'bob', body: '**Null check** missing here\nmore', path: 'a.ts', line: 4, original_line: 4, start_line: 2, original_start_line: 2, side: 'RIGHT', commit_id: 'c0ffee', original_commit_id: 'c0ffee', created_at: '2026-10-29', html_url: 'https://github.com/acme/widgets/pull/7#discussion_r101' },
    { id: 102, user: 'alice', body: 'my own note', path: 'a.ts', line: 1, html_url: 'u' },
    { id: 103, user: 'sentry[bot]', body: '[![issue](https://img.shields.io/badge/issue-EF4444)](https://sentry.io)\n\nBug: the [default](https://x.io) is wrong. Severity: high', path: 'b.ts', line: null, original_line: 9, side: 'RIGHT', commit_id: 'new', original_commit_id: 'old', created_at: '2026-10-29', html_url: 'https://github.com/acme/widgets/pull/7#discussion_r103' },
    { id: 104, user: 'alice-gh', body: 'gh user note', path: 'a.ts', line: 1, html_url: 'u' },
    { id: 105, user: 'review-bot', body: 'Posted from a finding', path: 'a.ts', line: 12, side: 'RIGHT', commit_id: 'c0ffee', html_url: 'u' },
  ];
  const exec = async (_cmd: string, args: string[]) => {
    const p = args.find((a) => a.startsWith('repos/')) || args[1];
    const stdout = p === 'user' ? '{"login":"alice-gh"}' : p?.startsWith('repos/acme/widgets/pulls/7/comments') ? inline.map((x) => JSON.stringify(x)).join('\n') : p === 'repos/acme/widgets/pulls/7' ? '"carol"' : args[0] === 'pr' ? '[]' : '';
    return { ok: true, stdout, stderr: '' };
  };
  const stored = [{ id: 'f1', author: 'review-bot', path: 'a.ts', startLine: 10, endLine: 11, status: 'fixed' }] as unknown as AgentComment[];
  const added: Record<string, unknown>[] = [];
  const make = () =>
    createFindings({
      DATA,
      REPO: DATA,
      exec,
      config: { owner: { login: 'alice' }, repo: { github: 'acme/widgets', reviewsDir: 'reviews' } },
      works: { get: () => ({ slug: 'w', title: 'W', stack: [{ number: 7 }] }) as unknown as Work, remark: () => null },
      comments: {
        list: () => ({ comments: stored }),
        add: async (_slug, _n, input) => {
          added.push(input);
          const c = { id: `n${added.length}`, status: 'open', createdAt: '2026-10-29', ...input } as unknown as AgentComment;
          stored.push(c);
          return c;
        },
        update: async () => null,
      },
      code: { ensureRefs: async () => ({ headSha: 'head', mergeBase: 'base' }), prFilesFromGit: async () => [{ filename: 'a.ts' }, { filename: 'b.ts' }] },
      reviewPlan: { planState: () => ({ plan: null, watch: null }), watch: () => null },
      reviewAgent: { worktreeFor: async () => null, rowPr: async () => ({ head: 'feat/x' }) },
      threads: { release: async (_slug, k) => ({ key: k, outcome: 'none' }), post: async () => ({ groupId: null }) },
    });
  const findings = make();
  assert.equal(await findings.importGithub('w'), 2);
  assert.deepEqual(
    added.map((x) => [x.author, x.title, x.severity, x.startLine, x.endLine, x.sha, (x.github as { id: number }).id]),
    [
      ['bob', 'Null check missing here', 'minor', 2, 4, 'c0ffee', 101],
      ['sentry', 'Bug: the default is wrong. Severity: high', 'major', 9, 9, 'old', 103],
    ],
  );
  assert.deepEqual(added[0].sources, [{ label: 'bob on GitHub', url: inline[0].html_url }]);
  // a dismissed or fixed finding is not imported again, nor after a restart
  stored.find((c) => c.author === 'bob')!.status = 'declined';
  assert.equal(await make().importGithub('w'), 0);
  assert.equal(added.length, 2);
  const rows = (await findings.collect('w')).rows.filter((r) => r.path && r.url && r.url !== 'u');
  assert.deepEqual(rows.map((r) => [r.source, r.status, r.url]).sort(), [
    ['bot:sentry', 'open', inline[2].html_url],
    ['github:bob', 'declined', inline[0].html_url],
  ]);
});

test('dismissing a finding releases its agent and starts none', async () => {
  const { findings, posts, released, keyOf, settled } = board();
  await findings.act('w', { action: 'dismiss', keys: [await keyOf('c1')], reason: 'not a bug', pr: null });
  await settled();
  assert.equal(posts.length, 0);
  assert.equal(released.length, 1);
});
