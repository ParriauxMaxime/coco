// Cards: what an agent shows the owner (post) or asks them (choice, rows, form, confirm), one JSON file each under data/cards/;
// an answer or a dismissal goes back to the agent as a new user message. The contract is docs/agent-io.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cell, validateBlocks } from './blocks.ts';
import type { Block, Cell, Raw } from './blocks.ts';
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';

export const CARD_KINDS = ['post', 'choice', 'rows', 'form', 'confirm'] as const;
export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'toggle'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export type FieldType = (typeof FIELD_TYPES)[number];
export type CardValue = string | number | boolean;
export type CardOption = { key: string; label: string; details?: string; recommended?: boolean; confidence?: number };
export type CardField = { key: string; label: string; type: FieldType; options?: string[]; default?: CardValue; required?: boolean; placeholder?: string };
export type CardRow = { key: string; cells: Cell[]; recommended?: string | boolean };
export type CardAnswer = { at: string; picked?: string[]; rows?: string[]; rowPicks?: Record<string, string>; values?: Record<string, CardValue>; approved?: boolean; other?: string };
export type CardBody = {
  kind: CardKind;
  title: string;
  question?: string;
  blocks?: Block[];
  options?: CardOption[];
  multi?: boolean;
  columns?: string[];
  rows?: CardRow[];
  select?: 'many' | 'one';
  rowOptions?: CardOption[];
  fields?: CardField[];
  confirmLabel?: string;
  rejectLabel?: string;
  other?: boolean;
};
export type CardAction = { type: string; input: Raw };
export type CardResult = { at: string; ok: boolean; detail: string; link?: string };
export type Card = CardBody & {
  id: string;
  agentId: string;
  work: string | null;
  pr: string | null;
  action?: CardAction;
  status: 'open' | 'answered' | 'cancelled';
  createdAt: string;
  answer?: CardAnswer;
  result?: CardResult;
  delivery?: { at: string; ok: boolean; error?: string; skipped?: boolean };
};
type Place = { work: string | null; pr: string | null };
export type ActionContext = Place & { agentId: string };
// a proposal card: card() checks the agent's input and builds the card showing it, run() does what approving it does
export type ActionDef = {
  card(input: Raw, ctx: ActionContext): Promise<{ input: Raw; card: Raw }> | { input: Raw; card: Raw };
  run(card: Card): Promise<Omit<CardResult, 'at'> | null>;
  posted?(card: Card): void;
};
export const SKIPPED = 'skipped';

const KEY = /^[\w.:~-]{1,60}$/;
const ID = /^[\w-]{1,80}$/;
const MAX_OTHER = 2000;

export const strip = <T extends Raw>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
export const str = (v: unknown, max: number, field: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} required`);
  if (v.trim().length > max) throw new Error(`${field} longer than ${max}`);
  return v.trim();
};
export const opt = (v: unknown, max: number, field: string) => (v == null || v === '' ? undefined : str(v, max, field));
export const bool = (v: unknown, field: string) => {
  if (v == null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${field} must be true or false`);
  return v;
};
export const list = (v: unknown, min: number, max: number, field: string): Raw[] => {
  if (!Array.isArray(v) || v.length < min || v.length > max) throw new Error(`${field} must hold ${min}-${max} entries`);
  return v;
};
const key = (v: unknown, field: string) => {
  const k = typeof v === 'number' ? String(v) : v;
  if (typeof k !== 'string' || !KEY.test(k)) throw new Error(`${field} must be a short key (letters, digits, _ . : ~ -)`);
  return k;
};
const unique = (keys: string[], field: string) => {
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice) throw new Error(`${field} holds the key ${twice} twice`);
  return keys;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[], field: string): T => {
  const found = values.find((x) => x === v);
  if (!found) throw new Error(`${field} must be one of ${values.join(', ')}`);
  return found;
};

const option = (o: Raw, at: string): CardOption => {
  if (o?.confidence != null && (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 100)) throw new Error(`${at}.confidence must be 0-100`);
  return strip({ key: key(o?.key, `${at}.key`), label: str(o?.label, 120, `${at}.label`), details: opt(o.details, 500, `${at}.details`), recommended: bool(o.recommended, `${at}.recommended`), confidence: o.confidence });
};
const options = (v: unknown, min: number, max: number, field: string) => {
  const out = list(v, min, max, field).map((o, i) => option(o, `${field}[${i}]`));
  unique(out.map((o) => o.key), field);
  return out;
};

