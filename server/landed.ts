// Landed rows: a planned row shipped straight to the default branch, with no PR. Its agent or the owner says so, or git shows it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HttpError, errorMessage } from './core-types.ts';
import { keyLabel, orderOf, parseKey, rowKey } from './stack.ts';
import type { Landed, RunResult, StackRow, Work } from './core-types.ts';

export type Git = (args: string[]) => Promise<RunResult>;
export const SHA = /^[0-9a-f]{7,40}$/i;
// the mark agents put on a shipped row's title before rows could land
const SHIPPED = /^✓\s*/;

// a row by its planned order, its key (r:<order>, b:<branch>) or its branch; a row with no branch reads as row <order>
export function landedRow(stack: StackRow[], ref: unknown): StackRow {
  const s = String(ref ?? '').trim();
  const order = /^\d+$/.test(s) ? Number(s) : orderOf(s);
  const rows = order != null ? stack.filter((r) => rowKey(r) === `r:${order}` || r.planned?.order === order) : s.startsWith('b:') ? stack.filter((r) => rowKey(r) === parseKey(s)) : stack.filter((r) => r.planned?.branch === s);
  if (!rows.length) throw new HttpError(404, `no row ${s || '(none)'} in this work: pass its order or branch`);
  if (rows.length > 1) throw new HttpError(409, `${rows.length} rows on ${s}: pass the order`);
  return rows[0];
}

// a commit's full sha and date, when the repo has it
export async function commitOf(git: Git, rev: string): Promise<Omit<Landed, 'by'> | null> {
  const r = await git(['log', '-1', '--format=%H %cI', `${rev}^{commit}`, '--']);
  const [sha, at] = r.ok ? r.stdout.trim().split(' ') : [];
  return sha && at ? { sha, at } : null;
}

export const onBase = async (git: Git, sha: string, base: string) => (await git(['merge-base', '--is-ancestor', sha, `refs/heads/${base}`])).ok;

