// Kit freshness: for each kit piece of a PR (config.kitKinds, plus the Notion sync), the head it was made for
// and a stale flag once the head moved. Artifacts carry the head sha; GitHub pieces and syncs are compared by time.
import { execFile } from 'node:child_process';
import { kitFlags } from './briefs.mjs';
import { branchOf, isLocal, parseKey, rowKey } from './stack.mjs';

const TTL_MS = 60000;
const VIDEO = /user-attachments\/assets|\.(mp4|webm|mov)\b/i;

const defaultExec = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 60000, cwd }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });

const sameSha = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

// missing, off (not expected), fresh, stale, or present (made, but nothing tells for which head)
export function freshness(piece, head) {
  if (!piece) return 'missing';
  if (piece.headSha && head.sha) return sameSha(piece.headSha, head.sha) ? 'fresh' : 'stale';
  if (piece.at && head.at) return piece.at >= head.at ? 'fresh' : 'stale';
  return 'present';
}

const IN_BODY = { body: () => true, diagram: (b) => /```mermaid/.test(b), video: (b) => VIDEO.test(b) };

// links: { [kind]: piece } for kinds made outside the PR body, e.g. a companion PR in another repo
export function kitPieces({ kinds = ['body', 'diagram', 'video'], flags, artifacts, n, body = '', bodyAt = null, head, links = {}, notion = null }) {
  const made = (kind) => artifacts.filter((a) => a.meta?.kind === kind && a.meta.pr === String(n)).sort((a, b) => b.meta.at.localeCompare(a.meta.at))[0];
  const fromArtifact = (kind) => {
    const a = made(kind);
    return a && { headSha: a.meta.headSha, at: a.meta.at, source: a.name };
  };
  const inBody = (test) => (body.trim() && test(body) ? { at: bodyAt, source: 'PR body' } : null);
  const pieces = [...kinds.map((k) => [k, k, fromArtifact(k) || (IN_BODY[k] ? inBody(IN_BODY[k]) : links[k] || null)]), ['notion', 'Notion', notion]];
  return pieces.map(([id, label, piece]) => {
    const off = id !== 'notion' && !flags[id] && !piece;
    return { id, label, state: off ? 'off' : id === 'notion' && !piece ? 'off' : freshness(piece, head), madeFor: piece?.headSha || null, at: piece?.at || null, source: piece?.source || null };
  });
}

export function createKit({ REPO, config, works, betaFlags, exec = defaultExec }) {
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

  const prFacts = (number) => cached(`pr:${number}`, async () => {
    if (!owner || !name) throw new Error('no GitHub repo configured (repo.github)');
    const q = `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${number}){body lastEditedAt createdAt headRefOid commits(last:1){nodes{commit{committedDate}}}}}}`;
    const p = json(await exec('gh', ['api', 'graphql', '-f', `query=${q}`]))?.data?.repository?.pullRequest;
    if (!p) throw new Error(`cannot read #${number}`);
    return { body: p.body || '', bodyAt: p.lastEditedAt || p.createdAt, head: { sha: p.headRefOid, at: p.commits.nodes[0]?.commit.committedDate || null } };
  });
  const branchFacts = async (branch) => {
    const r = REPO ? await exec('git', ['-C', REPO, 'log', '-1', '--format=%H %cI', `refs/heads/${branch}`]) : { stdout: '' };
    const [sha, at] = r.stdout.trim().split(' ');
    return { body: '', bodyAt: null, head: { sha: sha || null, at: at || null } };
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
    const facts = isLocal(n) ? await branchFacts(branchOf(n)) : await prFacts(n);
    const notion = work.notion?.syncedAt ? { at: work.notion.syncedAt, source: work.notion.url } : null;
    // the feature flags a tester needs for this PR, and whether its body already names each one
    const betas = (betaFlags?.forRow(work, n) || []).map((f) => ({ ...f, inBody: facts.body.includes(f.code) }));
    const links = Object.fromEntries(await Promise.all(extraKinds.map(async (k) => [k, await linkOf(work, k)])));
    return { key: n, head: facts.head, betaFlags: betas, pieces: kitPieces({ kinds: config.kitKinds, flags: kitFlags(work, row, config.kitKinds), artifacts: works.listArtifacts(slug), n, body: facts.body, bodyAt: facts.bodyAt, head: facts.head, links, notion }) };
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
