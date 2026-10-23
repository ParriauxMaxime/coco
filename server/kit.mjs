// Kit freshness: for each kit piece of a PR (config.kitKinds, plus the Notion sync), the head it was made for
// and a stale flag once the PR's own change moved. The change is the patch-id of the PR diff, so a rebase keeps it;
// without one, a piece is compared by time to the last authored commit, which a rebase keeps too.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kitFlags } from './briefs.mjs';
import { branchOf, isLocal, parseKey, rowKey } from './stack.mjs';

const TTL_MS = 60000;
const VIDEO = /user-attachments\/assets|\.(mp4|webm|mov)\b/i;
const PATCH_ID = 'git diff "$(git merge-base "$1" "$2")" "$2" | git patch-id --stable';

const defaultExec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 60000, cwd }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });

const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
const latest = (dates) => dates.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;

// missing, off (not expected), fresh, stale, or present (made, but nothing tells for which change)
export function freshness(piece, head) {
  if (!piece) return 'missing';
  if (piece.patchId && head.patchId) return piece.patchId === head.patchId ? 'fresh' : 'stale';
  if (piece.headSha && sameSha(piece.headSha, head.sha)) return 'fresh';
  const at = head.authoredAt || head.at;
  if (piece.at && at) return Date.parse(piece.at) >= Date.parse(at) ? 'fresh' : 'stale';
  return 'present';
}

