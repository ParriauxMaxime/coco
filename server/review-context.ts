// What a review plan agent pulls instead of reading it in its prompt: the owner's guidance for the latest run on a PR, the rules it runs under, the owner personas of its paths, and what is already raised on the PR.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileKey, keyLabel, parseKey } from './stack.ts';
import type { Comment, Persona, RowKey } from './core-types.ts';

export type ReviewContext = { guidance: string; rules: string[]; personas: Persona[]; headSha?: string; at?: string };
export type DismissedWatch = { plan: string | null; index: number; headSha: string; path: string; startLine: number; endLine: number; body: string; note?: string; at: string };

const SLUG = /^[\w.-]+$/;
const THREAD_TAIL = 3;
const THREAD_TEXT = 500;
const worksDir = (DATA: string) => path.join(DATA, 'works');
export const reviewContextFile = (DATA: string, slug: string, n: RowKey) => path.join(worksDir(DATA), slug, 'reviews', `pr-${fileKey(n)}-plan-context.json`);
const commentsFile = (DATA: string, slug: string, n: RowKey) => path.join(worksDir(DATA), slug, 'comments', `pr-${fileKey(n)}.json`);
const planFile = (DATA: string, slug: string, n: RowKey) => path.join(worksDir(DATA), slug, 'reviews', `pr-${fileKey(n)}-plan.json`);
const threadFile = (DATA: string, slug: string, n: RowKey, id: string) => path.join(worksDir(DATA), slug, 'threads', `c.${fileKey(n)}.${id}.json`);
const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// the given work, else whichever work wrote that file last
function latestWork(DATA: string, work: string | null | undefined, fileOf: (slug: string) => string) {
  const slugs = work ? [work] : fs.existsSync(worksDir(DATA)) ? fs.readdirSync(worksDir(DATA)).filter((s) => SLUG.test(s) && !s.startsWith('.')) : [];
  const [latest] = slugs
    .filter((s) => fs.existsSync(fileOf(s)))
    .sort((a, b) => fs.statSync(fileOf(b)).mtimeMs - fs.statSync(fileOf(a)).mtimeMs);
  return latest ?? null;
}

export function writeReviewContext(DATA: string, slug: string, n: RowKey, ctx: ReviewContext) {
  const file = reviewContextFile(DATA, slug, n);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ctx, null, 1));
  fs.renameSync(tmp, file);
}

export function readReviewContext(DATA: string, { pr, work }: { pr: unknown; work?: string | null }): ReviewContext | { error: string } {
  const n = parseKey(pr);
  if (n === null) return { error: 'pr must be a PR number or b:<branch>' };
  if (work && !SLUG.test(work)) return { error: 'no such work' };
  const slug = latestWork(DATA, work, (s) => reviewContextFile(DATA, s, n));
  if (!slug) return { error: `no review plan run recorded for ${keyLabel(n)}${work ? ` in work ${work}` : ''}` };
  const ctx: Partial<ReviewContext> = JSON.parse(fs.readFileSync(reviewContextFile(DATA, slug, n), 'utf8'));
  return { guidance: ctx.guidance || '', rules: ctx.rules || [], personas: ctx.personas || [], ...(ctx.headSha ? { headSha: ctx.headSha } : {}), ...(ctx.at ? { at: ctx.at } : {}) };
}

// every finding on a PR with how it was settled (status, resolution, the end of its thread), plus the watch points the owner dismissed
export function readPrFindings(DATA: string, { pr, work }: { pr: unknown; work?: string | null }) {
  const n = parseKey(pr);
  if (n === null) return { error: 'pr must be a PR number or b:<branch>' };
  if (work && !SLUG.test(work)) return { error: 'no such work' };
  const slug = latestWork(DATA, work, (s) => commentsFile(DATA, s, n)) ?? latestWork(DATA, work, (s) => planFile(DATA, s, n));
  if (!slug) return { work: work ?? null, pr: keyLabel(n), findings: [], dismissedWatchPoints: [] };
  const { comments = [] } = readJson<{ comments?: Comment[] }>(commentsFile(DATA, slug, n), {});
  const { dismissed = [] } = readJson<{ dismissed?: DismissedWatch[] }>(planFile(DATA, slug, n), {});
  const findings = comments.map((c) => {
    const { messages = [] } = readJson<{ messages?: { role: string; text?: string }[] }>(threadFile(DATA, slug, n, c.id), {});
    const thread = messages.filter((m) => m.text).slice(-THREAD_TAIL).map((m) => ({ role: m.role, text: String(m.text).slice(0, THREAD_TEXT) }));
    return {
      id: c.id,
      status: c.status,
      author: c.author,
      path: c.path,
      lines: c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`,
      sha: c.sha.slice(0, 12),
      severity: c.severity ?? null,
      title: c.title || c.body.split('\n')[0].slice(0, 200),
      ...(c.summary ? { summary: c.summary } : {}),
      ...(c.resolution ? { resolution: c.resolution } : {}),
      ...(thread.length ? { thread } : {}),
    };
  });
  const dismissedWatchPoints = dismissed.map(({ path: p, startLine, endLine, body, note, headSha }) => ({ path: p, lines: `${startLine}-${endLine}`, headSha: headSha.slice(0, 12), body, ...(note ? { note } : {}) }));
  return { work: slug, pr: keyLabel(n), findings, dismissedWatchPoints };
}
