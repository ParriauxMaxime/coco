// Rules ledger: one-line rules in three scopes (global data/rules.json, work.rules, stack[i].rules), injected into every brief and review plan.
// Coco proposes candidates from a chat excerpt or a thread (the Ask path, propose_rules) on a card; the owner keeps or drops each.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseKey, rowKey } from './stack.ts';
import { capitalize } from './review-agent.ts';
import { list, opt, str } from './cards.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { Config } from './config.ts';
import { errorMessage, httpStatus } from './core-types.ts';
import type { ReadBody, Req, Res, Rule, Send, Work } from './core-types.ts';

const STATUSES = ['proposed', 'kept', 'retired'];
const MAX_TEXT = 200;
const MAX_EXCERPT = 12000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface RulesView {
  global: Rule[];
  work?: Rule[];
  prs?: { key: ReturnType<typeof rowKey>; title: string; rules: Rule[] }[];
  proposing?: ProposeState | null;
}

interface ProposeState {
  status: string;
  startedAt: string;
  scope: string;
  pr: string | number | null;
  added: number;
  error: string;
  runId?: string;
  slug?: string;
  source?: string;
  cardId?: string;
}

interface ScopeInput {
  scope?: string;
  pr?: string | number;
}

interface AddInput extends ScopeInput {
  text?: string;
  source?: string;
  status?: string;
}

interface UpdateInput extends ScopeInput {
  status?: string;
  text?: string;
  drop?: boolean;
}

interface ProposeInput extends ScopeInput {
  text?: string;
  threadKey?: string;
}

interface RulesAsk {
  start(input: { prompt: string; workSlug: string }, opts: { once: boolean; onEnd: () => void }): { id: string };
  convOf(agentId: string): { id: string } | null;
}
type Target = { slug: string; scope: string; pr: string | number | null; source: string };

interface RulesWorks {
  get(slug: string): Work | null;
  save(work: Work): unknown;
}

const rule = (text: unknown, source: unknown, status = 'proposed'): Rule => ({ id: crypto.randomBytes(4).toString('hex'), text: String(text).trim().slice(0, MAX_TEXT), source: String(source || '').slice(0, 500), addedAt: new Date().toISOString(), status });

// kept rules of the three scopes, global first
export const keptOf = <R extends { status?: string }>(global: R[], work: { rules?: R[]; stack?: { rules?: R[] }[] }, index?: number | null): (R & { scope: string })[] => [
  ...global.map((r) => ({ ...r, scope: 'global' })),
  ...(work.rules || []).map((r) => ({ ...r, scope: 'work' })),
  ...((index != null && work.stack?.[index]?.rules) || []).map((r) => ({ ...r, scope: 'pr' })),
].filter((r) => r.status === 'kept');

// config.seedRules ([text, source][]) fills the global ledger once, when data/rules.json does not exist yet
export const seedOf = (seedRules: unknown): Rule[] => {
  const entries: unknown[] = Array.isArray(seedRules) ? seedRules : [];
  return entries.filter((s): s is [string, string?] => Array.isArray(s) && String(s[0] || '').trim() !== '').map(([t, s]) => rule(t, s, 'kept'));
};

