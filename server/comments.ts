// Review comments anchored to code ranges, re-anchored across new head / merge-base shas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileKey, parseKey, rowKey } from './stack.ts';
import { blocksToMarkdown, readSuggestionBefore, validateRich } from './blocks.ts';
import { HttpError, errorMessage, isSeverity } from './core-types.ts';
import type { Comment, CommentFile, CommentStatus, ExecResult, ReadBody, Req, Res, RowKey, Send, Severity, Works } from './core-types.ts';

const CTX = 3;
const SEARCH_WINDOW = 30;
const MAX_BODY = 5000;
const MAX_TITLE = 100;
const STATUSES: string[] = ['open', 'sent', 'fixed', 'declined', 'outdated'];
const SEVERITIES: string[] = ['blocking', 'major', 'minor', 'nit'];
// a sent comment belongs to its run until the run settles it: only open ones turn outdated
const KEEP_STATUS: string[] = ['sent', 'fixed', 'declined'];

type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number };
type Anchored = { path: string; startLine: number; endLine: number; newLines: string[] };
type Input = Record<string, unknown>;
const isStatus = (x: unknown): x is CommentStatus => typeof x === 'string' && STATUSES.includes(x);
const isConfidence = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 100;

const git = (cwd: string, args: string[]) =>
  new Promise<ExecResult>((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const splitLines = (text: string) => {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const norm = (lines: string[]) => lines.map((l) => l.trimEnd());
const sliceContext = (lines: string[], startLine: number, endLine: number) => ({
  snippet: lines.slice(startLine - 1, endLine).join('\n'),
  ctxBefore: lines.slice(Math.max(0, startLine - 1 - CTX), startLine - 1),
  ctxAfter: lines.slice(endLine, endLine + CTX),
});

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function parseHunks(diff: string) {
  const hunks: Hunk[] = [];
  let renameTo: string | null = null;
  for (const line of diff.split('\n')) {
    const m = HUNK.exec(line);
    if (m) hunks.push({ oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4] });
    else if (!hunks.length && line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
  }
  return { hunks, renameTo };
}

// Map an old line number through -U0 hunks: shifted, or removed when inside a changed/removed range.
export function mapLine(line: number, hunks: Hunk[]) {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      if (line <= h.oldStart) break;
      delta += h.newCount;
      continue;
    }
    if (line < h.oldStart) break;
    if (line < h.oldStart + h.oldCount) return { line: h.oldStart + delta, removed: true };
    delta += h.newCount - h.oldCount;
  }
  return { line: line + delta, removed: false };
}

type Deps = { DATA: string; REPO: string; config: { owner: { login: string } }; works?: Pick<Works, 'get' | 'remark'> };

export function createComments({ DATA, REPO, config, works }: Deps) {
  const ME = config.owner.login;
  const dir = (slug: string) => path.join(DATA, 'works', slug, 'comments');
  const file = (slug: string, n: RowKey) => path.join(dir(slug), `pr-${fileKey(n)}.json`);

  const checkSlug = (slug: string) => {
    if (!/^[\w.-]+$/.test(String(slug)) || slug.startsWith('.')) throw new HttpError(400, 'bad slug');
  };
  const checkNumber = (n: unknown): RowKey => {
    const key = parseKey(n);
    if (!key) throw new HttpError(400, 'bad pr number or branch key');
    return key;
  };

  // a row that got its PR number takes over the comments and review plan made on its local branch
  const adopt = (slug: string, n: RowKey) => {
    if (typeof n !== 'number' || fs.existsSync(file(slug, n))) return;
    const row = (works?.get(slug)?.stack || []).find((s) => s.number === n);
    const local = rowKey({ planned: row?.planned });
    if (!local || !fs.existsSync(file(slug, local))) return;
    fs.renameSync(file(slug, local), file(slug, n));
    const plan = (k: RowKey) => path.join(DATA, 'works', slug, 'reviews', `pr-${fileKey(k)}-plan.json`);
    if (fs.existsSync(plan(local)) && !fs.existsSync(plan(n))) fs.renameSync(plan(local), plan(n));
  };

  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(key, tail);
    tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return next;
  }

  const read = (slug: string, n: RowKey): CommentFile => {
    adopt(slug, n);
    try {
      return JSON.parse(fs.readFileSync(file(slug, n), 'utf8'));
    } catch {
      return { number: n, headSha: null, mergeBase: null, comments: [] };
    }
  };
  const write = (slug: string, n: RowKey, data: CommentFile) => {
    fs.mkdirSync(dir(slug), { recursive: true });
    const target = file(slug, n);
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, target);
  };
  const mutate = <T>(slug: string, key: unknown, fn: (data: CommentFile) => T | Promise<T>): Promise<T> => {
    checkSlug(slug);
    const n = checkNumber(key);
    return withLock(file(slug, n), async () => {
      const data = read(slug, n);
      data.number = n;
      data.comments = data.comments || [];
      const result = await fn(data);
      write(slug, n, data);
      return result;
    });
  };

  const resolveSha = async (sha: string) => {
    const r = await git(REPO, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };
  const fileLines = async (sha: string, p: string) => {
    const r = await git(REPO, ['show', `${sha}:${p}`]);
    return r.ok ? splitLines(r.stdout) : null;
  };

  async function snippetFor({ sha, path: p, startLine, endLine }: { sha: string; path: string; startLine: number; endLine: number }) {
    const lines = await fileLines(sha, p);
    if (!lines) throw new HttpError(400, `cannot read ${p} at ${String(sha).slice(0, 11)}`);
    if (startLine < 1 || endLine > lines.length) throw new HttpError(400, `range ${startLine}-${endLine} outside ${p} (${lines.length} lines)`);
    return sliceContext(lines, startLine, endLine);
  }

  const list = (slug: string, n: unknown) => {
    checkSlug(slug);
    return read(slug, checkNumber(n));
  };

  // a structured finding (coco-findings skill): category, recommendation, typed blocks, sources; a suggestion's `before` is read at the sha, never trusted
  async function richOf(input: Input, sha: string) {
    let out: ReturnType<typeof validateRich>;
    try {
      out = validateRich(input);
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
    await readSuggestionBefore(out.blocks, (p) => fileLines(sha, p));
    return out;
  }
  const twin = (c: Parameters<typeof blocksToMarkdown>[0]) => blocksToMarkdown(c).slice(0, MAX_BODY);

  const isLine = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;
  // an unanchored finding (flag_coco_issue): no path, sha or lines, so reanchor and the code view leave it alone
  async function addIssue(slug: string, n: unknown, input: Input) {
    const { title, from, author = ME } = input;
    if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) throw new HttpError(400, `title must be 1-${MAX_TITLE} chars`);
    const rich = await richOf(input, '');
    const body = rich.blocks && !input.body ? twin(rich) : input.body;
    if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) throw new HttpError(400, `body or blocks required, ${MAX_BODY} chars at most`);
    const f = (from && typeof from === 'object' ? from : {}) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, 200) : null);
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomBytes(6).toString('hex'),
      kind: 'issue',
      path: '',
      side: 'head',
      sha: '',
      startLine: 0,
      endLine: 0,
      snippet: '',
      ctxBefore: [],
      ctxAfter: [],
      body,
      author: typeof author === 'string' && /^[\w.-]{1,40}$/.test(author) ? author : ME,
      createdAt: now,
      updatedAt: now,
      status: 'open',
      runId: null,
      resolution: null,
      title: title.trim(),
      from: { agent: str(f.agent), work: str(f.work), pr: str(f.pr) },
      ...(isSeverity(input.severity) ? { severity: input.severity } : {}),
      ...rich,
    };
    return mutate(slug, n, (data) => (data.comments.push(comment), comment));
  }

  async function add(slug: string, n: unknown, input: Input = {}) {
    if (input.kind === 'issue') return addIssue(slug, n, input);
    const { path: p, side = 'head', sha, startLine, endLine, author = ME } = input;
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'path required');
    if (side !== 'head' && side !== 'base') throw new HttpError(400, 'side must be head or base');
    if (typeof sha !== 'string' || !sha) throw new HttpError(400, 'sha required');
    if (!isLine(startLine) || !isLine(endLine)) throw new HttpError(400, 'startLine and endLine required');
    if (endLine < startLine) throw new HttpError(400, 'endLine < startLine');
    if (typeof input.title === 'string' && input.title.length > MAX_TITLE) throw new HttpError(400, `title longer than ${MAX_TITLE}: keep it short, put the full sentence in summary`);
    const full = await resolveSha(sha);
    if (!full) throw new HttpError(400, `unknown sha ${sha}`);
    const rich = await richOf(input, full);
    const body = rich.blocks && !input.body ? twin(rich) : input.body;
    if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body or blocks required');
    if (body.length > MAX_BODY) throw new HttpError(400, `body longer than ${MAX_BODY}`);
    const ctx = await snippetFor({ sha: full, path: p, startLine, endLine });
    const now = new Date().toISOString();
    const comment: Comment = {
      id: crypto.randomBytes(6).toString('hex'),
      path: p,
      side,
      sha: full,
      startLine,
      endLine,
      ...ctx,
      body,
      author: typeof author === 'string' && /^[\w.-]{1,40}$/.test(author) ? author : ME,
      createdAt: now,
      updatedAt: now,
      status: 'open',
      runId: null,
      resolution: null,
      // carried over from an accepted coco watch point
      ...(isSeverity(input.severity) ? { severity: input.severity } : {}),
      ...(isConfidence(input.confidence) ? { confidence: input.confidence } : {}),
      // the one-line claim a findings reporter (coco-findings skill) gives; the board falls back to the body's first line
      ...(typeof input.title === 'string' && input.title.trim() ? { title: input.title.trim().slice(0, MAX_TITLE) } : {}),
      ...rich,
    };
    return mutate(slug, n, (data) => {
      if (side === 'head' && !data.headSha) data.headSha = full;
      if (side === 'base' && !data.mergeBase) data.mergeBase = full;
      data.comments.push(comment);
      return comment;
    });
  }

  async function update(slug: string, n: RowKey, id: string, patch: Input = {}) {
    const fields: { body?: string; status?: CommentStatus; resolution?: Comment['resolution']; runId?: string | number | null; title?: string; severity?: Severity; confidence?: number } = {};
    if ('body' in patch) {
      const { body } = patch;
      if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) throw new HttpError(400, `body must be 1-${MAX_BODY} chars`);
      fields.body = body;
    }
    if ('status' in patch) {
      if (!isStatus(patch.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
      fields.status = patch.status;
    }
    if ('runId' in patch) {
      const { runId } = patch;
      if (runId !== null && typeof runId !== 'string' && typeof runId !== 'number') throw new HttpError(400, 'runId must be a string or null');
      fields.runId = runId;
    }
    if ('resolution' in patch) {
      const { resolution } = patch;
      if (resolution !== null && (typeof resolution !== 'object' || Array.isArray(resolution))) throw new HttpError(400, 'resolution must be { commit?, note? } or null');
      fields.resolution = resolution;
    }
    if ('remark' in patch && typeof patch.remark !== 'string') throw new HttpError(400, 'remark must be a string');
    if ('title' in patch) {
      const { title } = patch;
      if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) throw new HttpError(400, `title must be 1-${MAX_TITLE} chars: keep it short, put the full sentence in summary`);
      fields.title = title.trim();
    }
    if ('severity' in patch) {
      if (!isSeverity(patch.severity)) throw new HttpError(400, `severity must be one of ${SEVERITIES.join(', ')}`);
      fields.severity = patch.severity;
    }
    if ('confidence' in patch) {
      if (!isConfidence(patch.confidence)) throw new HttpError(400, 'confidence must be an integer 0-100');
      fields.confidence = patch.confidence;
    }
    const current = (list(slug, n).comments || []).find((x) => x.id === id);
    const rich = current ? await richOf(patch, current.sha) : {};
    const c = await mutate(slug, n, (data) => {
      const c = data.comments.find((x) => x.id === id);
      if (!c) throw new HttpError(404, 'no such comment');
      Object.assign(c, fields, rich);
      if (Object.keys(rich).length && !('body' in patch) && c.blocks) c.body = twin(c);
      // a hand edit of the markdown body turns a structured finding back into a plain comment
      if ('body' in patch && !('blocks' in patch)) {
        delete c.summary;
        delete c.category;
        delete c.recommendation;
        delete c.blocks;
        delete c.sources;
      }
      c.updatedAt = new Date().toISOString();
      return c;
    });
    if (typeof patch.remark === 'string' && patch.remark) works?.remark(slug, { n, where: `${c.path.split('/').pop()} L${c.startLine}${c.endLine !== c.startLine ? `-${c.endLine}` : ''}`, verdict: `comment ${c.status}`, text: patch.remark });
    return c;
  }

  const remove = (slug: string, n: RowKey, id: string) =>
    mutate(slug, n, (data) => {
      const i = data.comments.findIndex((x) => x.id === id);
      if (i < 0) throw new HttpError(404, 'no such comment');
      data.comments.splice(i, 1);
      return { ok: true };
    });

  async function reanchor(slug: string, n: RowKey, { headSha, mergeBase }: { headSha?: string | null; mergeBase?: string | null } = {}) {
    if (!headSha && !mergeBase) throw new HttpError(400, 'headSha or mergeBase required');
    const target: { head: string | null; base: string | null } = { head: null, base: null };
    if (headSha) target.head = (await resolveSha(headSha)) || (() => { throw new HttpError(400, `unknown headSha ${headSha}`); })();
    if (mergeBase) target.base = (await resolveSha(mergeBase)) || (() => { throw new HttpError(400, `unknown mergeBase ${mergeBase}`); })();

    const linesCache = new Map<string, string[] | null>();
    const cachedLines = async (sha: string, p: string) => {
      const key = `${sha}:${p}`;
      if (!linesCache.has(key)) linesCache.set(key, await fileLines(sha, p));
      return linesCache.get(key) ?? null;
    };
    const statusCache = new Map<string, Map<string, { status: string; to: string }>>();
    const changedFiles = async (oldSha: string, newSha: string) => {
      const key = `${oldSha}..${newSha}`;
      if (!statusCache.has(key)) {
        const r = await git(REPO, ['diff', '--name-status', '-z', '-M', oldSha, newSha]);
        const map = new Map<string, { status: string; to: string }>();
        const tokens = r.stdout.split('\0');
        for (let i = 0; i < tokens.length && tokens[i]; ) {
          const st = tokens[i][0];
          if (st === 'R' || st === 'C') {
            map.set(tokens[i + 1], { status: st, to: tokens[i + 2] });
            i += 3;
          } else {
            map.set(tokens[i + 1], { status: st, to: tokens[i + 1] });
            i += 2;
          }
        }
        statusCache.set(key, map);
      }
      return statusCache.get(key);
    };

    // Returns { path, hunks } or null when the file is gone in the new sha.
    async function diffFor(oldSha: string, newSha: string, p: string) {
      const info = (await changedFiles(oldSha, newSha))?.get(p);
      if (!info) return { path: p, hunks: [] };
      if (info.status === 'D') return null;
      const paths = info.to === p ? [p] : [p, info.to];
      const r = await git(REPO, ['diff', '-U0', '-M', '--no-color', '--no-ext-diff', oldSha, newSha, '--', ...paths]);
      const { hunks, renameTo } = parseHunks(r.stdout);
      return { path: info.status === 'R' ? renameTo || info.to : p, hunks };
    }

    function searchSnippet(newLines: string[], snippet: string, around: number) {
      const want = norm(snippet.split('\n'));
      const lo = Math.max(1, around - SEARCH_WINDOW);
      const hi = Math.min(newLines.length - want.length + 1, around + SEARCH_WINDOW);
      let best: number | null = null;
      for (let s = lo; s <= hi; s++) {
        if (want.every((w, i) => newLines[s - 1 + i].trimEnd() === w) && (best === null || Math.abs(s - around) < Math.abs(best - around))) best = s;
      }
      return best === null ? null : { startLine: best, endLine: best + want.length - 1 };
    }

    async function anchorOne(c: Comment, newSha: string): Promise<Anchored | null> {
      const oldSha = await resolveSha(c.sha);
      let p = c.path;
      let hunks: Hunk[] | null = null;
      if (oldSha) {
        const d = await diffFor(oldSha, newSha, c.path);
        if (!d) return null;
        p = d.path;
        hunks = d.hunks;
      }
      const newLines = await cachedLines(newSha, p);
      if (!newLines) return null;
      const length = c.endLine - c.startLine;
      let around = c.startLine;
      if (hunks) {
        const s = mapLine(c.startLine, hunks);
        const e = mapLine(c.endLine, hunks);
        around = Math.max(1, s.line);
        if (!s.removed && !e.removed && e.line - s.line === length && s.line >= 1 && e.line <= newLines.length) {
          if (norm(newLines.slice(s.line - 1, e.line)).join('\n') === norm(c.snippet.split('\n')).join('\n')) return { path: p, startLine: s.line, endLine: e.line, newLines };
        }
      }
      const found = searchSnippet(newLines, c.snippet, around);
      return found ? { path: p, ...found, newLines } : null;
    }

    return mutate(slug, n, async (data) => {
      const counts = { updated: 0, outdated: 0, unchanged: 0 };
      for (const c of data.comments) {
        const newSha = target[c.side];
        if (c.kind === 'issue' || !newSha || (await resolveSha(c.sha)) === newSha) {
          counts.unchanged++;
          continue;
        }
        const anchored = await anchorOne(c, newSha);
        if (anchored) {
          Object.assign(c, { path: anchored.path, startLine: anchored.startLine, endLine: anchored.endLine, sha: newSha }, sliceContext(anchored.newLines, anchored.startLine, anchored.endLine));
          if (c.status === 'outdated') c.status = 'open';
          c.updatedAt = new Date().toISOString();
          counts.updated++;
        } else if (KEEP_STATUS.includes(c.status)) {
          counts.unchanged++;
        } else {
          if (c.status !== 'outdated') {
            c.status = 'outdated';
            c.updatedAt = new Date().toISOString();
          }
          counts.outdated++;
        }
      }
      if (target.head) data.headSha = target.head;
      if (target.base) data.mergeBase = target.base;
      return counts;
    });
  }

  async function follow(slug: string, n: RowKey, refs: { headSha: string; mergeBase: string }) {
    const data = list(slug, n);
    if (!data.comments.length || (data.headSha === refs.headSha && data.mergeBase === refs.mergeBase)) return null;
    return reanchor(slug, n, { headSha: refs.headSha, mergeBase: refs.mergeBase });
  }

  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    try {
      const [, slug, , n, , id] = parts;
      checkSlug(slug);
      checkNumber(n);
      if (!fs.existsSync(path.join(DATA, 'works', `${slug}.json`))) return send(res, 404, { error: 'no such work' });
      const parseBody = async () => {
        try {
          return JSON.parse((await readBody(req)) || '{}') || {};
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      };
      if (id === 'reanchor' && req.method === 'POST') return send(res, 200, await reanchor(slug, n, await parseBody()));
      if (!id) {
        if (req.method === 'GET') return send(res, 200, list(slug, n));
        if (req.method === 'POST') return send(res, 200, await add(slug, n, await parseBody()));
      } else {
        if (req.method === 'PUT') return send(res, 200, await update(slug, n, id, await parseBody()));
        if (req.method === 'DELETE') return send(res, 200, await remove(slug, n, id));
      }
      return send(res, 400, { error: `unsupported ${req.method}` });
    } catch (e) {
      return send(res, e instanceof HttpError ? e.status : 500, { error: errorMessage(e) });
    }
  }

  return { handle, list, add, update, remove, reanchor, follow, snippetFor };
}
