// propose_pr_reply: a reply drafted by an agent for a PR comment (a review comment's thread, else the PR conversation), shown on a card
// whose text the owner edits; only pressing Post reply posts it, with gh, and can resolve the thread (docs/agent-io.md).
import { bool, opt, str } from './cards.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { Exec } from './core-types.ts';

const MAX_BODY = 20000;
export type PrReply = { github: string; pr: number; replyTo?: number; body: string; resolve: boolean; why?: string };
type Comment = { user: string; path: string | null; line: number | null; body: string; pr: string };

// a review comment id, or its URL (…#discussion_r<id>, …/comments/<id>)
export const commentIdOf = (v: unknown, field: string) => {
  if (v == null || v === '') return undefined;
  const m = String(v).match(/(?:discussion_r|comments\/)?(\d{4,})\s*$/);
  if (!m) throw new Error(`${field} must be a review comment id or its URL`);
  return Number(m[1]);
};

export const prOf = (v: unknown, fallback: string | null) => {
  const n = Number(String(v ?? fallback ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error('pr required: the PR number');
  return n;
};

export function createPrReply({ githubOf, exec }: { githubOf: (work: string | null) => string | null | undefined; exec: Exec }) {
  const gh = async (args: string[]) => {
    const r = await exec('gh', args);
    if (!r.ok) throw new Error(r.stderr.trim().split('\n').pop() || `gh ${args[0]} failed`);
    return r.stdout;
  };

  const replyOf = (raw: Raw, ctx: { work: string | null; pr: string | null }): PrReply => {
    const github = opt(raw.github, 200, 'github') || githubOf(ctx.work);
    if (!github) throw new Error('no GitHub repo: pass github (owner/name)');
    return { github, pr: prOf(raw.pr, ctx.pr), replyTo: commentIdOf(raw.replyTo, 'replyTo'), body: str(raw.body, MAX_BODY, 'body'), resolve: bool(raw.resolve, 'resolve') ?? false, why: opt(raw.why, 500, 'why') };
  };

  async function commentOf(r: PrReply): Promise<Comment> {
    const out = await gh(['api', `repos/${r.github}/pulls/comments/${r.replyTo}`, '--jq', '{user: .user.login, path, line: (.line // .original_line), body, pr: .pull_request_url}']).catch(() => {
      throw new Error(`replyTo: no review comment ${r.replyTo} in ${r.github}`);
    });
    const c = JSON.parse(out) as Comment;
    if (!c.pr.endsWith(`/pulls/${r.pr}`)) throw new Error(`replyTo: comment ${r.replyTo} is not on #${r.pr}`);
    return c;
  }

  async function resolveThread(r: PrReply) {
    const [owner, name] = r.github.split('/');
    const query = 'query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}';
    const threads = JSON.parse(await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${r.pr}`, '--jq', '.data.repository.pullRequest.reviewThreads.nodes'])) as { id: string; isResolved: boolean; comments: { nodes: { databaseId: number }[] } }[];
    const thread = threads.find((t) => t.comments.nodes[0]?.databaseId === r.replyTo);
    if (!thread) return 'thread not found, not resolved';
    if (thread.isResolved) return 'thread already resolved';
    await gh(['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-f', `id=${thread.id}`]);
    return 'thread resolved';
  }

  const cardAction: ActionDef = {
    card: async (raw, ctx) => {
      const input = replyOf(raw, ctx);
      const c = input.replyTo ? await commentOf(input) : null;
      const blocks: Raw[] = c
        ? [{ type: 'callout', tone: 'note', title: `${c.user}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}`, text: c.body.length > 1500 ? `${c.body.slice(0, 1500)}…` : c.body }]
        : [{ type: 'text', text: `A new comment in the conversation of #${input.pr}.` }];
      return {
        input,
        card: {
          kind: 'confirm',
          title: `${c ? `Reply to ${c.user}` : 'Comment'} on #${input.pr}`.slice(0, 120),
          question: input.why,
          blocks,
          fields: [
            { key: 'body', label: 'Reply', type: 'textarea', default: input.body, required: true },
            ...(c ? [{ key: 'resolve', label: 'Then resolve the thread', type: 'toggle', default: input.resolve }] : []),
          ],
          confirmLabel: 'Post reply',
          rejectLabel: 'Drop',
        },
      };
    },
    run: async (card) => {
      const input = replyOf(card.action?.input ?? {}, { work: null, pr: null });
      const body = str(card.answer?.values?.body ?? input.body, MAX_BODY, 'body');
      const url = input.replyTo
        ? await gh(['api', `repos/${input.github}/pulls/${input.pr}/comments/${input.replyTo}/replies`, '-f', `body=${body}`, '--jq', '.html_url'])
        : await gh(['api', `repos/${input.github}/issues/${input.pr}/comments`, '-f', `body=${body}`, '--jq', '.html_url']);
      const resolved = input.replyTo && card.answer?.values?.resolve === true ? `; ${await resolveThread(input)}` : '';
      return { ok: true, detail: `posted${body !== input.body ? ' (edited)' : ''}: ${url.trim()}${resolved}`, link: url.trim() };
    },
  };
  return { cardAction };
}