export function createRules({ DATA, config, works, ask }: { DATA: string; config: Config; works: RulesWorks; ask: RulesAsk }) {
  const file = path.join(DATA, 'rules.json');
  const Owner = capitalize(config.owner.name);
  const readGlobal = (): Rule[] => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seedOf(config.seedRules), null, 1));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const writeGlobal = (list: Rule[]) => fs.writeFileSync(file, JSON.stringify(list, null, 1));
  const proposing = new Map<string, ProposeState>();

  const keptFor = (work: Work, index?: number | null) => keptOf(readGlobal(), work, index);

  // the list a scope lives in, and how to save it back
  function scopeOf(slug: string, scope: string | undefined, pr: string | number | undefined): { list: Rule[]; save: (list: Rule[]) => unknown } {
    if (scope === 'global') return { list: readGlobal(), save: writeGlobal };
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    if (scope === 'work') return { list: work.rules || [], save: (list) => { const fresh = works.get(slug); if (fresh) works.save({ ...fresh, rules: list }); } };
    const n = parseKey(pr);
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (scope !== 'pr' || index < 0) throw new HttpError(400, 'scope must be global, work, or pr with a row key of this work');
    return { list: work.stack[index].rules || [], save: (list) => { const w = works.get(slug); if (!w) return; w.stack[index] = { ...w.stack[index], rules: list }; works.save(w); } };
  }

  function view(slug: string): RulesView {
    const global = readGlobal();
    if (!slug) return { global };
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    return { global, work: work.rules || [], prs: (work.stack || []).map((s, i) => ({ key: rowKey(s), title: s.planned?.title || (s.number ? `#${s.number}` : `PR ${i + 1}`), rules: s.rules || [] })), proposing: proposing.get(slug) || null };
  }

  function add(slug: string, { scope, pr, text, source, status = 'kept' }: AddInput) {
    if (!String(text || '').trim()) throw new HttpError(400, 'text required');
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    const { list, save } = scopeOf(slug, scope, pr);
    save([...list, rule(text, source, status)]);
    return view(slug);
  }

  // status change, text edit, or drop (a proposed rule the owner does not want leaves no trace)
  function update(slug: string, id: string, { scope, pr, status, text, drop }: UpdateInput) {
    const { list, save } = scopeOf(slug, scope, pr);
    const r = list.find((x) => x.id === id);
    if (!r) throw new HttpError(404, 'no such rule');
    if (drop) save(list.filter((x) => x.id !== id));
    else {
      if (status !== undefined && !STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
      save(list.map((x) => (x.id === id ? { ...x, ...(status ? { status } : {}), ...(text ? { text: String(text).trim().slice(0, MAX_TEXT) } : {}) } : x)));
    }
    return view(slug);
  }

  function threadExcerpt(slug: string, key: string) {
    const f = path.join(DATA, 'works', slug, 'threads', `${key}.json`);
    if (!/^[\w.~-]+$/.test(String(key)) || !fs.existsSync(f)) throw new HttpError(404, 'no such thread');
    const thread: { messages: { role: string; text: string }[] } = JSON.parse(fs.readFileSync(f, 'utf8'));
    return thread.messages.map((m) => `${m.role === 'user' ? Owner : m.role}: ${m.text}`).join('\n\n');
  }

  // a headless coco run reads the excerpt and the ledger, and ends with propose_rules; candidates land as "proposed" in the asked scope
  function propose(slug: string, { text, threadKey, scope = 'work', pr }: ProposeInput) {
    if (proposing.get(slug)?.status === 'running') throw new HttpError(409, 'coco is already proposing rules for this work');
    scopeOf(slug, scope, pr);
    const excerpt = (threadKey ? threadExcerpt(slug, threadKey) : String(text || '')).slice(0, MAX_EXCERPT);
    if (!excerpt.trim()) throw new HttpError(400, 'text or threadKey required');
    const known = view(slug);
    const ledger = [...known.global, ...(known.work || []), ...(known.prs || []).flatMap((p) => p.rules)].filter((r) => r.status !== 'retired').map((r) => `- ${r.text}`);
    const prompt = [
      'Distill rules for my rules ledger from the excerpt below: corrections I made to an agent, or rules I stated, that should hold for every future brief and review.',
      'One line each, plain English, imperative, reusable beyond this PR. Skip one-off fixes and anything already in the ledger. End with exactly one propose_rules call; no rule is fine (empty list).',
      '',
      'Ledger today:',
      ...(ledger.length ? ledger : ['(empty)']),
      '',
      'Excerpt:',
      '',
      excerpt,
    ].join('\n');
    const state: ProposeState = { status: 'running', startedAt: new Date().toISOString(), scope, pr: pr ?? null, added: 0, error: '', slug, ...(threadKey ? { source: `thread ${threadKey}` } : {}) };
    proposing.set(slug, state);
    const run = ask.start({ prompt, workSlug: slug }, {
      once: true,
      onEnd: () => Object.assign(state, { status: 'done', error: state.cardId ? '' : 'coco ended without proposing' }),
    });
    state.runId = run.id;
    return view(slug);
  }

  const scopeName = (t: Target) => (t.scope === 'global' ? 'global' : t.scope === 'work' ? `${t.slug} work` : `PR ${t.pr} of ${t.slug}`);

  // propose_rules: a card with one row per candidate, Keep or Drop; the kept ones go to the ledger of the run's scope
  const cardAction: ActionDef = {
    card: (raw, ctx) => {
      const runId = ask.convOf(ctx.agentId)?.id;
      const run = [...proposing.values()].find((s) => runId && s.runId === runId);
      const target: Target = run ? { slug: run.slug ?? '', scope: run.scope, pr: run.pr, source: run.source || 'chat excerpt' } : { slug: ctx.work || '', scope: ctx.work ? 'work' : 'global', pr: null, source: `agent ${ctx.agentId.slice(0, 8)}` };
      const rules = list(raw.rules ?? [], 0, 6, 'rules').map((r, i) => ({ text: str(r?.text, MAX_TEXT, `rules[${i}].text`), source: opt(r?.source, 500, `rules[${i}].source`) ?? '' }));
      const input = { rules, target };
      const title = rules.length ? `Rules for the ${scopeName(target)} ledger` : 'No new rule';
      if (!rules.length) return { input, card: { kind: 'post', title, blocks: [{ type: 'text', text: 'coco found no correction or stated rule that the ledger lacks.' }] } };
      return {
        input,
        card: {
          kind: 'rows',
          title,
          question: 'Keep or drop each one. Kept rules go into every future brief and review plan.',
          columns: ['Rule', 'From'],
          rows: rules.map((r, i) => ({ key: `r${i}`, cells: [r.text, { text: r.source || target.source, tone: 'mute' }], recommended: 'keep' })),
          rowOptions: [{ key: 'keep', label: 'Keep' }, { key: 'drop', label: 'Drop' }],
        },
      };
    },
    run: async (card) => {
      const input: Raw = card.action?.input ?? {};
      const t: Target = input.target;
      const picks = card.answer?.rowPicks ?? {};
      const kept: { text: string; source: string }[] = (input.rules ?? []).filter((_: unknown, i: number) => picks[`r${i}`] === 'keep');
      if (!Object.keys(picks).length) return null;
      if (kept.length) {
        const { list: rules, save } = scopeOf(t.slug, t.scope, t.pr ?? undefined);
        save([...rules, ...kept.map((r) => rule(r.text, r.source || t.source, 'kept'))]);
      }
      const dropped = Object.values(picks).filter((v) => v === 'drop').length;
      return { ok: true, detail: `${kept.length} kept in the ${scopeName(t)} rules, ${dropped} dropped`, link: t.slug ? `#/work/${t.slug}/rules` : '#/rules' };
    },
    posted: (card) => {
      const runId = ask.convOf(card.agentId)?.id;
      const run = [...proposing.values()].find((s) => runId && s.runId === runId);
      if (run) Object.assign(run, { cardId: card.id, added: card.rows?.length ?? 0 });
    },
  };

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      // /api/rules[/<id>] (global page) or /api/works/<slug>/rules[/<id>|/propose]
      const work = parts[0] === 'works';
      const slug = work ? parts[1] : '';
      const sub = work ? parts[3] : parts[1];
      const body = async <T>(): Promise<T> => JSON.parse((await readBody(req)) || '{}');
      if (req.method === 'GET') return send(res, 200, view(slug));
      if (req.method === 'POST' && sub === 'propose') return send(res, 200, propose(slug, await body<ProposeInput>()));
      if (req.method === 'POST' && !sub) {
        const b = await body<AddInput>();
        return send(res, 200, add(slug, { ...b, scope: work ? b.scope : 'global' }));
      }
      if (req.method === 'PUT' && sub) {
        const b = await body<UpdateInput>();
        return send(res, 200, update(slug, sub, { ...b, scope: work ? b.scope : 'global' }));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, keptFor, view, cardAction };
}
