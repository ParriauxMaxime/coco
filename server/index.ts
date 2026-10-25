import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWorks } from './works.ts';
import { createAsk } from './ask.ts';
import { createCode } from './code.ts';
import { createComments } from './comments.ts';
import { createReviewAgent } from './review-agent.ts';
import { createLang } from './lang.ts';
import { createReviewPlan } from './review-plan.ts';
import { createPaseoLink } from './paseo-link.ts';
import { createStackFix } from './stack-fix.ts';
import { createReviewImport } from './review-import.ts';
import { createThreads } from './threads.ts';
import { createFindings } from './findings.ts';
import { createMedia } from './media.ts';
import { createBriefs } from './briefs.ts';
import { createRules } from './rules.ts';
import { createGates } from './gates.ts';
import { createStackKeeper, needsKeeping } from './stack-keeper.ts';
import { createInbox } from './inbox.ts';
import { createKit } from './kit.ts';
import { createFeatureFlags } from './feature-flags.ts';
import { createPack } from './pack.ts';
import { createSetup } from './setup.ts';
import { createDevServers } from './dev-servers.ts';
import { loadConfig, personaLogins } from './config.ts';
import { createPaseoAgents } from './paseo-agent.ts';
import { errorMessage } from './core-types.ts';
import type { Req, Res, RunResult, Send, Work } from './core-types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const config = loadConfig({ APP });
const SKILLS = config.skillsDir;
const PERSONAS = config.personasDir;
const REPO = config.repo.path;
const REVIEWS = REPO ? path.join(REPO, config.repo.reviewsDir) : '';
const DATA = config.dataDir;
const DIST = path.join(APP, 'dist');
const BRIEFS = config.briefsDir;
const PORT = Number(process.argv[2] || new URL(config.baseUrl).port || 8777);
const BIND = process.argv[3] || '127.0.0.1';

interface FeedbackItem {
  node?: unknown;
  ts?: string;
  [key: string]: unknown;
}

fs.mkdirSync(DATA, { recursive: true });
const paseoAgents = createPaseoAgents({ APP });
const works = createWorks({ DATA, PERSONAS, REPO, config, agents: paseoAgents });
const ask = createAsk({ DATA, APP, REPO, config, works, agents: paseoAgents });
const rules = createRules({ DATA, config, works, ask });
const inbox = createInbox({ config, ask });
const code = createCode({ REPO, config, works });
works.hooks.onArchived = (n) => code.dropRefs(n).catch(() => {});
const comments = createComments({ DATA, REPO, config, works });
const reviewAgent = createReviewAgent({ DATA, REPO, config, works, comments, agents: paseoAgents });
const lang = createLang({ REPO, config });
const reviewPlan = createReviewPlan({ DATA, REPO, config, APP, code, works, rules, agents: paseoAgents });
const stackFix = createStackFix({ DATA, REPO, config, works, comments, code, reviewAgent });
const reviewImport = createReviewImport({ REPO, config, works, comments, code, reviewAgent });
const threads = createThreads({ DATA, REPO, config, works, comments, reviewAgent, reviewPlan, agents: paseoAgents });
const findings = createFindings({ DATA, REPO, config, works, comments, code, reviewPlan, reviewAgent, threads });
threads.setFindingActor(findings.actOnComment);
const media = createMedia({ DATA, works });
const betaFlags = createFeatureFlags({ REPO, config });
const briefs = createBriefs({ DATA, REPO, config, works, comments, reviewAgent, rules, betaFlags });
const gates = createGates({ config, works, reviewAgent, reviewPlan });
const stackKeeper = createStackKeeper({ REPO, config, works, reviewAgent });
const kit = createKit({ REPO, DATA, config, works, betaFlags });
const pack = createPack({ APP, DATA, config });
const setup = createSetup({ APP, config, works, personaCount: () => listPersonas().length, agents: paseoAgents });
const paseoLink = createPaseoLink({ config, works, comments, code, reviewAgent, stackFix, threads });
const devServers = createDevServers({ REPO, config, works });
works.sweepArchive().catch(() => {});
setInterval(() => works.sweepArchive().catch(() => {}), 10 * 60 * 1000);
ask.boot();
fs.mkdirSync(BRIEFS, { recursive: true });

const send: Send = (res, code, body, type = 'application/json') => {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(data);
};
const readBody = (req: Req) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => resolve(raw));
  });
