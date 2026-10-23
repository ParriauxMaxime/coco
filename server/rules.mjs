// Rules ledger: one-line rules in three scopes (global data/rules.json, work.rules, stack[i].rules), injected into every brief and review plan.
// Coco proposes candidates from a chat excerpt or a thread (the Ask path, propose_rules); the owner keeps or drops each.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseKey, rowKey } from './stack.mjs';
import { capitalize } from './review-agent.mjs';

const STATUSES = ['proposed', 'kept', 'retired'];
const MAX_TEXT = 200;
const MAX_EXCERPT = 12000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const rule = (text, source, status = 'proposed') => ({ id: crypto.randomBytes(4).toString('hex'), text: String(text).trim().slice(0, MAX_TEXT), source: String(source || '').slice(0, 500), addedAt: new Date().toISOString(), status });

// kept rules of the three scopes, global first
export const keptOf = (global, work, index) => [
  ...global.map((r) => ({ ...r, scope: 'global' })),
  ...(work.rules || []).map((r) => ({ ...r, scope: 'work' })),
  ...((index != null && work.stack?.[index]?.rules) || []).map((r) => ({ ...r, scope: 'pr' })),
].filter((r) => r.status === 'kept');

// config.seedRules ([text, source][]) fills the global ledger once, when data/rules.json does not exist yet
export const seedOf = (seedRules) => (Array.isArray(seedRules) ? seedRules : []).filter((s) => Array.isArray(s) && String(s[0] || '').trim()).map(([t, s]) => rule(t, s, 'kept'));

export function createRules({ DATA, config, works, ask }) {
  const file = path.join(DATA, 'rules.json');
  const Owner = capitalize(config.owner.name);
  const readGlobal = () => {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(seedOf(config.seedRules), null, 1));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const writeGlobal = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 1));
  const proposing = new Map();

  const keptFor = (work, index) => keptOf(readGlobal(), work, index);

  // the list a scope lives in, and how to save it back
  function scopeOf(slug, scope, pr) {
    if (scope === 'global') return { list: readGlobal(), save: writeGlobal };
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    if (scope === 'work') return { list: work.rules || [], save: (list) => works.save({ ...works.get(slug), rules: list }) };
    const n = parseKey(pr);
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (scope !== 'pr' || index < 0) throw new HttpError(400, 'scope must be global, work, or pr with a row key of this work');
    return { list: work.stack[index].rules || [], save: (list) => { const w = works.get(slug); w.stack[index] = { ...w.stack[index], rules: list }; works.save(w); } };
  }

  function view(slug) {
    const global = readGlobal();
    if (!slug) return { global };
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    return { global, work: work.rules || [], prs: (work.stack || []).map((s, i) => ({ key: rowKey(s), title: s.planned?.title || (s.number ? `#${s.number}` : `PR ${i + 1}`), rules: s.rules || [] })), proposing: proposing.get(slug) || null };
  }

  function add(slug, { scope, pr, text, source, status = 'kept' }) {
    if (!String(text || '').trim()) throw new HttpError(400, 'text required');
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    const { list, save } = scopeOf(slug, scope, pr);
    save([...list, rule(text, source, status)]);
    return view(slug);
  }

  // status change, text edit, or drop (a proposed rule the owner does not want leaves no trace)
  function update(slug, id, { scope, pr, status, text, drop }) {
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

  function threadExcerpt(slug, key) {
    const f = path.join(DATA, 'works', slug, 'threads', `${key}.json`);
    if (!/^[\w.~-]+$/.test(String(key)) || !fs.existsSync(f)) throw new HttpError(404, 'no such thread');
    return JSON.parse(fs.readFileSync(f, 'utf8')).messages.map((m) => `${m.role === 'user' ? Owner : m.role}: ${m.text}`).join('\n\n');
  }

  // a headless coco run reads the excerpt and the ledger, and ends with propose_rules; candidates land as "proposed" in the asked scope
  function propose(slug, { text, threadKey, scope = 'work', pr }) {
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
    const state = { status: 'running', startedAt: new Date().toISOString(), scope, pr: pr ?? null, added: 0, error: '' };
    proposing.set(slug, state);
    const run = ask.start({ prompt, workSlug: slug }, {
      once: true,
      onEnd: (r) => {
        const found = r.rulesProposal?.rules || [];
        try {
          const { list, save } = scopeOf(slug, scope, pr);
          save([...list, ...found.map((x) => rule(x.text, x.source || (threadKey ? `thread ${threadKey}` : 'chat excerpt')))]);
          Object.assign(state, { status: 'done', added: found.length, error: r.rulesProposal ? '' : 'coco ended without proposing' });
        } catch (e) {
          Object.assign(state, { status: 'error', error: e.message });
        }
      },
    });
    state.runId = run.id;
    return view(slug);
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      // /api/rules[/<id>] (global page) or /api/works/<slug>/rules[/<id>|/propose]
      const work = parts[0] === 'works';
      const slug = work ? parts[1] : null;
      const sub = work ? parts[3] : parts[1];
      const body = async () => JSON.parse((await readBody(req)) || '{}');
      if (req.method === 'GET') return send(res, 200, view(slug));
      if (req.method === 'POST' && sub === 'propose') return send(res, 200, propose(slug, await body()));
      if (req.method === 'POST' && !sub) {
        const b = await body();
        return send(res, 200, add(slug, { ...b, scope: work ? b.scope : 'global' }));
      }
      if (req.method === 'PUT' && sub) {
        const b = await body();
        return send(res, 200, update(slug, sub, { ...b, scope: work ? b.scope : 'global' }));
      }
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  }

  return { handle, keptFor, view };
}
