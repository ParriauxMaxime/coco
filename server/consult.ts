// consult_persona: a compact pack of one reviewer's rules and past comments for the calling agent to reason with; no LLM call here (docs/agent-io.md)
import { globToRegExp, surfaceGlobs } from './glob.ts';

export const CONSULT_CAP = 6000;
const RULE_MAX = 520;
const QUOTE_MAX = 240;
const STOP = new Set('what would does this that with from have should about think like which there their them then than into your when where here only just more some will best option options tradeoff recommendation'.split(' '));
const GENERIC = new Set(['src', 'lib', 'index', 'test', 'tests', 'imports', 'client', 'server', 'component', 'components']);

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

// the rule-like chunks of a persona markdown: list items and sub-headings with their continuation lines, outside code fences; `lead` marks the ones under a "checks" heading
export function ruleChunks(md: string): { text: string; lead: boolean }[] {
  const out: { text: string[]; lead: boolean }[] = [];
  let fence = false;
  let lead = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      if (h[1].length <= 2) lead = /check|rule|bar|review/i.test(h[2]);
      if (h[1].length >= 3) out.push({ text: [h[2]], lead });
      continue;
    }
    if (/^\s{0,3}(?:[-*]|\d+\.)\s/.test(line)) out.push({ text: [line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')], lead });
    else if (line.trim() && out.length) out[out.length - 1].text.push(line.trim());
  }
  return out.map((c) => ({ text: flat(c.text.join(' ')), lead: c.lead })).filter((c) => c.text.length > 30);
}

// up to `n` chunks: the best keyword overlap with the query first, then the first of the doc's own top rules
export function pickRules(md: string, query: Set<string>, n: number, top = 3): string[] {
  const chunks = ruleChunks(md);
  const scored = chunks.map((c, i) => ({ c, i, s: words(c.text).filter((w, j, a) => query.has(w) && a.indexOf(w) === j).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, Math.max(n - top, 1));
  const picked = new Set(scored.map((x) => x.i));
  const lead = chunks.map((c, i) => ({ c, i })).filter((x) => x.c.lead && !picked.has(x.i));
  const first = (lead.length ? lead : chunks.map((c, i) => ({ c, i })).filter((x) => !picked.has(x.i))).slice(0, top);
  return [...scored.map((x) => x.c.text), ...first.map((x) => x.c.text)].slice(0, n).map((t) => clip(t, RULE_MAX));
}

type Mined = { checks?: { quotes?: unknown[] }[]; voiceQuotes?: unknown[]; replyQuotes?: unknown[] };
// their past comments whose location shares a path part with `file` (or, with no file, whose words match the question)
export function pastComments(json: Mined | null, file: string, query: Set<string>, n = 5): string[] {
  if (!json) return [];
  const parts = new Set(words(file.replace(/\.[a-z]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')).filter((w) => !GENERIC.has(w)));
  const quotes = [...(json.checks || []).flatMap((c) => c.quotes || []), ...(json.voiceQuotes || [])].filter((q): q is [string, string] => Array.isArray(q) && typeof q[0] === 'string' && typeof q[1] === 'string');
  const seen = new Set<string>();
  return quotes
    .map(([text, at], i) => ({ text, at, i, s: (file ? words(at).filter((w) => parts.has(w)).length * 3 : 0) + words(text).filter((w) => query.has(w)).length }))
    .filter((x) => x.s > 0 && !seen.has(x.text) && seen.add(x.text))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map((x) => `"${clip(flat(x.text), QUOTE_MAX)}" (${flat(x.at)})`);
}

export type PersonaDoc = { md: string; json?: Mined | null };
// the reviewer for a path: most surface hits, else the first persona given
export function pickPersona(personas: Record<string, string>, file?: string, fallback: string[] = []): string | null {
  if (file) {
    const hits = Object.entries(personas).map(([login, md]) => [login, surfaceGlobs(md).some((g) => globToRegExp(g).test(file)) ? 1 : 0] as const).filter((x) => x[1]);
    if (hits.length) return hits[0][0];
  }
  return fallback.find((l) => l in personas) || null;
}

type PackInput = { login: string; question: string; path?: string; pr?: number | string; owner: string; review?: string; authoring?: string; json?: Mined | null; cap?: number };
export function consultPack({ login, question, path: file = '', pr, owner, review, authoring, json, cap = CONSULT_CAP }: PackInput) {
  const query = new Set([...words(question), ...words(file.replace(/([a-z])([A-Z])/g, '$1 $2'))]);
  const sections: string[] = [];
  const add = (title: string, items: string[]) => items.length && sections.push(`${title}\n${items.map((r) => `- ${r}`).join('\n')}`);
  add(`${login}'s review rules most relevant here:`, review ? pickRules(review, query, 6) : []);
  add(`${login}'s authoring rules most relevant here:`, authoring ? pickRules(authoring, query, 4) : []);
  add(`${login}'s past comments on similar paths:`, pastComments(json ?? null, file, query));
  const head = `Consult pack for ${login}${file ? ` on ${file}` : ''}${pr ? ` (PR #${pr})` : ''}. Question: ${clip(flat(question), 400)}`;
  const tail = `Answer as ${login} would, in 3 to 6 lines, in their voice and from the rules above (read_persona ${login} only if these are not enough). Then call ask (kind choice) with the real options and ${login}'s pick marked recommended, so ${owner} clicks. Do not start a persona review unless ${owner} asks for one.`;
  let body = sections.join('\n\n');
  const room = cap - head.length - tail.length - 4;
  if (body.length > room) body = `${body.slice(0, Math.max(room - 1, 0)).trimEnd()}…`;
  return [head, body, tail].filter(Boolean).join('\n\n');
}