const fieldValue = (f: CardField, v: unknown, at: string): CardValue => {
  if (f.type === 'toggle') {
    if (typeof v !== 'boolean') throw new Error(`${at} must be true or false`);
    return v;
  }
  if (f.type === 'number') {
    const n = typeof v === 'string' && v.trim() ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${at} must be a number`);
    return n;
  }
  if (typeof v !== 'string') throw new Error(`${at} must be text`);
  if (f.type === 'select' && !f.options?.includes(v)) throw new Error(`${at} must be one of ${f.options?.join(', ')}`);
  if (v.length > MAX_OTHER) throw new Error(`${at} longer than ${MAX_OTHER}`);
  return v;
};
const field = (f: Raw, at: string): CardField => {
  const type = oneOf(f?.type, FIELD_TYPES, `${at}.type`);
  const out: CardField = strip({
    key: key(f.key, `${at}.key`),
    label: str(f.label, 120, `${at}.label`),
    type,
    options: type === 'select' ? list(f.options, 1, 20, `${at}.options`).map((o, j) => str(String(o ?? ''), 120, `${at}.options[${j}]`)) : undefined,
    required: bool(f.required, `${at}.required`),
    placeholder: opt(f.placeholder, 120, `${at}.placeholder`),
  });
  return f.default == null || f.default === '' ? out : { ...out, default: fieldValue(out, f.default, `${at}.default`) };
};

const rowsOf = (c: Raw, columns: string[], rowOptions: CardOption[] | undefined): CardRow[] => {
  const rows = list(c.rows, 1, 40, 'rows').map((r, i): CardRow => {
    const at = `rows[${i}]`;
    if (!Array.isArray(r?.cells) || r.cells.length !== columns.length) throw new Error(`${at}.cells must hold ${columns.length} cells`);
    const cells = r.cells.map((x: Raw | string | number, j: number) => cell(x, `${at}.cells[${j}]`));
    if (r.recommended != null && rowOptions && !rowOptions.some((o) => o.key === r.recommended)) throw new Error(`${at}.recommended must be a rowOptions key`);
    return strip({ key: key(r.key, `${at}.key`), cells, recommended: rowOptions ? r.recommended ?? undefined : bool(r.recommended, `${at}.recommended`) });
  });
  unique(rows.map((r) => r.key), 'rows');
  return rows;
};

// what an agent may post: throws on the first bad field, naming it
export function validateCard(c: Raw): CardBody {
  const kind = oneOf(c?.kind, CARD_KINDS, 'kind');
  const head = { kind, title: str(c.title, 120, 'title'), question: opt(c.question, 500, 'question'), blocks: c.blocks == null ? undefined : validateBlocks(c.blocks) };
  if (kind === 'post') {
    if (!head.blocks) throw new Error('blocks required on a post card');
    return strip(head);
  }
  const other = bool(c.other, 'other') ?? kind !== 'form';
  if (kind === 'choice') return strip({ ...head, options: options(c.options, 2, 8, 'options'), multi: bool(c.multi, 'multi'), other });
  if (kind === 'rows') {
    const columns = list(c.columns, 1, 8, 'columns').map((x, i) => str(String(x ?? ''), 60, `columns[${i}]`));
    const rowOptions = c.rowOptions == null ? undefined : options(c.rowOptions, 2, 4, 'rowOptions');
    const select = rowOptions ? undefined : c.select == null ? 'many' : oneOf(c.select, ['many', 'one'] as const, 'select');
    return strip({ ...head, columns, rows: rowsOf(c, columns, rowOptions), select, rowOptions, other });
  }
  if (kind === 'form') return strip({ ...head, fields: fieldsOf(c.fields, 1), other });
  return strip({ ...head, fields: c.fields == null ? undefined : fieldsOf(c.fields, 0), confirmLabel: opt(c.confirmLabel, 40, 'confirmLabel'), rejectLabel: opt(c.rejectLabel, 40, 'rejectLabel'), other });
}

const fieldsOf = (v: unknown, min: number) => {
  const fields = list(v, min, 8, 'fields').map((f, i) => field(f, `fields[${i}]`));
  unique(fields.map((f) => f.key), 'fields');
  return fields;
};

// field values: required ones only when they count (a form, an approval)
const valuesOf = (fields: CardField[], given: unknown, enforce: boolean) => {
  const raw = given ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('values must map field keys to values');
  const stray = Object.keys(raw).find((k) => !fields.some((f) => f.key === k));
  if (stray) throw new Error(`values.${stray} is not a field of this card`);
  const values: Record<string, CardValue> = {};
  for (const f of fields) {
    const v = (raw as Raw)[f.key];
    if (v == null || v === '') {
      if (f.required && enforce) throw new Error(`${f.label} is required`);
    } else values[f.key] = fieldValue(f, v, `values.${f.key}`);
  }
  return values;
};

const keysIn = (v: unknown, known: string[], field: string) => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((k) => !known.includes(k))) throw new Error(`${field} must list keys among ${known.join(', ')}`);
  return [...new Set(v as string[])];
};

// the owner's answer, checked against the card it answers
export function validateAnswer(card: CardBody, a: Raw): Omit<CardAnswer, 'at'> {
  if (a?.other != null && a.other !== '' && !card.other) throw new Error('this card takes no free text');
  const other = opt(a?.other, MAX_OTHER, 'other');
  if (card.kind === 'choice') {
    const picked = keysIn(a.picked, (card.options || []).map((o) => o.key), 'picked');
    if (!card.multi && picked.length > 1) throw new Error('pick one option');
    if (!picked.length && !other) throw new Error('pick an option or write an answer');
    return strip({ picked, other });
  }
  const rowKeys = (card.rows || []).map((r) => r.key);
  if (card.kind === 'rows' && card.rowOptions) {
    const optionKeys = card.rowOptions.map((o) => o.key);
    const picks = a.rowPicks ?? {};
    if (typeof picks !== 'object' || Array.isArray(picks)) throw new Error('rowPicks must map row keys to option keys');
    for (const [k, v] of Object.entries(picks)) if (!rowKeys.includes(k) || !optionKeys.includes(String(v))) throw new Error(`rowPicks.${k} must map a row key to one of ${optionKeys.join(', ')}`);
    if (!Object.keys(picks).length && !other) throw new Error('pick an option on a row or write an answer');
    return strip({ rowPicks: picks as Record<string, string>, other });
  }
  if (card.kind === 'rows') {
    const rows = keysIn(a.rows, rowKeys, 'rows');
    if (card.select === 'one' && rows.length !== 1 && !(other && !rows.length)) throw new Error('tick exactly one row');
    return strip({ rows, other });
  }
  if (card.kind === 'form') return strip({ values: valuesOf(card.fields || [], a.values, true), other });
  if (card.kind === 'confirm') {
    const approved = bool(a.approved, 'approved');
    if (approved == null && !other) throw new Error('approve, reject or write an answer');
    const values = card.fields?.length && approved ? valuesOf(card.fields, a.values, true) : undefined;
    return strip({ approved, values, other });
  }
  throw new Error('a post card takes no answer');
}

const plain = (text: string) => text.replace(/<\/?(risk|warn|ok|note|mute)>/g, '');
const cellText = (c: Cell | undefined) => plain(typeof c === 'string' ? c : c?.text || '');

// the plain-text lines of an answer: picked labels, ticked rows, field values, approved or rejected, the free text
export function answerSummary(card: Card) {
  const a = card.answer;
  if (!a) return '';
  const label = (opts: CardOption[] | undefined, k: string) => opts?.find((o) => o.key === k)?.label ?? k;
  const rowLabel = (k: string) => cellText(card.rows?.find((r) => r.key === k)?.cells[0]) || k;
  const lines: string[] = [];
  if (a.picked?.length) lines.push(`Picked: ${a.picked.map((k) => label(card.options, k)).join(', ')}`);
  if (a.rows) lines.push(a.rows.length ? `Ticked: ${a.rows.map(rowLabel).join(', ')}` : 'Ticked: no row');
  for (const [k, v] of Object.entries(a.rowPicks || {})) lines.push(`${rowLabel(k)}: ${label(card.rowOptions, v)}`);
  if (a.approved != null) lines.push(a.approved ? 'Approved' : 'Rejected');
  for (const f of card.fields || []) if (a.values && f.key in a.values) lines.push(`${f.label}: ${a.values[f.key] === true ? 'yes' : a.values[f.key] === false ? 'no' : a.values[f.key]}`);
  if (a.other) lines.push(`Other: ${a.other}`);
  if (card.result) lines.push(`${card.result.ok ? 'Done' : 'Failed'}: ${card.result.detail}`);
  return lines.join('\n');
}

export function deliveryText(card: Card) {
  if (card.status === 'cancelled') return `[coco card ${card.id} dismissed] ${card.title}\nThe user dismissed this ask without answering.`;
  const r = card.result;
  return `[coco card ${card.id} answered] ${card.title}\n${answerSummary(card)}\n\n\`\`\`json\n${JSON.stringify(r ? { ...card.answer, result: strip({ ok: r.ok, detail: r.detail, link: r.link }) } : card.answer)}\n\`\`\``;
}

// deliver resolves to SKIPPED when nobody waits for the answer (a one-shot run that ended)
type Options = { DATA: string; place?: (agentId: string) => Promise<Place>; deliver: (agentId: string, text: string) => Promise<unknown>; actions?: Record<string, ActionDef> };

export function createCards({ DATA, place = async () => ({ work: null, pr: null }), deliver, actions = {} }: Options) {
  const DIR = path.join(DATA, 'cards');
  fs.mkdirSync(DIR, { recursive: true });
  const cards = new Map<string, Card>();
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const c: Card = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      cards.set(c.id, c);
    } catch {}
  }
  const listeners = new Set<(agentId: string) => void>();
  const now = () => new Date().toISOString();

  const save = (c: Card) => {
    cards.set(c.id, c);
    const file = path.join(DIR, `${c.id}.json`);
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c, null, 1));
    fs.renameSync(tmp, file);
    listeners.forEach((l) => l(c.agentId));
    return c;
  };
  const checked = <T>(make: () => T) => {
    try {
      return make();
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
  };
  const get = (id: string) => {
    const c = cards.get(id);
    if (!c) throw new HttpError(404, 'no such card');
    return c;
  };
  const open = (id: string) => {
    const c = get(id);
    if (c.status !== 'open') throw new HttpError(409, `this card is already ${c.status}`);
    return c;
  };
  const ofAgent = (agentId: string) => [...cards.values()].filter((c) => c.agentId === agentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // with an action, the card is built from it: the agent sends what it proposes, coco shows it
  async function proposal(raw: unknown, ctx: ActionContext) {
    const type = typeof (raw as Raw)?.type === 'string' ? (raw as Raw).type : '';
    const def = actions[type];
    if (!def) throw new HttpError(400, `action.type must be one of ${Object.keys(actions).join(', ')}`);
    try {
      const built = await def.card((raw as Raw).input ?? {}, ctx);
      return { def, action: { type, input: built.input }, body: validateCard(built.card) };
    } catch (e) {
      throw new HttpError(httpStatus(e) === 500 ? 400 : httpStatus(e), errorMessage(e));
    }
  }

  async function create(input: Raw) {
    if (typeof input?.agentId !== 'string' || !ID.test(input.agentId)) throw new HttpError(400, 'agentId required');
    const where = await place(input.agentId).catch(() => ({ work: null, pr: null }));
    const made = input.action == null ? null : await proposal(input.action, { agentId: input.agentId, ...where });
    const body = made ? made.body : checked(() => validateCard(input));
    const c = save({ id: crypto.randomBytes(6).toString('hex'), agentId: input.agentId, work: where.work, pr: where.pr, ...body, ...(made ? { action: made.action } : {}), status: body.kind === 'post' ? 'answered' : 'open', createdAt: now() });
    made?.def.posted?.(c);
    return c;
  }

  async function tell(c: Card) {
    try {
      const r = await deliver(c.agentId, deliveryText(c));
      c.delivery = { at: now(), ok: true, ...(r === SKIPPED ? { skipped: true } : {}) };
    } catch (e) {
      c.delivery = { at: now(), ok: false, error: errorMessage(e).slice(0, 300) };
    }
    return save(c);
  }

  // what approving a proposal does; its outcome goes on the card and in the answer the agent gets
  async function act(c: Card) {
    const def = c.action && actions[c.action.type];
    if (!def || (c.kind === 'confirm' && c.answer?.approved !== true)) return;
    try {
      const r = await def.run(c);
      if (r) c.result = { at: now(), ...r, detail: r.detail.slice(0, 500) };
    } catch (e) {
      c.result = { at: now(), ok: false, detail: errorMessage(e).slice(0, 500) };
    }
    if (c.result) save(c);
  }

  async function answer(id: string, input: Raw) {
    const c = open(id);
    const given = checked(() => validateAnswer(c, input));
    c.status = 'answered';
    c.answer = { at: now(), ...given };
    save(c);
    await act(c);
    return tell(c);
  }

  async function cancel(id: string) {
    const c = open(id);
    c.status = 'cancelled';
    save(c);
    return tell(c);
  }

  // POST /api/cards · GET /api/cards/<id> · POST /api/cards/<id>/answer · POST /api/cards/<id>/cancel · GET /api/agent-chat/<agentId>/cards
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [root, a, b] = parts;
    const body = async (): Promise<Raw> => {
      try {
        return JSON.parse((await readBody(req)) || '{}');
      } catch {
        throw new HttpError(400, 'the body is not JSON');
      }
    };
    try {
      if (root === 'agent-chat' && a && b === 'cards' && req.method === 'GET') return send(res, 200, ofAgent(a));
      if (root === 'cards' && !a && req.method === 'POST') return send(res, 200, await create(await body()));
      if (root === 'cards' && a && !b && req.method === 'GET') return send(res, 200, get(a));
      if (root === 'cards' && a && b === 'answer' && req.method === 'POST') return send(res, 200, await answer(a, await body()));
      if (root === 'cards' && a && b === 'cancel' && req.method === 'POST') return send(res, 200, await cancel(a));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return {
    create,
    get,
    answer,
    cancel,
    ofAgent,
    openCount: (agentId: string) => ofAgent(agentId).filter((c) => c.status === 'open').length,
    handle,
    onChange: (l: (agentId: string) => void) => (listeners.add(l), () => listeners.delete(l)),
  };
}
