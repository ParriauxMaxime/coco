// What a review plan agent pulls instead of reading it in its prompt: the owner's guidance for the latest run on a PR, the rules it runs under, the owner personas of its paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileKey, keyLabel, parseKey } from './stack.ts';
import type { Persona, RowKey } from './core-types.ts';

export type ReviewContext = { guidance: string; rules: string[]; personas: Persona[]; headSha?: string; at?: string };

const SLUG = /^[\w.-]+$/;
const worksDir = (DATA: string) => path.join(DATA, 'works');
export const reviewContextFile = (DATA: string, slug: string, n: RowKey) => path.join(worksDir(DATA), slug, 'reviews', `pr-${fileKey(n)}-plan-context.json`);

export function writeReviewContext(DATA: string, slug: string, n: RowKey, ctx: ReviewContext) {
  const file = reviewContextFile(DATA, slug, n);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ctx, null, 1));
  fs.renameSync(tmp, file);
}

// the latest run's context for that PR: in the given work, else in whichever work ran a plan on it last
export function readReviewContext(DATA: string, { pr, work }: { pr: unknown; work?: string | null }): ReviewContext | { error: string } {
  const n = parseKey(pr);
  if (n === null) return { error: 'pr must be a PR number or b:<branch>' };
  if (work && !SLUG.test(work)) return { error: 'no such work' };
  const slugs = work ? [work] : fs.existsSync(worksDir(DATA)) ? fs.readdirSync(worksDir(DATA)).filter((s) => SLUG.test(s) && !s.startsWith('.')) : [];
  const [latest] = slugs
    .map((s) => reviewContextFile(DATA, s, n))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!latest) return { error: `no review plan run recorded for ${keyLabel(n)}${work ? ` in work ${work}` : ''}` };
  const ctx: Partial<ReviewContext> = JSON.parse(fs.readFileSync(latest, 'utf8'));
  return { guidance: ctx.guidance || '', rules: ctx.rules || [], personas: ctx.personas || [], ...(ctx.headSha ? { headSha: ctx.headSha } : {}), ...(ctx.at ? { at: ctx.at } : {}) };
}