// a branch landed when it moved since it was created (its oldest reflog entry) and its tip sits on the base branch
export async function landedTip(git: Git, branch: string, base: string): Promise<Omit<Landed, 'by'> | null> {
  if (branch === base) return null;
  const tip = await commitOf(git, `refs/heads/${branch}`);
  if (!tip || !(await onBase(git, tip.sha, base))) return null;
  const created = (await git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`])).stdout.trim().split('\n').at(-1);
  return created && created !== tip.sha ? tip : null;
}

// one-time, idempotent: a row whose title an agent marked "✓ " by hand loses the mark and lands, at its branch tip when that landed, else the base tip
export async function backfillLanded(store: { list(): Work[]; save(work: Work, opts?: { touch?: boolean }): unknown }, gitOf: (work: Work) => { git: Git; base: string }) {
  const done: { slug: string; rows: number }[] = [];
  for (const work of store.list()) {
    const rows = (work.stack || []).filter((s) => !s.number && SHIPPED.test(s.planned?.title || ''));
    if (!rows.length) continue;
    const { git, base } = gitOf(work);
    const tip = await commitOf(git, `refs/heads/${base}`);
    if (!tip) continue;
    for (const s of rows) {
      const branch = s.planned?.branch;
      s.planned = { ...s.planned, title: s.planned?.title?.replace(SHIPPED, '') };
      s.landed ??= { ...((branch && (await landedTip(git, branch, base))) || tip), by: 'owner' };
    }
    store.save(work, { touch: false });
    done.push({ slug: work.slug, rows: rows.length });
  }
  return done;
}

// one-time, idempotent: a row whose branch is the default branch shipped straight on it and has no branch of its own; without it
// the row reads as its planned order, which no sibling shares (two rows on one branch were one row to every tab and agent)
export function branchlessRows(store: { list(): Work[]; save(work: Work, opts?: { touch?: boolean }): unknown }, gitOf: (work: Work) => { base: string }) {
  const done: { slug: string; rows: number }[] = [];
  for (const work of store.list()) {
    const base = gitOf(work).base;
    const rows = (work.stack || []).filter((s) => !s.number && s.planned?.order != null && s.planned?.branch === base);
    if (!rows.length) continue;
    for (const s of rows) s.planned = { ...s.planned, branch: undefined };
    store.save(work, { touch: false });
    done.push({ slug: work.slug, rows: rows.length });
  }
  return done;
}

// Landing a row on a repo whose land setting is "auto": the app checkout fast-forwards onto the row's commits, coco restarts on them, and
// the boot that answers marks the row landed; a boot on another commit, or a server that never answers, fast-forwards back and restarts.
export type LandRec = { work: string; row: string; label: string; base: string; branch: string | null; sha: string; previous: string; at: string; by: 'agent' | 'owner'; state: 'landing' | 'landed' | 'rolled-back'; detail: string | null };

// the checkout a landing works in: clean, on the base branch, and the row's branch a fast-forward of it (never a merge with a commit of its own)
export async function landReady(git: Git, { base, branch }: { base: string; branch: string | null }) {
  const dirty = (await git(['status', '--porcelain'])).stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  if (dirty.length) throw new HttpError(409, `the app checkout is dirty: commit or stash ${dirty.slice(0, 6).join(', ')}${dirty.length > 6 ? `, +${dirty.length - 6} more` : ''}`);
  const head = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== base) throw new HttpError(409, `the app checkout is on ${head || 'no branch'}: check out ${base} to land in it`);
  if (!branch || branch === base) return;
  const exists = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!exists.ok) throw new HttpError(409, `no branch ${branch} in the app checkout: nothing to land`);
  if (!(await git(['merge-base', '--is-ancestor', `refs/heads/${base}`, `refs/heads/${branch}`])).ok) throw new HttpError(409, `${branch} is not a fast-forward of ${base}: rebase ${branch} onto ${base} first`);
}

export async function fastForward(git: Git, { base, branch }: { base: string; branch: string }) {
  const r = await git(['merge', '--ff-only', `refs/heads/${branch}`]);
  if (!r.ok) throw new HttpError(409, `${base} cannot fast-forward onto ${branch}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}

type LandingDeps = {
  DATA: string;
  APP: string;
  // where coco answers, for the watcher that rolls a boot that never comes back
  url: string;
  // the work's checkout, its default branch and its land setting
  gitOf: (slug: string) => { git: Git; base: string; land?: string };
  stackOf: (slug: string) => StackRow[];
  restart: () => Promise<unknown>;
  // the commit the server that answers now runs
  running: () => Promise<string | null>;
  // the row is landed, through works.land: timeline, Notion, no PR nudges
  marked: (rec: LandRec) => Promise<unknown>;
  waitMs?: number;
};

export function createLanding({ DATA, APP, url, gitOf, stackOf, restart, running, marked, waitMs = 120_000 }: LandingDeps) {
  const FILE = path.join(DATA, 'landings.json');
  const list: LandRec[] = (() => {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      return [];
    }
  })();
  const save = () => {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = `${FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-200)));
    fs.renameSync(tmp, FILE);
  };
  const of = (slug: string) => list.filter((r) => r.work === slug).at(-1) ?? null;

  // the row's sha or nothing: after the wait, a server not answering on it gets the checkout fast-forwarded back and restarted
  function watch(rec: LandRec) {
    const script = [
      `sleep ${Math.ceil(waitMs / 1000)}`,
      `curl -sf ${url}/api/server | grep -q '"running":"${rec.sha}"' && exit 0`,
      `git -C '${APP}' reset --hard ${rec.previous} >>/dev/null 2>&1`,
      `curl -sf -X POST ${url}/api/server/restart >>/dev/null 2>&1`,
    ].join('\n');
    try {
      const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch {}
  }

  // one press, shared by the row menu and land_row: checks, fast-forward, journal, restart
  async function land(slug: string, input: { row?: unknown; by?: unknown }) {
    const by = input.by === 'agent' ? 'agent' : 'owner';
    const { git, base, land: how } = gitOf(slug);
    if (how && how !== 'main' && how !== 'auto') throw new HttpError(409, 'this repo ships rows as PRs: set its settings.land to "auto" to land rows in it');
    const row = landedRow(stackOf(slug), input.row);
    if (row.number) throw new HttpError(409, `#${row.number} has a PR: GitHub lands it, coco does not`);
    // a row's branch is sometimes only a label (it shipped straight on the base): no local branch, nothing to fast-forward
    const named = row.planned?.branch && row.planned.branch !== base ? row.planned.branch : null;
    const branch = named && (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${named}^{commit}`])).ok ? named : null;
    const label = row.planned?.title || keyLabel(rowKey(row));
    await landReady(git, { base, branch });
    const previous = await commitOf(git, 'HEAD');
    if (!previous) throw new HttpError(400, 'the app checkout has no commit to come back to');
    if (branch) await fastForward(git, { base, branch });
    const target = await commitOf(git, 'HEAD');
    if (!target) throw new HttpError(502, `${base} has no commit after the fast-forward`);
    const rec: LandRec = { work: slug, row: keyLabel(rowKey(row)), label, base, branch, sha: target.sha, previous: previous.sha, at: new Date().toISOString(), by, state: 'landing', detail: null };
    list.push(rec);
    save();
    // the watcher first: a restart that never answers has no one else to come back
    watch(rec);
    await restart().catch((e) => {
      rec.detail = `the restart was asked for but failed: ${errorMessage(e)}`;
      save();
    });
    return rec;
  }

  // back to what ran before, the way it came: a fast-forward, never a new commit
  async function undo(rec: LandRec, why: string) {
    try {
      const { git } = gitOf(rec.work);
      const back = await git(['reset', '--hard', rec.previous]);
      if (!back.ok) throw new Error((back.stderr || back.stdout).trim().slice(-200) || 'git reset failed');
      await restart().catch(() => null);
      Object.assign(rec, { state: 'rolled-back', detail: `${why}: fast-forwarded back to ${rec.previous.slice(0, 7)} and restarted` });
    } catch (e) {
      Object.assign(rec, { state: 'rolled-back', detail: `${why}; rolling back failed: ${errorMessage(e)}` });
    }
    save();
    return rec;
  }

  // the boot that answers settles what the last landing left open
  async function settle() {
    for (const rec of list.filter((r) => r.state === 'landing')) {
      const at = await running().catch(() => null);
      if (at === rec.sha) {
        const failed = await marked(rec).then(() => null, (e) => errorMessage(e));
        Object.assign(rec, { state: 'landed', detail: failed ? `coco runs ${rec.sha.slice(0, 7)}: marking it failed (${failed})` : `coco runs ${rec.sha.slice(0, 7)}` });
        save();
      } else if (at) await undo(rec, `coco runs ${at.slice(0, 7)}, not ${rec.sha.slice(0, 7)}`);
    }
    return list.filter((r) => r.state !== 'landed' || Date.now() - Date.parse(r.at) < 24 * 3600 * 1000);
  }

  return { land, settle, of, list: () => [...list] };
}
