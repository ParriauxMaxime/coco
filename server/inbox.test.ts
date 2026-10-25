import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxPrompt } from './inbox.ts';

test("the inbox takes Notion, the repo's GitHub and Slack links, each read with its read-only tool, and nothing else", () => {
  const opts = { github: 'acme/widgets', owner: 'Alice' };
  assert.equal(inboxPrompt('https://www.notion.so/acme/Spec-0123456789abcdef0123456789abcdef', '', opts)?.kind, 'notion');
  assert.equal(inboxPrompt('https://github.com/acme/widgets/issues/42', '', opts)?.kind, 'github');
  const slack = inboxPrompt('https://acme.slack.com/archives/C01ABCDEF/p1712345678123456', 'ask from sales', opts);
  assert.ok(slack);
  assert.equal(slack.kind, 'slack');
  assert.match(slack.prompt, /read-only/);
  assert.match(slack.prompt, /Alice's note: ask from sales/);
  assert.match(slack.prompt, /propose_work_scaffold/);
  assert.equal(inboxPrompt('https://github.com/other/repo/pull/1', '', opts), null);
  assert.equal(inboxPrompt('file:///etc/passwd', '', opts), null);
});
