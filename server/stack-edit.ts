// propose_stack_edit: add, update, move or remove stack rows of a work without replacing the stack; untouched fields of a row stay (Notion page, gates, kit, workspace).
// Approving can also start the work's Notion sync, which rewrites the linked page's stack table (docs/agent-io.md).
import { keyLabel, parseKey, rowKey } from './stack.ts';
import { list, opt, str, strip } from './cards.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { RowKey, StackRow, Work } from './core-types.ts';

const OPS = ['add', 'update', 'remove'] as const;
const BRANCH = /^[\w][\w./-]*$/;
export type NotionPage = { url: string; title: string };
export type StackOp = {
  op: (typeof OPS)[number];
  row?: RowKey;
  after?: RowKey | 'start';
  pr?: number;
  branch?: string;
  title?: string;
  scope?: string;
  personas?: string[];
  notionPage?: NotionPage | null;
};
export type StackEdit = { work: string; ops: StackOp[]; syncNotion: boolean; why?: string };
type Change = 'added' | 'updated' | 'moved' | 'kept';

const keyOf = (v: unknown, field: string): RowKey => {
  const k = parseKey(v);
  if (k == null) throw new Error(`${field} must be a PR number or "b:<branch>"`);
  return k;
};
const prOf = (v: unknown, field: string) => {
  if (v == null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${field} must be a PR number`);
  return v;
};
export const notionOf = (v: unknown, field: string): NotionPage | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const p = v as Raw;
  const url = str(p?.url, 2000, `${field}.url`);
  if (!/^https:\/\/(www\.)?notion\.(so|site)\//.test(url)) throw new Error(`${field}.url must be a notion.so link`);
  return { url, title: str(p.title, 200, `${field}.title`) };
};

export function opOf(o: Raw, at: string): StackOp {
  const op = OPS.find((x) => x === o?.op);
  if (!op) throw new Error(`${at}.op must be one of ${OPS.join(', ')}`);
  const branch = opt(o.branch, 200, `${at}.branch`);
  if (branch && !BRANCH.test(branch)) throw new Error(`${at}.branch is not a branch name`);
  const personas = o.personas == null ? undefined : list(o.personas, 0, 20, `${at}.personas`).map((p, i) => str(String(p ?? ''), 80, `${at}.personas[${i}]`));
  return strip({
    op,
    row: op === 'add' ? undefined : keyOf(o.row, `${at}.row`),
    after: o.after == null ? undefined : o.after === 'start' ? 'start' : keyOf(o.after, `${at}.after`),
    pr: prOf(o.pr, `${at}.pr`),
    branch,
    title: opt(o.title, 200, `${at}.title`),
    scope: opt(o.scope, 2000, `${at}.scope`),
    personas,
    notionPage: notionOf(o.notionPage, `${at}.notionPage`),
  });
}

// the stack after the ops, in order; each changed row says how. Throws naming the op that cannot apply.
export function applyStackOps(stack: StackRow[], ops: StackOp[]) {
  const rows = stack.map((row) => ({ row, change: 'kept' as Change }));
  const indexOf = (k: RowKey) => rows.findIndex((r) => rowKey(r.row) === k);
  const place = (entry: { row: StackRow; change: Change }, after: StackOp['after'], at: string) => {
    if (after === undefined) return rows.push(entry);
    const i = after === 'start' ? -1 : indexOf(after);
    if (after !== 'start' && i < 0) throw new Error(`${at}.after: no row ${keyLabel(after)} in the stack`);
    rows.splice(i + 1, 0, entry);
  };
  ops.forEach((o, n) => {
    const at = `ops[${n}]`;
    if (o.op === 'add') {
      if (!o.pr && !o.branch) throw new Error(`${at}: an added row needs pr or branch`);
      const row: StackRow = strip({
        number: o.pr ?? null,
        planned: o.title || o.branch ? strip({ title: o.title, branch: o.branch }) : undefined,
        scope: o.scope,
        personas: o.personas ?? [],
        notionPage: o.notionPage ?? undefined,
      });
      const k = rowKey(row);
      if (k == null) throw new Error(`${at}.branch is not a branch name`);
      if (indexOf(k) >= 0) throw new Error(`${at}: ${keyLabel(k)} is already in the stack`);
      return place({ row, change: 'added' }, o.after, at);
    }
    const i = indexOf(o.row as RowKey);
    if (i < 0) throw new Error(`${at}.row: no row ${keyLabel(o.row as RowKey)} in the stack`);
    const [entry] = rows.splice(i, 1);
    if (o.op === 'remove') return;
    const { row } = entry;
    const planned = o.title || o.branch ? { ...row.planned, ...strip({ title: o.title, branch: o.branch }) } : row.planned;
    const next: StackRow = strip({ ...row, number: o.pr ?? row.number, planned, scope: o.scope ?? row.scope, personas: o.personas ?? row.personas, notionPage: o.notionPage === null ? undefined : o.notionPage ?? row.notionPage });
    const k = rowKey(next);
    if (k !== rowKey(row) && k != null && indexOf(k) >= 0) throw new Error(`${at}: ${keyLabel(k)} is already in the stack`);
    const fields = o.pr != null || o.title || o.branch || o.scope != null || o.personas || o.notionPage !== undefined;
    const moved = { row: next, change: (entry.change === 'added' ? 'added' : fields ? 'updated' : o.after !== undefined ? 'moved' : entry.change) as Change };
    if (o.after === undefined) rows.splice(i, 0, moved);
    else place(moved, o.after, at);
  });
  return rows;
}

type Works = { get(slug: string): Work | null | undefined; save(work: Work): unknown };
type Notion = { sync(slug: string): unknown };

export function createStackEdit({ works, notion }: { works: Works; notion?: Notion }) {
  const workOf = (slug: string) => {
    const w = works.get(slug);
    if (!w) throw new Error(`no work ${slug}`);
    return w;
  };
  const editOf = (raw: Raw, fallback: string | null): StackEdit => {
    const work = opt(raw.work, 80, 'work') || fallback;
    if (!work) throw new Error('no work: pass work (the work slug); this agent carries no work label');
    return strip({ work, ops: list(raw.ops ?? [], 0, 40, 'ops').map((o, i) => opOf(o, `ops[${i}]`)), syncNotion: raw.syncNotion === true, why: opt(raw.why, 500, 'why') });
  };
  const linked = (w: Work) => Boolean(notion && w.notion?.pageId);

  const cardAction: ActionDef = {
    card: (raw, ctx) => {
      const input = editOf(raw, ctx.work);
      const w = workOf(input.work);
      if (!input.ops.length && !(input.syncNotion && linked(w))) throw new Error(linked(w) ? 'ops required, or syncNotion: true to only sync Notion' : 'ops required');
      const rows = applyStackOps(w.stack || [], input.ops);
      const removed = input.ops.flatMap((o) => (o.op === 'remove' && o.row != null ? [o.row] : []));
      const tone = { added: 'ok', updated: 'note', moved: 'note', kept: 'mute' } as const;
      const blocks: Raw[] = [];
      if (input.ops.length) {
        blocks.push({ type: 'table', caption: `Stack after the edit${rows.length > 40 ? ' (first 40 rows)' : ''}`, columns: ['#', 'Row', 'Title', 'Reviewers', 'Notion page', 'Change'], rows: rows.slice(0, 40).map(({ row, change }, i) => [String(i + 1), keyLabel(rowKey(row)), row.planned?.title || row.scope || '', (row.personas || []).join(', '), row.notionPage?.title || { text: 'none', tone: 'mute' }, { text: change, tone: tone[change] }]) });
        if (removed.length) blocks.push({ type: 'callout', tone: 'warn', title: 'Removed', text: removed.map(keyLabel).join(', ') });
      }
      if (input.syncNotion && !linked(w)) blocks.push({ type: 'callout', tone: 'warn', title: 'No Notion sync', text: 'This work has no linked Notion page: link one on the work first.' });
      const changes = input.ops.length ? `${input.ops.length} change${input.ops.length > 1 ? 's' : ''}` : 'Notion sync';
      return {
        input,
        card: {
          kind: 'confirm',
          title: `${input.ops.length ? 'Edit stack' : 'Sync Notion'}: ${w.title || w.slug} (${changes})`.slice(0, 120),
          question: input.why,
          blocks: blocks.length ? blocks : [{ type: 'text', text: 'Rewrites the linked Notion page from the work, stack table included.' }],
          fields: linked(w) && input.ops.length ? [{ key: 'syncNotion', label: 'Then sync the linked Notion page', type: 'toggle', default: input.syncNotion }] : undefined,
          confirmLabel: input.ops.length ? 'Apply' : 'Sync Notion',
        },
      };
    },
    run: async (card) => {
      const input = editOf(card.action?.input ?? {}, null);
      const w = workOf(input.work);
      const done: string[] = [];
      if (input.ops.length) {
        const rows = applyStackOps(w.stack || [], input.ops);
        w.stack = rows.map((r) => r.row);
        const counts = (['added', 'updated', 'moved'] as const).map((c) => [c, rows.filter((r) => r.change === c).length] as const).filter(([, n]) => n);
        const removed = input.ops.filter((o) => o.op === 'remove').length;
        const what = [...counts.map(([c, n]) => `${n} ${c}`), ...(removed ? [`${removed} removed`] : [])].join(', ') || 'no change';
        (w.timeline ??= []).unshift({ ts: new Date().toISOString(), kind: 'coco', text: `stack edited (${what}) from agent ${card.agentId.slice(0, 8)}` });
        works.save(w);
        done.push(`stack of ${w.slug}: ${what}`);
      }
      const sync = input.ops.length ? card.answer?.values?.syncNotion === true : input.syncNotion;
      if (sync && notion && linked(w)) {
        const r = (await notion.sync(w.slug)) as { error?: string } | undefined;
        done.push(r?.error ? `Notion sync not started: ${r.error}` : 'Notion sync started (runs in the background)');
      }
      return { ok: true, detail: done.join('; ') || 'nothing to do', link: `#/work/${w.slug}` };
    },
  };
  return { cardAction };
}
