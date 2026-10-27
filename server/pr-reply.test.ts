import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commentIdOf, createPrReply } from './pr-reply.ts';
import { createCards } from './cards.ts';
import type { Exec } from './core-types.ts';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pr-reply-test-'));
const comment = { user: 'sentry[bot]', path: 'src/invoices.ts', line: 40, body: 'Possible bug: the target is read with the caller scope.', pr: 'https://api.github.com/repos/acme/widgets/pulls/101' };

const setup = () => {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    const out = (stdout: unknown) => ({ ok: true, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' });
    if (args[1] === 'repos/acme/widgets/pulls/comments/4390452191') return out(comment);
    if (args[1]?.endsWith('/replies')) return out('https://github.com/acme/widgets/pull/101#discussion_r4390452999\n');
    if (args.includes('.data.repository.pullRequest.reviewThreads.nodes')) return out([{ id: 'T_1', isResolved: false, comments: { nodes: [{ databaseId: 4390452191 }] } }]);
    if (args[1] === 'graphql') return out('{}');
    return { ok: false, stdout: '', stderr: 'HTTP 404: Not Found' };
  };
  const told: string[] = [];
  const cards = createCards({ DATA: tmpDir(), place: async () => ({ work: 'w', pr: '101' }), actions: { pr_reply: createPrReply({ githubOf: () => 'acme/widgets', exec }).cardAction }, deliver: async (_a, t) => void told.push(t) });
  return { calls, told, cards };
};

test('a reply card shows the comment it answers and posts the edited text, then resolves the thread, only on approval', async () => {
  const { calls, told, cards } = setup();
  const c = await cards.create({ agentId: 'ag-1', action: { type: 'pr_reply', input: { replyTo: 'https://github.com/acme/widgets/pull/101#discussion_r4390452191', body: 'Intended.', resolve: true } } });
  assert.equal(c.title, 'Reply to sentry[bot] on #101');
  assert.deepEqual(c.fields?.map((f) => [f.key, f.default]), [['body', 'Intended.'], ['resolve', true]]);
  assert.equal(calls.filter((a) => a[1]?.endsWith('/replies')).length, 0);
  const done = await cards.answer(c.id, { approved: true, values: { body: 'Intended, on purpose.', resolve: true } });
  const post = calls.find((a) => a[1]?.endsWith('/replies'));
  assert.deepEqual(post, ['api', 'repos/acme/widgets/pulls/101/comments/4390452191/replies', '-f', 'body=Intended, on purpose.', '--jq', '.html_url']);
  assert.ok(calls.some((a) => a.includes('id=T_1')));
  assert.equal(done.result?.ok, true);
  assert.match(done.result?.detail || '', /posted \(edited\): .*discussion_r4390452999; thread resolved/);
  assert.match(told[0], /Done: posted/);
});

test('a reply card refuses a comment of another PR and posts nothing when dropped', async () => {
  const { calls, cards } = setup();
  await assert.rejects(cards.create({ agentId: 'ag-1', action: { type: 'pr_reply', input: { pr: 102, replyTo: 4390452191, body: 'x' } } }), /replyTo: comment 4390452191 is not on #102/);
  const c = await cards.create({ agentId: 'ag-1', action: { type: 'pr_reply', input: { replyTo: 4390452191, body: 'x' } } });
  await cards.answer(c.id, { approved: false, other: 'shorter' });
  assert.equal(calls.filter((a) => a[1]?.endsWith('/replies')).length, 0);
  assert.equal(commentIdOf('https://github.com/acme/widgets/pull/101#discussion_r4390452191', 'replyTo'), 4390452191);
});
