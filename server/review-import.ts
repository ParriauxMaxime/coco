// Review import: findings of a markdown review (`path:line`) become open comments on the stack row whose diff touches the path.
import fs from 'node:fs';
import path from 'node:path';
import { rowKey } from './stack.ts';

const MAX_BODY = 5000;
const ANCHOR = /`([\w@][\w@./-]*\.\w+):(\d+)(?:-(\d+))?`/;

// one finding per `### N.` heading or `N. **…**` item, anchored on its first `path:line`
export function parseFindings(md) {
  return md
    .split(/^(?=### \d+\.|\d+\. \*\*)/m)
    .slice(1)
    .map((block) => block.split(/^#{1,2} /m)[0])
    .map((block) => {
      const m = block.match(ANCHOR);
      if (!m) return null;
      const body = block
        .replace(/^### /, '')
        .split('\n')
        .map((l) => l.replace(/^\s*> ?/, ''))
        .join('\n')
        .trim();
      const startLine = Number(m[2]);
      return { path: m[1], startLine, endLine: Math.max(startLine, Number(m[3] || m[2])), body: body.slice(0, MAX_BODY) };
    })
    .filter(Boolean);
}

export function createReviewImport({ REPO, config, works, comments, code, reviewAgent }) {
  const REVIEWS = config.repo.reviewsDir;
  async function candidates(work) {
    const dirs = REPO ? [path.join(REPO, REVIEWS)] : [];
    for (const s of work.stack || []) {
      const wt = s.planned?.branch && (await reviewAgent.worktreeFor(s.planned.branch));
      if (wt) dirs.push(path.join(wt, REVIEWS));
    }
    const files = [...new Set(dirs)].flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => path.join(d, f)) : []));
    return files
      .map((file) => ({ path: file, name: path.basename(file), mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  }

  async function importFile(work, file) {
    const author = (path.basename(file, '.md').match(/-([\w.]+)$/) || [])[1];
    const rows = [];
    for (const s of work.stack || []) {
      const key = rowKey(s);
      if (!key) continue;
      const refs = await code.ensureRefs(key);
      rows.push({ key, sha: refs.headSha, files: new Set((await code.prFilesFromGit(key, refs)).map((f) => f.filename)) });
    }
    const out = { added: [], skipped: [] };
    for (const f of parseFindings(fs.readFileSync(file, 'utf8'))) {
      const row = rows.findLast((r) => r.files.has(f.path));
      const where = `${f.path}:${f.startLine}`;
      if (!row) {
        out.skipped.push({ where, reason: 'path in no row of the stack' });
        continue;
      }
      const existing = comments.list(work.slug, row.key).comments || [];
      if (existing.some((c) => c.path === f.path && c.startLine === f.startLine && c.body === f.body)) {
        out.skipped.push({ where, reason: 'already imported' });
        continue;
      }
      try {
        const c = await comments.add(work.slug, row.key, { path: f.path, side: 'head', sha: row.sha, startLine: f.startLine, endLine: f.endLine, body: f.body, author });
        out.added.push({ where, key: row.key, id: c.id });
      } catch (e) {
        out.skipped.push({ where, reason: e.message });
      }
    }
    if (out.added.length) reviewAgent.timeline(work.slug, 'review', `imported ${out.added.length} findings from ${path.basename(file)}`);
    return out;
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      const work = works.get(parts[1]);
      if (!work) return send(res, 404, { error: 'no such work' });
      const files = await candidates(work);
      if (req.method === 'GET') return send(res, 200, { files });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!files.some((f) => f.path === body.path)) return send(res, 400, { error: 'not a review file of this work' });
      return send(res, 200, await importFile(work, body.path));
    } catch (e) {
      return send(res, e.status || (typeof e.code === 'number' ? e.code : 500), { error: e.message });
    }
  }

  return { handle, parseFindings };
}
