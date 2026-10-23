// Works: long-term context tied to a Paseo project — PR stack, artifacts, links, personas, notes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { globToRegExp, surfaceGlobs } from './glob.mjs';
import { createNotionSync } from './notion.mjs';
import { keyLabel, rowKey } from './stack.mjs';
import { decisionBullet, decisionSummary, validChoice } from './decisions.mjs';
import { blocksToMarkdown, readSuggestionBefore, validateRich } from './blocks.mjs';
import { validateNext } from './next.mjs';

const HOME = os.homedir();
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
const parseJson = (r, fallback) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fallback;
  }
};
const MIME = { '.html': 'text/html', '.md': 'text/plain', '.txt': 'text/plain', '.log': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.diff': 'text/plain', '.ts': 'text/plain' };

export function createWorks({ DATA, PERSONAS, REPO, config, agents }) {
  const hooks = {};
  const GITHUB = config.repo.github;
  const noRepo = { ok: false, stdout: '', stderr: 'no GitHub repo configured (repo.github)' };
  const gh = (args) => (GITHUB ? run('gh', args) : Promise.resolve(noRepo));
  const notion = createNotionSync({ DATA, REPO, config, ...(agents ? { agents } : {}), works: { get: (s) => get(s), save: (x) => save(x), listArtifacts: (s) => listArtifacts(s), detailPrs: (s) => Promise.all((get(s)?.stack || []).map((x) => prInfo(x.number))), prInfo: (n) => prInfo(n) } });
  const ROOT = path.join(DATA, 'works');
  fs.mkdirSync(ROOT, { recursive: true });
  const file = (slug) => path.join(ROOT, `${slug}.json`);
  const artDir = (slug) => path.join(ROOT, slug, 'artifacts');
  const prCache = new Map();

  const list = () =>
    fs
      .readdirSync(ROOT)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.state.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const get = (slug) => (fs.existsSync(file(slug)) ? JSON.parse(fs.readFileSync(file(slug), 'utf8')) : null);
  const save = (work) => {
    work.updatedAt = new Date().toISOString();
    fs.writeFileSync(file(work.slug), JSON.stringify(work, null, 1));
    return work;
  };

  async function paseo() {
    const [p, w, a] = await Promise.all([run('paseo', ['project', 'ls', '--json']), run('paseo', ['workspace', 'ls', '--json']), run('paseo', ['ls', '--json'])]);
    const projects = parseJson(p, []);
    const workspaces = parseJson(w, []);
    const agents = parseJson(a, []).map((x) => ({ ...x, cwdAbs: x.cwd.replace(/^~/, HOME) }));
    const works = list();
    const tree = projects.map((pr) => {
      const ws = workspaces
        .filter((x) => x.project === pr.name)
        .map((x) => ({ ...x, agents: agents.filter((ag) => ag.cwdAbs === x.cwd) }));
      const work = works.find((wk) => wk.projectId === pr.projectId);
      return { ...pr, workspaces: ws, agentCount: ws.reduce((n, x) => n + x.agents.length, 0), running: ws.reduce((n, x) => n + x.agents.filter((ag) => ag.status === 'running').length, 0), work: work ? { slug: work.slug, title: work.title } : null };
    });
    const orphanAgents = agents.filter((ag) => !workspaces.some((x) => x.cwd === ag.cwdAbs));
    return { projects: tree, orphanAgents, error: p.ok ? null : p.stderr };
  }

  async function prInfo(number, fresh = false) {
    if (!number) return { number: null, state: 'PLANNED', isDraft: false, ci: 'none', checks: [], reviewers: [], additions: 0, deletions: 0, changedFiles: 0 };
    const cached = prCache.get(number);
    if (!fresh && cached && Date.now() - cached.at < 60000) return cached.data;
    const r = await gh(['pr', 'view', String(number), '--repo', GITHUB, '--json', 'number,title,url,state,isDraft,reviewDecision,headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,mergedAt,updatedAt,statusCheckRollup,reviews,labels,author']);
    const d = parseJson(r, null);
    if (!d) return { number, error: r.stderr.slice(0, 200) };
    const checks = (d.statusCheckRollup || []).map((c) => ({ name: c.name || c.context, status: c.status || c.state, conclusion: c.conclusion || '' }));
    const data = {
      number: d.number,
      title: d.title,
      url: d.url,
      state: d.state,
      isDraft: d.isDraft,
      reviewDecision: d.reviewDecision,
      head: d.headRefName,
      base: d.baseRefName,
      sha: (d.headRefOid || '').slice(0, 11),
      additions: d.additions,
      deletions: d.deletions,
      changedFiles: d.changedFiles,
      mergedAt: d.mergedAt,
      updatedAt: d.updatedAt,
      labels: (d.labels || []).map((l) => l.name),
      ci: checks.length === 0 ? 'none' : checks.some((c) => c.conclusion === 'FAILURE') ? 'failure' : checks.some((c) => c.status !== 'COMPLETED') ? 'pending' : 'success',
      checks,
      reviewers: Object.entries((d.reviews || []).reduce((acc, rv) => ((acc[rv.author?.login || '?'] = rv.state), acc), {})).map(([login, state]) => ({ login, state })),
    };
    prCache.set(number, { at: Date.now(), data });
    return data;
  }

  // { [artifact name]: { pr, kind, headSha, at } }: which PR head a kit piece was made for
  const metaFile = (slug) => path.join(artDir(slug), '.meta.json');
  const readMeta = (slug) => (fs.existsSync(metaFile(slug)) ? JSON.parse(fs.readFileSync(metaFile(slug), 'utf8')) : {});
  function setArtifactMeta(slug, name, meta) {
    fs.mkdirSync(artDir(slug), { recursive: true });
    fs.writeFileSync(metaFile(slug), JSON.stringify({ ...readMeta(slug), [name]: { ...meta, at: new Date().toISOString() } }, null, 1));
  }

  function listArtifacts(slug) {
    const dir = artDir(slug);
    if (!fs.existsSync(dir)) return [];
    const meta = readMeta(slug);
    // an entry can vanish or be a dangling link between readdir and stat
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).flatMap((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (!st) return [];
      const isDir = st.isDirectory();
      const entry = isDir && fs.existsSync(path.join(full, 'index.html')) ? `${name}/index.html` : name;
      return { name, isDir, size: st.size, mtime: st.mtime.toISOString(), url: `/works/${slug}/artifacts/${entry}`, files: isDir ? fs.readdirSync(full).slice(0, 50) : [], ...(meta[name] ? { meta: meta[name] } : {}) };
    });
  }

  async function importArtifact(slug, src, label, { pr, kind, headSha } = {}) {
    const abs = path.resolve(src.replace(/^~/, HOME));
    if (!config.importRoots.some((r) => abs === r || abs.startsWith(r + path.sep))) throw new Error(`source outside allowed roots: ${abs}`);
    if (!fs.existsSync(abs)) throw new Error(`not found: ${abs}`);
    fs.mkdirSync(artDir(slug), { recursive: true });
    const name = (label || path.basename(abs)).replace(/[^\w.-]+/g, '-');
    const dest = path.join(artDir(slug), name);
    fs.cpSync(abs, dest, { recursive: true });
    const sha = pr && !headSha && /^\d+$/.test(String(pr)) ? (await prInfo(Number(pr))).sha : headSha;
    if (pr || kind) setArtifactMeta(slug, name, { pr: pr ? String(pr) : null, kind: config.kitKinds.includes(kind) ? kind : null, headSha: sha || null });
    const work = get(slug);
    work.timeline = work.timeline || [];
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'artifact', text: `imported ${name} from ${abs}${pr ? ` for #${pr}${sha ? ` at ${String(sha).slice(0, 10)}` : ''}` : ''}` });
    save(work);
    return { name, dest, headSha: sha || null };
  }

  function personasForPaths(paths) {
    if (!fs.existsSync(PERSONAS)) return [];
    const out = [];
    for (const f of fs.readdirSync(PERSONAS).filter((x) => x.endsWith('.md'))) {
      const globs = surfaceGlobs(fs.readFileSync(path.join(PERSONAS, f), 'utf8'));
      if (!globs.length) continue;
      const hits = paths.filter((p) => globs.some((g) => matchGlob(g, p)));
      if (hits.length) out.push({ login: f.replace(/\.md$/, ''), hits: hits.length });
    }
    return out.sort((a, b) => b.hits - a.hits);
  }
  const matchGlob = (glob, p) => globToRegExp(glob).test(p);

  const filesCache = new Map();
  async function prFiles(number) {
    const cached = filesCache.get(number);
    if (cached && Date.now() - cached.at < 120000) return cached.data;
    const r = await gh(['api', '--paginate', `repos/${GITHUB}/pulls/${number}/files?per_page=100`, '--jq', '.[] | {filename,additions,deletions,status}']);
    const data = r.ok ? r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    filesCache.set(number, { at: Date.now(), data });
    return data;
  }
  const bodyCache = new Map();
  async function prBody(number) {
    const cached = bodyCache.get(number);
    if (cached && Date.now() - cached.at < 120000) return cached.data;
    const r = await gh(['pr', 'view', String(number), '--repo', GITHUB, '--json', 'body']);
    const data = parseJson(r, { body: '' }).body || '';
    bodyCache.set(number, { at: Date.now(), data });
    return data;
  }
  const stackInfo = (work, fresh) => Promise.all((work.stack || []).map(async (s) => ({ ...(await prInfo(s.number, fresh)), key: rowKey(s), personas: s.personas || [] })));

  async function plan(work) {
    const prs = await stackInfo(work);
    recordChanges(work.slug, prs);
    const extras = await Promise.all((work.stack || []).map(async (s) => ({ body: s.number ? await prBody(s.number) : '', files: s.number ? await prFiles(s.number) : [], personas: s.personas || [], planned: s.planned || null })));
    return prs.map((pr, i) => ({ ...pr, ...extras[i] }));
  }

  async function stackFiles(work) {
    const prs = work.stack || [];
    if (!prs.length) return [];
    const results = await Promise.all(prs.filter((s) => s.number).map((s) => gh(['pr', 'diff', String(s.number), '--repo', GITHUB, '--name-only'])));
    return [...new Set(results.flatMap((r) => (r.ok ? r.stdout.split('\n').filter(Boolean) : [])))];
  }

  const SNAPS = path.join(ROOT, '.snapshots');
  fs.mkdirSync(SNAPS, { recursive: true });
  const snapFile = (slug) => path.join(SNAPS, `${slug}.json`);
  function recordChanges(slug, prs) {
    const prev = fs.existsSync(snapFile(slug)) ? JSON.parse(fs.readFileSync(snapFile(slug), 'utf8')) : {};
    const next = {};
    const events = [];
    for (const pr of prs) {
      if (pr.error || !pr.number) continue;
      const cur = { state: pr.state, isDraft: pr.isDraft, ci: pr.ci, reviewDecision: pr.reviewDecision, sha: pr.sha, reviewers: Object.fromEntries((pr.reviewers || []).map((r) => [r.login, r.state])) };
      next[pr.number] = cur;
      const old = prev[pr.number];
      if (!old) continue;
      if (old.state !== cur.state) events.push(`#${pr.number} ${cur.state.toLowerCase()}${cur.state === 'MERGED' ? ' 🎉' : ''}`);
      if (old.isDraft && !cur.isDraft) events.push(`#${pr.number} marked ready for review`);
      if (!old.isDraft && cur.isDraft) events.push(`#${pr.number} back to draft`);
      if (old.sha !== cur.sha) events.push(`#${pr.number} new head ${cur.sha}`);
      if (old.ci !== cur.ci && cur.ci !== 'pending') events.push(`#${pr.number} CI ${cur.ci}`);
      for (const [login, st] of Object.entries(cur.reviewers)) if (old.reviewers?.[login] !== st && st !== 'COMMENTED') events.push(`#${pr.number} ${login} ${st.toLowerCase().replace('_', ' ')}`);
    }
    fs.writeFileSync(snapFile(slug), JSON.stringify(next));
    if (events.length) {
      const work = get(slug);
      work.timeline = work.timeline || [];
      for (const text of events.reverse()) work.timeline.unshift({ ts: new Date().toISOString(), kind: 'github', text });
      save(work);
    }
    return events;
  }

  const isDone = (work, prs) => !(work.stack || []).some((s) => !s.number) && prs.length > 0 && prs.every((p) => p.state === 'MERGED' || p.state === 'CLOSED') && prs.some((p) => p.state === 'MERGED');

  function setArchived(slug, archived, reason) {
    const work = get(slug);
    if (!work) return null;
    work.timeline = work.timeline || [];
    if (archived) {
      work.archived = { at: new Date().toISOString(), reason };
      work.timeline.unshift({ ts: work.archived.at, kind: 'archive', text: reason === 'auto' ? 'archived: every PR merged or closed' : 'archived by hand' });
      for (const s of work.stack || []) if (s.number) hooks.onArchived?.(s.number);
    } else {
      delete work.archived;
      work.autoArchive = false;
      work.timeline.unshift({ ts: new Date().toISOString(), kind: 'archive', text: 'unarchived by hand; auto-archive off for this work' });
    }
    return save(work);
  }

  async function sweepArchive() {
    for (const work of list()) {
      if (work.archived || work.autoArchive === false || !(work.stack || []).length) continue;
      const prs = await Promise.all(work.stack.map((s) => prInfo(s.number)));
      if (isDone(work, prs)) setArchived(work.slug, true, 'auto');
    }
  }

  async function detail(slug, fresh = false) {
    const work = get(slug);
    if (!work) return null;
    const prs = await stackInfo(work, fresh);
    const events = recordChanges(slug, prs);
    const artifacts = listArtifacts(slug);
    if (!work.archived && work.autoArchive !== false && isDone(work, prs)) setArchived(slug, true, 'auto');
    const current = events.length || get(slug).archived !== work.archived ? get(slug) : work;
    return { ...current, prs, artifacts, notionStatus: notion.status({ ...current, artifacts }, prs), fetchedAt: new Date().toISOString() };
  }

  async function handle(req, res, parts, readBody, send) {
    const [, a, b, c] = parts;
    if (!a) {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body.slug || !body.title) return send(res, 400, { error: 'slug and title required' });
        if (get(body.slug)) return send(res, 409, { error: 'exists' });
        return send(res, 200, save({ stack: [], links: [], personas: [], notes: '', timeline: [{ ts: new Date().toISOString(), kind: 'created', text: 'work created' }], createdAt: new Date().toISOString(), ...body }));
      }
      return send(res, 200, list());
    }
    const work = get(a);
    if (!work) return send(res, 404, { error: 'no such work' });
    if (b === 'artifacts' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      try {
        return send(res, 200, await importArtifact(a, body.path, body.label, { pr: body.pr, kind: body.kind, headSha: body.headSha }));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (b === 'personas-suggest') {
      const url = new URL(req.url, 'http://x');
      const pr = url.searchParams.get('pr');
      const files = pr ? (await prFiles(Number(pr))).map((f) => f.filename) : await stackFiles(work);
      return send(res, 200, { files: files.length, personas: personasForPaths(files) });
    }
    if (b === 'plan') return send(res, 200, { ...work, prs: await plan(work) });
    if (b === 'timeline' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      work.timeline = work.timeline || [];
      work.timeline.unshift({ ts: new Date().toISOString(), kind: body.kind || 'note', text: body.text });
      return send(res, 200, save(work));
    }
    if (b === 'decisions' && c && req.method === 'PUT') {
      const card = { ...JSON.parse(await readBody(req)), id: decodeURIComponent(c) };
      try {
        return send(res, 200, await upsertDecision(a, card));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (b === 'decisions' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const next = decide(a, body);
      return next ? send(res, 200, next) : send(res, 400, { error: 'unknown decision or option' });
    }
    if (b === 'archive' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, setArchived(a, body.archived !== false, 'manual'));
    }
    if (b === 'notion' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.action === 'link') return send(res, 200, notion.link(a, body.url));
      if (body.action === 'unlink') return send(res, 200, notion.unlink(a));
      if (body.action === 'discard-preview') return send(res, 200, notion.discardPreview(a));
      return send(res, 200, await notion.sync(a, { force: Boolean(body.force), parentPageId: body.parentPageId || null, mode: body.mode || 'apply' }));
    }
    if (b === 'notion' && req.method === 'GET') return send(res, 200, notion.status({ ...work, artifacts: listArtifacts(a) }, await Promise.all((work.stack || []).map((s) => prInfo(s.number)))));
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      try {
        if ('next' in body) body.next = validateNext(body.next);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      return send(res, 200, save({ ...work, ...body, slug: work.slug }));
    }
    if (req.method === 'DELETE') {
      fs.rmSync(file(a));
      return send(res, 200, { ok: true });
    }
    const fresh = new URL(req.url, 'http://x').searchParams.get('fresh') === '1';
    return send(res, 200, await detail(a, fresh));
  }

  function serveArtifact(res, urlPath, send) {
    const rel = decodeURIComponent(urlPath.replace(/^\/works\//, ''));
    const [slug, ...rest] = rel.split('/');
    const base = artDir(slug);
    const full = path.resolve(base, rest.slice(1).join('/'));
    if (!full.startsWith(base) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  }

  // a review remark (watch point or comment verdict) goes to the notes under "## Review remarks" and to the timeline
  const remark = (slug, { n, where, verdict, text }) => {
    const work = get(slug);
    if (!work || !text?.trim()) return null;
    const line = `- ${keyLabel(n)} ${where} ${verdict}: ${text.trim()}`;
    const notes = (work.notes || '').trimEnd();
    work.notes = `${notes}${notes.includes('## Review remarks') ? '' : '\n\n## Review remarks'}\n${line}\n`;
    work.timeline = work.timeline || [];
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'review', text: `${keyLabel(n)} ${where} ${verdict}: ${text.trim()}` });
    return save(work);
  };

  // appends a bullet at the end of a "## heading" section, creating the section at the end when missing
  const appendUnder = (notes, heading, line) => {
    const lines = (notes || '').trimEnd().split('\n');
    const start = lines.indexOf(heading);
    if (start < 0) return `${lines.join('\n')}\n\n${heading}\n${line}\n`;
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    lines.splice(end, 0, line);
    return `${lines.join('\n')}\n`;
  };

  // a decision taken, reopened or archived on a work: the card state, a bullet under "## Decisions taken", a timeline entry
  const decide = (slug, { id, choice, rationale, status, archived }) => {
    const work = get(slug);
    const decision = (work?.decisions || []).find((d) => d.id === id);
    if (!decision) return null;
    const ts = new Date().toISOString();
    work.timeline = work.timeline || [];
    if (typeof archived === 'boolean') {
      decision.archivedAt = archived ? ts : null;
      work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: ${archived ? 'archived' : 'unarchived'}` });
      return save(work);
    }
    if (status === 'pending') {
      Object.assign(decision, { status: 'pending', choice: null, rationale: '', decidedAt: null });
      work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: reopened` });
      return save(work);
    }
    if (!validChoice(decision, choice)) return null;
    Object.assign(decision, { status: 'taken', choice, rationale: (rationale || '').trim(), decidedAt: ts });
    work.notes = appendUnder(work.notes, '## Decisions taken', decisionBullet(decision));
    work.timeline.unshift({ ts, kind: 'decision', text: `${decision.title}: ${decisionSummary(decision)}` });
    return save(work);
  };

  // one card added or updated by id; fields left out (e.g. the user's choice) stay as they are.
  // Typed blocks as on findings: `details` becomes their markdown twin, a suggestion's `before` is read at the card's `sha`.
  const upsertDecision = async (slug, input) => {
    const work = get(slug);
    work.decisions = work.decisions || [];
    const decision = work.decisions.find((d) => d.id === input.id);
    const card = { ...input, ...validateRich(input) };
    if (card.blocks) {
      const sha = card.sha || decision?.sha;
      if (sha) await readSuggestionBefore(card.blocks, (p) => run('git', ['-C', REPO, 'show', `${sha}:${p}`]).then((r) => (r.ok ? r.stdout.replace(/\n$/, '').split('\n') : null)));
      card.details = blocksToMarkdown({ summary: card.summary ?? decision?.summary, blocks: card.blocks, sources: card.sources ?? decision?.sources });
    }
    if (decision) Object.assign(decision, card);
    else work.decisions.push({ status: 'pending', ...card });
    return save(work);
  };

  return { paseo, handle, serveArtifact, list, get, save, remark, decide, upsertDecision, sweepArchive, personasForPaths, prInfo, prBody, listArtifacts, setArtifactMeta, hooks };
}
