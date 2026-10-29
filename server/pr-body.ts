// propose_pr_body: a PR body an agent rewrote (a stale count, a section a review asked for), shown on a card as a diff against the live body;
// only pressing Replace body writes it, with gh, and only while the live body is still the one the card was made from (docs/agent-io.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opt, str } from './cards.ts';
import { prOf } from './pr-reply.ts';
import type { ActionDef } from './cards.ts';
import type { Raw } from './blocks.ts';
import type { Exec } from './core-types.ts';

const MAX_BODY = 60000;
const MAX_CHUNK = 3900;
const MAX_CHUNKS = 14;
export type PrBody = { github: string; pr: number; body: string; why?: string; was: string };
type Live = { body: string; title: string; url: string };

const hashOf = (body: string) => crypto.createHash('sha1').update(body.trim()).digest('hex').slice(0, 12);

// the lines of b against a as unified-diff lines (' ', '-', '+'), two lines of context around each change, a skipped run as one "@@ …" line
export function lineDiff(a: string, b: string, context = 2) {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const lines: string[] = [];
  for (let i = 0, j = 0; i < x.length || j < y.length; ) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      lines.push(` ${x[i]}`);
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) lines.push(`-${x[i++]}`);
    else lines.push(`+${y[j++]}`);
  }
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - context), k + context + 1).some((l) => l[0] !== ' '));
  return lines.flatMap((l, k) => (near[k] ? [l] : k === 0 || near[k - 1] ? ['@@ …'] : []));
}

// the diff as code blocks that fit the card, cut with a note past the last one
function diffBlocks(diff: string[]): Raw[] {
  const chunks: string[][] = [[]];
  let size = 0;
  for (const line of diff) {
    const l = line.length > MAX_CHUNK ? `${line.slice(0, MAX_CHUNK - 1)}…` : line;
    if (size + l.length + 1 > MAX_CHUNK) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(l);
    size += l.length + 1;
  }
  const shown = chunks.slice(0, MAX_CHUNKS).map((c): Raw => ({ type: 'code', lang: 'diff', code: c.join('\n') }));
  return chunks.length > MAX_CHUNKS ? [...shown, { type: 'callout', tone: 'warn', text: `The diff goes on for ${chunks.slice(MAX_CHUNKS).flat().length} more lines.` }] : shown;
}

export function createPrBody({ githubOf, exec }: { githubOf: (work: string | null) => string | null | undefined; exec: Exec }) {
  const gh = async (args: string[]) => {
    const r = await exec('gh', args);
    if (!r.ok) throw new Error(r.stderr.trim().split('\n').pop() || `gh ${args[0]} failed`);
    return r.stdout;
  };
  const live = async (github: string, pr: number): Promise<Live> => JSON.parse(await gh(['pr', 'view', String(pr), '--repo', github, '--json', 'body,title,url']));

  const cardAction: ActionDef = {
    card: async (raw, ctx) => {
      const github = opt(raw.github, 200, 'github') || githubOf(ctx.work);
      if (!github) throw new Error('no GitHub repo: pass github (owner/name)');
      const pr = prOf(raw.pr, ctx.pr);
      const body = str(raw.body, MAX_BODY, 'body');
      const now = await live(github, pr).catch(() => {
        throw new Error(`pr: no PR #${pr} in ${github}`);
      });
      if (now.body.trim() === body) throw new Error(`body: the same as the live body of #${pr}, nothing to change`);
      const input: PrBody = { github, pr, body, why: opt(raw.why, 500, 'why'), was: hashOf(now.body) };
      return {
        input,
        card: { kind: 'confirm', title: `New body for #${pr}`.slice(0, 120), question: input.why, blocks: [{ type: 'text', text: `**${now.title}**: the live body against the proposed one.` }, ...diffBlocks(lineDiff(now.body, body))], confirmLabel: 'Replace body', rejectLabel: 'Drop' },
      };
    },
    run: async (card) => {
      const input = card.action?.input as PrBody;
      const now = await live(input.github, input.pr);
      if (hashOf(now.body) !== input.was) return { ok: false, detail: `the body of #${input.pr} changed on GitHub since this card: nothing written, ask the agent for a new one` };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-pr-body-'));
      try {
        fs.writeFileSync(path.join(dir, 'body.md'), input.body);
        await gh(['pr', 'edit', String(input.pr), '--repo', input.github, '--body-file', path.join(dir, 'body.md')]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { ok: true, detail: `body of #${input.pr} replaced`, link: now.url };
    },
  };
  return { cardAction };
}
