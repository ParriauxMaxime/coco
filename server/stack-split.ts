// propose_split: one card that wires coco and GitHub after an agent split a PR into parts (branches and PRs already exist or are planned):
// the original row becomes N rows in place (Notion page on the first part), GitHub bases follow the chain, then optional row pages and PR body refreshes.
// Each step reports on its own, so a partial failure shows and a re-approval redoes only what is left (docs/agent-io.md).
import { keyLabel, parseKey, rowKey } from './stack.ts';
import { applyStackOps } from './stack-edit.ts';
import type { StackOp } from './stack-edit.ts';
import { list, opt, str, strip } from './cards.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { Exec, PrInfo, RowKey, StackRow, Work } from './core-types.ts';
import type { Change } from './works.ts';

const BRANCH = /^[\w][\w./-]*$/;
export type Part = { title: string; branch: string; files?: string[]; scope?: string; existingPr?: number };
export type Split = { work: string; pr: RowKey; parts: Part[]; why?: string };
type Step = { step: string; ok: boolean; detail: string };

const partOf = (p: Raw, at: string): Part => {
  const branch = str(p?.branch, 200, `${at}.branch`);
  if (!BRANCH.test(branch)) throw new Error(`${at}.branch is not a branch name`);
  if (p.existingPr != null && (!Number.isInteger(p.existingPr) || (p.existingPr as number) < 1)) throw new Error(`${at}.existingPr must be a PR number`);
  const files = p.files == null ? undefined : list(p.files, 0, 200, `${at}.files`).map((f, i) => str(String(f ?? ''), 300, `${at}.files[${i}]`));
  return strip({ title: str(p.title, 200, `${at}.title`), branch, files, scope: opt(p.scope, 2000, `${at}.scope`), existingPr: p.existingPr as number | undefined });
};
export const partKey = (p: Part): RowKey => (p.existingPr ?? rowKey({ planned: { branch: p.branch } } as StackRow)) as RowKey;

export function splitOf(raw: Raw, fallback: string | null): Split {
  const work = opt(raw.work, 80, 'work') || fallback;
  if (!work) throw new Error('no work: pass work (the work slug); this agent carries no work label');
  const pr = parseKey(raw.pr);
  if (pr == null) throw new Error('pr must be the PR number (or "b:<branch>") of the row to split');
  const parts = list(raw.parts, 2, 12, 'parts').map((p, i) => partOf(p, `parts[${i}]`));
  const keys = parts.map(partKey);
  if (new Set(keys).size < keys.length || new Set(parts.map((p) => p.branch)).size < parts.length) throw new Error('parts must have distinct branches and PRs');
  return strip({ work, pr, parts, why: opt(raw.why, 500, 'why') });
}

// the stack ops of a split: the original row replaced in place by the parts in order; a part that reuses the original PR keeps the row's fields,
// the first part takes the original's Notion page, every part inherits its reviewers
export function splitOps(stack: StackRow[], s: Pick<Split, 'pr' | 'parts'>): StackOp[] {
  const i = stack.findIndex((r) => rowKey(r) === s.pr);
  if (i < 0) throw new Error(`pr: no row ${keyLabel(s.pr)} in the stack`);
  const orig = stack[i];
  const ops: StackOp[] = [];
  if (!s.parts.some((p) => partKey(p) === s.pr)) ops.push({ op: 'remove', row: s.pr });
  let after: RowKey | 'start' = i ? (rowKey(stack[i - 1]) as RowKey) : 'start';
  s.parts.forEach((p, k) => {
    const key = partKey(p);
    ops.push(key === s.pr
      ? strip({ op: 'update' as const, row: s.pr, after, scope: p.scope, notionPage: k && orig.notionPage ? null : undefined })
      : strip({ op: 'add' as const, after, pr: p.existingPr, branch: p.existingPr ? undefined : p.branch, title: p.existingPr ? undefined : p.title, scope: p.scope, personas: orig.personas || [], notionPage: k ? undefined : orig.notionPage }));
    after = key;
  });
  return ops;
}

// every part is a row and the original is gone or reused: a retry only redoes the later steps
const applied = (stack: StackRow[], s: Split) => s.parts.every((p) => stack.some((r) => rowKey(r) === partKey(p))) && (s.parts.some((p) => partKey(p) === s.pr) || !stack.some((r) => rowKey(r) === s.pr));