const IN_BODY = { body: () => true, diagram: (b) => /```mermaid/.test(b), video: (b) => VIDEO.test(b) };

// links: { [kind]: piece } for kinds made outside the PR body, e.g. a companion PR in another repo
// head: { sha, at, authoredAt, patchId }; bodyPatchId: the change the body was written for; patchIds: { [artifact headSha]: patchId }
export function kitPieces({ kinds = ['body', 'diagram', 'video'], flags, artifacts, n, body = '', bodyAt = null, bodyPatchId = null, patchIds = {}, head, links = {}, notion = null }) {
  const made = (kind) => artifacts.filter((a) => a.meta?.kind === kind && a.meta.pr === String(n)).sort((a, b) => b.meta.at.localeCompare(a.meta.at))[0];
  const fromArtifact = (kind) => {
    const a = made(kind);
    return a && { headSha: a.meta.headSha, at: a.meta.at, source: a.name, patchId: patchIds[a.meta.headSha] || null };
  };
  const inBody = (test) => (body.trim() && test(body) ? { at: bodyAt, source: 'PR body', patchId: bodyPatchId } : null);
  const pieces = [...kinds.map((k) => [k, k, fromArtifact(k) || (IN_BODY[k] ? inBody(IN_BODY[k]) : links[k] || null)]), ['notion', 'Notion', notion]];
  return pieces.map(([id, label, piece]) => {
    const off = id !== 'notion' && !flags[id] && !piece;
    return { id, label, state: off ? 'off' : id === 'notion' && !piece ? 'off' : freshness(piece, head), madeFor: piece?.headSha || null, at: piece?.at || null, source: piece?.source || null };
  });
}

export function createKit({ REPO, DATA, config, works, betaFlags, exec = defaultExec }) {
  const [owner, name] = (config.repo.github || '/').split('/');
  const extraKinds = config.kitKinds.filter((k) => !IN_BODY[k]);
  const cache = new Map();
  const cached = (key, fn) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = fn();
    cache.set(key, { at: Date.now(), value });
    value.catch(() => cache.delete(key));
    return value;
  };
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };

  // { [row key]: { bodyAt, patchId, heads: { [sha]: patchId } } }: the change each body was written for, and the change of each head seen
  const recordsFile = DATA ? path.join(DATA, 'kit-patch-ids.json') : '';
  let records = null;
  const recordOf = (key) => {
    records ||= (recordsFile && fs.existsSync(recordsFile) && json({ stdout: fs.readFileSync(recordsFile, 'utf8') })) || {};
    return records[key] || {};
  };
  const record = (key, patch) => {
    records[key] = { ...recordOf(key), ...patch };
    if (recordsFile) fs.writeFileSync(recordsFile, JSON.stringify(records, null, 1));
  };

  const patchIdOf = (base, sha) =>
    !REPO || !base || !sha ? Promise.resolve(null) : cached(`patch:${base}:${sha}`, async () => (await exec('sh', ['-c', PATCH_ID, 'sh', base, sha], REPO)).stdout.trim().split(' ')[0] || null);
  const knownPatchId = (key, sha) => Object.entries(recordOf(key).heads || {}).find(([s]) => sameSha(s, sha))?.[1] || null;
  const headPatchId = async (key, base, sha) => {
    const id = knownPatchId(key, sha) || (await patchIdOf(base, sha));
    if (id && !knownPatchId(key, sha)) record(key, { heads: Object.fromEntries([...Object.entries(recordOf(key).heads || {}), [sha, id]].slice(-20)) });
    return id;
  };
  // a body seen for the first time is pinned to the current change, unless a commit was authored after it
  const bodyPatchIdOf = (key, bodyAt, head) => {
    const rec = recordOf(key);
    if (rec.bodyAt === bodyAt) return rec.patchId || null;
    if (!head.patchId || !(Date.parse(bodyAt) >= Date.parse(head.authoredAt))) return null;
    record(key, { bodyAt, patchId: head.patchId });
    return head.patchId;
  };

  const prFacts = (number) => cached(`pr:${number}`, async () => {
    if (!owner || !name) throw new Error('no GitHub repo configured (repo.github)');
    const q = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){body lastEditedAt createdAt headRefOid baseRefOid commits(last:100){nodes{commit{committedDate authoredDate}}}}}}`;
    const p = json(await exec('gh', ['api', 'graphql', '-f', `query=${q}`]))?.data?.repository?.pullRequest;
    if (!p) throw new Error(`cannot read #${number}`);
    const commits = p.commits.nodes.map((c) => c.commit);
    return { body: p.body || '', bodyAt: p.lastEditedAt || p.createdAt, base: p.baseRefOid, authoredAt: latest(commits.map((c) => c.authoredDate)), head: { sha: p.headRefOid, at: commits.at(-1)?.committedDate || null } };
  });
  const branchFacts = async (branch, base) => {
    const log = (range) => (REPO ? exec('git', ['-C', REPO, 'log', '--format=%H %cI %aI', `refs/heads/${branch}`, ...range]) : { stdout: '' });
    const own = (await log(['--not', base])).stdout.trim();
    const lines = (own || (await log(['-1'])).stdout.trim()).split('\n').filter(Boolean).map((l) => l.split(' '));
    const [sha, at] = lines[0] || [];
    return { body: '', bodyAt: null, base, authoredAt: latest(lines.map((l) => l[2])), head: { sha: sha || null, at: at || null } };
  };
  const localBase = (work, row) => {
    const parent = work.stack[work.stack.indexOf(row) - 1]?.planned?.branch;
    return parent ? `refs/heads/${parent}` : `origin/${config.repo.defaultBranch || 'main'}`;
  };
  // a kind made outside the PR body is the work link whose label or url names it; a GitHub PR link dates it
  const linkOf = (work, kind) => {
    const link = (work.links || []).find((l) => `${l.label} ${l.url}`.toLowerCase().includes(kind.toLowerCase()));
    if (!link) return Promise.resolve(null);
    if (!/github\.com\/.+\/pull\/\d+/.test(link.url)) return Promise.resolve({ at: null, source: link.url });
    return cached(`link:${link.url}`, async () => {
      const d = json(await exec('gh', ['pr', 'view', link.url, '--json', 'updatedAt']));
      return { at: d?.updatedAt || null, source: link.url };
    });
  };

  async function view(slug, raw) {
    const work = works.get(slug);
    if (!work) throw Object.assign(new Error('no such work'), { status: 404 });
    const n = parseKey(raw);
    const row = (work.stack || []).find((s) => rowKey(s) === n);
    if (!row) throw Object.assign(new Error(`${raw} is not in this work`), { status: 404 });
    const facts = isLocal(n) ? await branchFacts(branchOf(n), localBase(work, row)) : await prFacts(n);
    const key = String(n);
    const artifacts = works.listArtifacts(slug);
    const shas = [...new Set(artifacts.filter((a) => a.meta?.pr === key && a.meta.headSha).map((a) => a.meta.headSha))];
    const head = { ...facts.head, authoredAt: facts.authoredAt, patchId: await headPatchId(key, facts.base, facts.head.sha) };
    const patchIds = Object.fromEntries(await Promise.all(shas.map(async (s) => [s, knownPatchId(key, s) || (await patchIdOf(facts.base, s))])));
    const bodyPatchId = facts.bodyAt ? bodyPatchIdOf(key, facts.bodyAt, head) : null;
    const notion = work.notion?.syncedAt ? { at: work.notion.syncedAt, source: work.notion.url } : null;
    // the feature flags a tester needs for this PR, and whether its body already names each one
    const betas = (betaFlags?.forRow(work, n) || []).map((f) => ({ ...f, inBody: facts.body.includes(f.code) }));
    const links = Object.fromEntries(await Promise.all(extraKinds.map(async (k) => [k, await linkOf(work, k)])));
    return { key: n, head: facts.head, betaFlags: betas, pieces: kitPieces({ kinds: config.kitKinds, flags: kitFlags(work, row, config.kitKinds), artifacts, n, body: facts.body, bodyAt: facts.bodyAt, bodyPatchId, patchIds, head, links, notion }) };
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      return send(res, 200, await view(parts[1], decodeURIComponent(parts[3] || '')));
    } catch (e) {
      return send(res, e.status || 500, { error: e.message });
    }
  }

  return { handle, view };
}