const safeJoin = (root: string, name: string) => {
  const full = path.resolve(root, name);
  if (!full.startsWith(root + path.sep) && full !== root) throw new Error('outside root');
  return full;
};
const run = (cmd: string, args: string[], opts: ExecFileOptions = {}) =>
  new Promise<RunResult>((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

const frontmatter = (text: string) => {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
};
const section = (text: string, heading: string) => {
  const re = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |\\Z(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  return m ? m[1] : '';
};
const countListItems = (text: string) => (text.match(/^\s*(?:[-*]|\d+\.)\s/gm) || []).length;

function listPersonas() {
  if (!fs.existsSync(PERSONAS)) return [];
  const files = fs.readdirSync(PERSONAS);
  return personaLogins(files, config.personaFiles).map((login) => {
    const md = fs.readFileSync(path.join(PERSONAS, `${login}.md`), 'utf8');
    const title = (md.match(/^# (.*)$/m) || [])[1] || login;
    const mined = (md.match(/Mined (\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const ageDays = mined ? Math.floor((Date.now() - new Date(mined).getTime()) / 86400000) : null;
    const surfaces = (section(md, 'Surfaces').match(/^\s+- name:/gm) || []).length;
    const checks = countListItems(section(md, 'What he checks') || section(md, 'What they check') || section(md, 'What he checks before sending'));
    const calibration = countListItems(section(md, 'Calibration'));
    const related = files.filter((f) => f.startsWith(login) && f !== `${login}.md`);
    const kind = /message-writer/i.test(md) ? 'writer' : 'reviewer';
    const github = (title.match(/`([\w-]+)`/) || [])[1] || (md.match(/GitHub `([\w-]+)`/) || [])[1] || login;
    return {
      login,
      title,
      kind,
      github,
      avatar: `/api/avatar/${login}`,
      mined,
      ageDays,
      stale: ageDays != null && ageDays > 60,
      surfaces,
      checks,
      calibration,
      hasJson: files.includes(`${login}.json`),
      hasSlack: files.includes(`${login}-slack-addendum.md`),
      files: [`${login}.md`, ...related],
    };
  });
}

const PREFIX = config.skillPrefix;
const mine = (name: string) => Boolean(PREFIX) && name.startsWith(PREFIX);
function listSkills() {
  if (!fs.existsSync(SKILLS)) return [];
  return fs
    .readdirSync(SKILLS)
    .filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md')))
    .map((d) => {
      const file = path.join(SKILLS, d, 'SKILL.md');
      const text = fs.readFileSync(file, 'utf8');
      const fm = frontmatter(text);
      const files = fs.readdirSync(path.join(SKILLS, d)).filter((f) => f.endsWith('.md'));
      return {
        name: d,
        description: fm.description || '',
        argumentHint: fm['argument-hint'] || '',
        userInvocable: fm['user-invocable'] === 'true',
        mtime: fs.statSync(file).mtime.toISOString(),
        files,
      };
    })
    .sort((a, b) => (mine(a.name) === mine(b.name) ? a.name.localeCompare(b.name) : mine(a.name) ? -1 : 1));
}

function readFeedback() {
  const file = path.join(DATA, 'feedback.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l): FeedbackItem => JSON.parse(l));
}

async function agents() {
  const [a, w] = await Promise.all([run('paseo', ['ls', '--json']), run('paseo', ['workspace', 'ls', '--json'])]);
  const parse = <T>(r: RunResult): T[] => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return [];
    }
  };
  const agents = parse<{ cwd?: string }>(a).map((x) => ({ ...x, cwd: x.cwd?.replace(/^~/, os.homedir()) }));
  return { agents, workspaces: parse<unknown>(w), error: a.ok ? null : a.stderr };
}

function listReviews() {
  if (!fs.existsSync(REVIEWS)) return [];
  return fs
    .readdirSync(REVIEWS)
    .map((name) => {
      const full = path.join(REVIEWS, name);
      const st = fs.statSync(full);
      const entries = st.isDirectory() ? fs.readdirSync(full) : [];
      return { name, dir: st.isDirectory(), mtime: st.mtime.toISOString(), entries };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

// {field} or {a|b} (first non-empty) from the launch body, plus {briefsDir} and {owner}
const fillRitual = (template: string | undefined, body: Record<string, unknown>) =>
  String(template || '').replace(/\{([\w|]+)\}/g, (_, keys: string) => {
    const vars: Record<string, unknown> = { ...body, briefsDir: BRIEFS, owner: config.owner.name };
    return keys.split('|').map((k) => String(vars[k] ?? '').trim()).find(Boolean) || '';
  });

// sidebar progress from the last GitHub snapshot, no gh call per overview poll
function workProgress(w: Work) {
  const snapFile = path.join(DATA, 'works', '.snapshots', `${w.slug}.json`);
  const snap: Record<string, { state?: string; reviewDecision?: string | null; ci?: string }> = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : {};
  const out = { merged: 0, open: 0, planned: 0, closed: 0, attention: false, restack: needsKeeping(w, snap) };
  for (const s of w.stack || []) {
    const st = s.number ? snap[s.number] : null;
    if (!s.number) out.planned += 1;
    else if (st?.state === 'MERGED') out.merged += 1;
    else if (st?.state === 'CLOSED') out.closed += 1;
    else out.open += 1;
    if (st && (st.reviewDecision === 'CHANGES_REQUESTED' || st.ci === 'failure')) out.attention = true;
  }
  return out;
}

async function launchRitual(body: { kind: string; provider?: string; [key: string]: unknown }) {
  const spec = config.rituals.find((r) => r.kind === body.kind);
  if (!spec) return { ok: false, error: `unknown ritual ${body.kind}` };
  const title = fillRitual(spec.title || spec.label || spec.kind, body);
  const prompt = fillRitual(spec.prompt, body);
  let started: { agentId?: string | null; createdWorkspace?: string | null } = {};
  let error = '';
  try {
    started = await paseoAgents.start({ title, provider: body.provider || config.models.default, thinking: 'high', cwd: REPO || os.homedir(), labels: { source: 'cockpit', ritual: body.kind }, prompt });
  } catch (e) {
    error = errorMessage(e);
  }
  const { agentId = null, createdWorkspace = null } = started;
  const entry = { ts: new Date().toISOString(), kind: body.kind, title, prompt, agentId, ok: !error, out: (error || `started ${agentId}${createdWorkspace ? ` in new workspace ${createdWorkspace}` : ''}`).slice(0, 2000) };
  fs.appendFileSync(path.join(DATA, 'rituals.jsonl'), JSON.stringify(entry) + '\n');
  return entry;
}

function readRituals() {
  const file = path.join(DATA, 'rituals.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse();
}

async function api(req: Req, res: Res, url: URL) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [root, a, b, c] = parts;
  try {
    if (root === 'config') return send(res, 200, { owner: config.owner, repo: { github: config.repo.github, defaultBranch: config.repo.defaultBranch }, baseUrl: config.baseUrl, models: config.models, kitKinds: config.kitKinds, rituals: config.rituals, featureFlags: Boolean(config.featureFlags?.provider) });
    if (root === 'paseo-link') return paseoLink.handle(req, res, parts, readBody, send);
    if (root === 'dev-servers') return devServers.handle(req, res, parts, readBody, send);
    if (root === 'paseo') return send(res, 200, await works.paseo());
    if (root === 'ask') return ask.handle(req, res, parts, readBody, send);
    if (root === 'inbox') return inbox.handle(req, res, parts, readBody, send);
    if (root === 'pack') return pack.handle(req, res, parts, readBody, send);
    if (root === 'setup') return setup.handle(req, res, parts, readBody, send);
    if (root === 'code' && (['definition', 'references', 'hover', 'open'].includes(c) || a === 'lang')) return lang.handle(req, res, parts, readBody, send);
    if (root === 'code') return code.handle(req, res, parts, readBody, send);
    if (root === 'works' && parts[2] === 'prs' && parts[4] === 'comments') return comments.handle(req, res, parts, readBody, send);
    if (root === 'works' && parts[2] === 'prs' && parts[4] === 'review-runs') return reviewAgent.handle(req, res, parts, readBody, send);
    if (root === 'works' && parts[2] === 'prs' && parts[4] === 'review-plan') return reviewPlan.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'stack-fix') return stackFix.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'import-review') return reviewImport.handle(req, res, parts, readBody, send);
    if (root === 'works' && (b === 'threads' || b === 'groups')) return threads.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'findings') return findings.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'media') return media.handle(req, res, parts, send);
    if (root === 'works' && b === 'briefs') return briefs.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'kit') return kit.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'stack-keeper') return stackKeeper.handle(req, res, parts, readBody, send);
    if (root === 'works' && b === 'gates') return gates.handle(req, res, parts, readBody, send);
    if ((root === 'works' && b === 'rules') || root === 'rules') return rules.handle(req, res, parts, readBody, send);
    if (root === 'works') return works.handle(req, res, parts, readBody, send);
    if (root === 'overview') {
      const personas = listPersonas();
      const skills = listSkills().filter((s) => !PREFIX || mine(s.name));
      const feedback = readFeedback();
      const ag = await agents();
      const pj = await run('paseo', ['project', 'ls', '--json']);
      let projectCount = 0;
      try { projectCount = JSON.parse(pj.stdout).length; } catch {}
      const read = (n: string) => (fs.existsSync(path.join(PERSONAS, n)) ? fs.readFileSync(path.join(PERSONAS, n), 'utf8') : '');
      return send(res, 200, { projectCount, personas, skills, works: works.list().map((w) => ({ slug: w.slug, title: w.title, projectName: w.projectName, stack: (w.stack || []).length, progress: workProgress(w), updatedAt: w.updatedAt, archived: w.archived || null })), feedback: feedback.slice(-20).reverse(), feedbackCount: feedback.length, agents: ag.agents.slice(0, 12), agentsError: ag.error, backlog: read('backlog.md'), changelog: read('CHANGELOG.md'), rituals: readRituals().slice(0, 10) });
    }
    if (root === 'personas' && !a) return send(res, 200, listPersonas());
    if (root === 'personas' && a && b === 'files' && c) {
      const file = safeJoin(PERSONAS, decodeURIComponent(c));
      if (req.method === 'PUT') {
        const text = await readBody(req);
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, text);
        return send(res, 200, { ok: true, bytes: text.length });
      }
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(file, 'utf8'), file.endsWith('.json') ? 'application/json' : 'text/plain');
    }
    if (root === 'personas' && a && !b) {
      const p = listPersonas().find((x) => x.login === a);
      if (!p) return send(res, 404, { error: 'not found' });
      const md = fs.readFileSync(path.join(PERSONAS, `${a}.md`), 'utf8');
      const json = p.hasJson ? JSON.parse(fs.readFileSync(path.join(PERSONAS, `${a}.json`), 'utf8')) : null;
      return send(res, 200, { ...p, md, json, feedback: readFeedback().filter((f) => String(f.node).startsWith(`persona:${a}`)).reverse() });
    }
    if (root === 'avatar' && a) {
      const login = decodeURIComponent(a);
      const local = ['png', 'jpg', 'jpeg', 'webp'].map((ext) => path.join(DATA, 'avatars', `${login}.${ext}`)).find((f) => fs.existsSync(f));
      const avatarTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
      if (local) return send(res, 200, fs.readFileSync(local), avatarTypes[path.extname(local).slice(1)]);
      const p = listPersonas().find((x) => x.login === login);
      res.writeHead(302, { Location: `https://github.com/${p?.github || login}.png?size=96`, 'Cache-Control': 'public, max-age=3600' });
      return res.end();
    }
    if (root === 'skills' && !a) return send(res, 200, listSkills());
    if (root === 'skills' && a && b === 'files' && c) {
      const file = safeJoin(path.join(SKILLS, a), decodeURIComponent(c));
      if (req.method === 'PUT') {
        const text = await readBody(req);
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, text);
        return send(res, 200, { ok: true, bytes: text.length });
      }
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(file, 'utf8'), 'text/plain');
    }
    if (root === 'skills' && a) {
      const s = listSkills().find((x) => x.name === a);
      if (!s) return send(res, 404, { error: 'not found' });
      return send(res, 200, { ...s, md: fs.readFileSync(path.join(SKILLS, a, 'SKILL.md'), 'utf8') });
    }
    if (root === 'agents') return send(res, 200, await agents());
    if (root === 'agents-activity' && a) {
      const r = await run('paseo', ['logs', a, '--tail', '40']);
      return send(res, 200, { ok: r.ok, out: r.stdout.slice(-20000), err: r.stderr.slice(0, 2000) });
    }
    if (root === 'reviews') return send(res, 200, listReviews());
    if (root === 'reviews' && a) return send(res, 200, listReviews());
    if (root === 'feedback') {
      if (req.method === 'POST') {
        const item: FeedbackItem = JSON.parse(await readBody(req));
        item.ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
        fs.appendFileSync(path.join(DATA, 'feedback.jsonl'), JSON.stringify(item) + '\n');
        return send(res, 200, { ok: true });
      }
      return send(res, 200, readFeedback().reverse());
    }
    if (root === 'rituals') {
      if (req.method === 'POST') return send(res, 200, await launchRitual(JSON.parse(await readBody(req))));
      return send(res, 200, { kinds: config.rituals.map((r) => r.kind), rituals: config.rituals, history: readRituals() });
    }
    return send(res, 404, { error: 'no route' });
  } catch (e) {
    return send(res, 500, { error: errorMessage(e) });
  }
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
function serveStatic(res: Res, url: URL) {
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) return send(res, 503, 'run `npm run build` first', 'text/plain');
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    // module handlers are returned, not awaited, inside api's try: their rejections land here instead of killing the server
    if (url.pathname.startsWith('/api/')) return api(req, res, url).catch((e) => (res.headersSent ? res.end() : send(res, 500, { error: errorMessage(e) })));
    if (url.pathname.startsWith('/works/')) return works.serveArtifact(res, url.pathname, send);
    return serveStatic(res, url);
  })
  .listen(PORT, BIND, () => console.log(`cocopilot on http://${BIND}:${PORT}  (personas: ${PERSONAS})`));