type Deps = {
  works: { get(slug: string): Work | null | undefined; save(work: Work): unknown; prInfo(n: number | null | undefined, fresh?: boolean): Promise<PrInfo>; dropPr?(n: number): void; changed?(slug: string, what?: Change): void };
  exec: Exec;
  github?: (slug: string) => string | null | undefined;
  defaultBranch: string;
  notion?: { sync(slug: string, opts?: { rowPages?: { row: string; title: string }[] }): unknown };
  // the /lem-pr body gate dispatch entry (e.g. gate:kit-body:lem-pr), and a way to post a dispatch card for it
  bodyEntry?: string | null;
  queue?: (agentId: string, input: Raw) => Promise<unknown>;
};

export function createStackSplit({ works, exec, github, defaultBranch, notion, bodyEntry, queue }: Deps) {
  const workOf = (slug: string) => {
    const w = works.get(slug);
    if (!w) throw new Error(`no work ${slug}`);
    return w;
  };
  const linked = (w: Work) => Boolean(notion && w.notion?.pageId);
  const branchOf = async (row: StackRow | undefined) => (row?.number ? (await works.prInfo(row.number)).head : row?.planned?.branch) || null;
  // on the stack after the split: the first part sits on the row below it (else the default branch), each next part on the previous part's branch, and the row after the last part on that part
  async function chain(stack: StackRow[], parts: Part[]) {
    const i = stack.findIndex((r) => rowKey(r) === partKey(parts[0]));
    const base = (await branchOf(stack[i - 1])) || defaultBranch;
    // the next part sits on the real head of the previous part's PR, which must be the branch the agent named
    const heads: string[] = [];
    for (const p of parts) {
      if (p.existingPr) {
        const head = (await works.prInfo(p.existingPr)).head;
        if (head !== p.branch) throw new Error(`#${p.existingPr} has head ${head ?? 'unknown'} on GitHub, not ${p.branch}`);
        heads.push(head);
      } else heads.push(p.branch);
    }
    const bases = parts.map((p, k) => ({ pr: p.existingPr, base: k ? heads[k - 1] : base }));
    for (const b of bases) if (!BRANCH.test(b.base)) throw new Error(`${b.base} is not a branch name`);
    const after = stack[i + parts.length];
    return { bases, next: after?.number ? { pr: after.number, base: heads.at(-1)! } : null };
  }

  const cardAction: ActionDef = {
    card: async (raw, ctx) => {
      const input = splitOf(raw, ctx.work);
      const w = workOf(input.work);
      const again = applied(w.stack, input);
      const rows = again ? w.stack : applyStackOps(w.stack, splitOps(w.stack, input)).map((r) => r.row);
      const { bases, next } = await chain(rows, input.parts);
      const orig = again ? rows.find((r) => rowKey(r) === partKey(input.parts[0])) as StackRow : w.stack.find((r) => rowKey(r) === input.pr) as StackRow;
      const blocks: Raw[] = [{ type: 'table', caption: `The row ${keyLabel(input.pr)} becomes ${input.parts.length} rows, in place`, columns: ['#', 'Row', 'Title', 'GitHub base', 'Files', 'Notion page'], rows: input.parts.map((p, k) => [String(k + 1), p.existingPr ? `#${p.existingPr}` : { text: `${p.branch} (planned)`, tone: 'mute' }, p.title, bases[k].base, p.files?.length ? `${p.files.length} files` : '', k === 0 ? orig.notionPage?.title || { text: 'none', tone: 'mute' } : { text: 'new', tone: 'note' }]) }];
      if (next) blocks.push({ type: 'text', text: `#${next.pr}, the row after, is rebased on ${next.base} on GitHub.` });
      if (!input.parts.some((p) => partKey(p) === input.pr)) blocks.push({ type: 'callout', tone: 'warn', title: `${keyLabel(input.pr)} leaves the stack`, text: 'No part reuses it: close it or pass it as a part\'s existingPr.' });
      const missing = input.parts.filter((p) => !p.existingPr).map((p) => p.branch);
      if (missing.length) blocks.push({ type: 'callout', tone: 'note', title: 'Planned rows', text: `${missing.join(', ')}: no PR yet, so no GitHub base to fix until you open it.` });
      blocks.push({ type: 'text', text: `${rows.length} rows after the split; every other row keeps its fields.` });
      const fields = [...(linked(w) ? [{ key: 'notionRows', label: 'Create Notion pages for the new rows', type: 'toggle', default: true }] : []), ...(bodyEntry && queue ? [{ key: 'bodies', label: 'Then refresh PR bodies (one dispatch card each)', type: 'toggle', default: true }] : [])];
      return { input, card: { kind: 'confirm', title: `Split ${keyLabel(input.pr)} into ${input.parts.length}: ${w.title || w.slug}`.slice(0, 120), question: input.why, blocks, fields: fields.length ? fields : undefined, confirmLabel: 'Split' } };
    },
    run: async (card) => {
      const input = splitOf(card.action?.input ?? {}, null);
      const w = workOf(input.work);
      const gh = github?.(w.slug);
      const steps: Step[] = [];
      const step = async (name: string, fn: () => Promise<string> | string) => {
        try {
          steps.push({ step: name, ok: true, detail: await fn() });
        } catch (e) {
          steps.push({ step: name, ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
      };
      const keys = input.parts.map(partKey);
      await step('stack', () => {
        if (applied(w.stack, input)) return 'already split';
        const rows = applyStackOps(w.stack || [], splitOps(w.stack || [], input));
        w.stack = rows.map((r) => r.row);
        (w.timeline ??= []).unshift({ ts: new Date().toISOString(), kind: 'coco', text: `${keyLabel(input.pr)} split into ${input.parts.map((p) => p.existingPr ? `#${p.existingPr}` : p.branch).join(', ')} from agent ${card.agentId.slice(0, 8)}` });
        works.save(w);
        return `${keyLabel(input.pr)} replaced by ${input.parts.length} rows`;
      });
      if (!steps[0].ok) return { ok: false, detail: steps.map((s) => `${s.step}: ${s.detail}`).join('; ') };

      const { bases, next } = await chain(w.stack, input.parts).catch((e) => (steps.push({ step: 'bases', ok: false, detail: e instanceof Error ? e.message : String(e) }), { bases: [], next: null }));
      const edits = [...bases.filter((b) => b.pr).map((b) => ({ pr: b.pr as number, base: b.base })), ...(next ? [next] : [])];
      for (const e of edits) {
        await step(`base #${e.pr}`, async () => {
          const cur = (await works.prInfo(e.pr, true).catch(() => null))?.base;
          if (cur === e.base) return `already on ${e.base}`;
          const r = await exec('gh', ['pr', 'edit', String(e.pr), ...(gh ? ['--repo', gh] : []), '--base', e.base]);
          if (!r.ok) throw new Error(r.stderr.trim().split('\n').pop() || 'gh pr edit failed');
          works.dropPr?.(e.pr);
          works.changed?.(w.slug, 'stack');
          return `base set to ${e.base}`;
        });
      }

      const fresh = workOf(w.slug);
      const rowPages = input.parts.map((p, k) => ({ row: String(keys[k]), title: p.title, page: fresh.stack.find((r) => rowKey(r) === keys[k])?.notionPage })).filter((p) => !p.page).map(({ row, title }) => ({ row, title }));
      if (card.answer?.values?.notionRows === true && linked(fresh) && rowPages.length) {
        await step('notion', async () => {
          const r = (await notion?.sync(fresh.slug, { rowPages })) as { error?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return `Notion sync started for ${rowPages.length} new page${rowPages.length > 1 ? 's' : ''} (runs in the background)`;
        });
      }
      if (card.answer?.values?.bodies === true && bodyEntry && queue) {
        for (const p of input.parts.filter((x) => x.existingPr)) {
          await step(`body #${p.existingPr}`, async () => {
            await queue(card.agentId, { workSlug: fresh.slug, entry: bodyEntry, pr: p.existingPr, why: `Refresh the body of #${p.existingPr} after splitting ${keyLabel(input.pr)}` });
            return 'dispatch card posted';
          });
        }
      }
      const bad = steps.filter((s) => !s.ok);
      const detail = steps.map((s) => `${s.step}: ${s.ok ? '' : 'FAILED '}${s.detail}`).join('; ');
      return { ok: !bad.length, detail: bad.length ? `${detail}. Approve a new propose_split with the same parts to retry the failed steps.` : detail, link: `#/work/${fresh.slug}` };
    },
  };
  return { cardAction };
}
