// Stack fix: every open review comment of every stack row goes to ONE agent that walks the rows bottom-up,
// commits each row's fixes on its branch and restacks the children; cocopilot then ingests and re-anchors.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { isLocal, rowKey } from './stack.mjs';
import { byFileThenLine, capitalize, commentSection, fenced as fence, sharedRules } from './review-agent.mjs';

const MAX_COMMENTS = 60;
const SETTLE_MS = 15000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const defaultExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export function createStackFix({ DATA, REPO, config, works, comments, code, reviewAgent, exec = defaultExec }) {
  const SHARED_RULES = sharedRules(config);
  const BASE = `origin/${config.repo.defaultBranch}`;
  const dir = (slug) => path.join(DATA, 'works', slug, 'reviews');
  const runFile = (slug, id) => path.join(dir(slug), `stack-run-${id}.json`);
  const briefFile = (slug, id) => path.join(dir(slug), `stack-run-${id}.md`);
  const resultFile = (slug, id) => path.join(dir(slug), `stack-run-${id}-result.json`);

  const checkSlug = (slug) => {
    if (!/^[\w.-]+$/.test(String(slug)) || String(slug).startsWith('.')) throw new HttpError(400, 'bad slug');
  };

  let chain = Promise.resolve();
  const withLock = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  const writeRun = (run) => {
    fs.mkdirSync(dir(run.slug), { recursive: true });
    const tmp = `${runFile(run.slug, run.id)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(run, null, 1));
    fs.renameSync(tmp, runFile(run.slug, run.id));
  };
  const list = (slug) => {
    if (!fs.existsSync(dir(slug))) return [];
    return fs
      .readdirSync(dir(slug))
      .filter((f) => /^stack-run-[0-9a-f]+\.json$/.test(f))
      .map((f) => parseJson(fs.readFileSync(path.join(dir(slug), f), 'utf8'), null))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  };

  // rows from the first one with open comments to the top; merged or closed PRs drop out of the chain
  async function chainOf(work) {
    const rows = [];
    for (const [index, s] of (work.stack || []).entries()) {
      const key = rowKey(s);
      if (!key) throw new HttpError(400, `row ${index + 1} has neither a PR number nor a planned branch`);
      const open = (comments.list(work.slug, key).comments || []).filter((c) => c.status === 'open');
      if (!rows.length && !open.length) continue;
      const pr = await reviewAgent.rowPr(work, index);
      if (pr.state === 'MERGED' || pr.state === 'CLOSED') continue;
      rows.push({ index, key, branch: pr.head, title: pr.title, personas: s.personas || [], comments: open.sort(byFileThenLine) });
    }
    for (const [i, row] of rows.entries()) {
      row.tipBefore = await reviewAgent.branchSha(row.branch);
      if (!row.tipBefore) throw new HttpError(409, `branch ${row.branch} not found locally`);
      row.parent = i ? rows[i - 1].branch : BASE;
      row.parentTipBefore = i ? rows[i - 1].tipBefore : null;
      row.worktree = await reviewAgent.worktreeFor(row.branch);
      row.remoteBefore = await reviewAgent.remoteHead(row.key);
    }
    return rows;
  }

  async function refuseBusy(rows) {
    const agents = await reviewAgent.agentsList();
    for (const row of rows.filter((r) => r.worktree)) {
      const st = await exec('git', ['-C', row.worktree, 'status', '--porcelain', '--untracked-files=no']);
      if (st.ok && st.stdout.trim()) throw new HttpError(409, `${row.worktree} has uncommitted changes on ${row.branch}`);
      const busy = agents.find((a) => a.cwd && a.status === 'running' && reviewAgent.sameDir(a.cwd, row.worktree));
      if (busy) throw new HttpError(409, `agent ${String(busy.id).slice(0, 8)} is running in ${row.worktree}`);
    }
  }

  function buildBrief({ work, rows, id, commits, resultPath }) {
    const total = rows.reduce((n, r) => n + r.comments.length, 0);
    const out = [];
    out.push(`# Fix review comments across the stack — work \`${work.slug}\``, '');
    out.push(`Run ${id}. You address ${total} review comment${total === 1 ? '' : 's'} left by the owner on ${rows.filter((r) => r.comments.length).length} row(s) of a stack of branches. You are the only agent on these branches for this run.`, '');

    out.push('## Hard rules', '');
    out.push(
      '- Walk the rows in the order below (bottom of the stack first). Finish a row, restack it if needed, then move up.',
      "- Work on each row's branch in that row's place (listed below). Never switch an existing worktree to another branch.",
      ...SHARED_RULES,
      '- A restack conflict: `git rebase --abort`, mark that row failed in the result with the conflicting files, and stop. Do not touch the rows above it.',
      '',
    );

    out.push('## For each row', '');
    out.push(
      "1. Go to the row's place. `git status --short --untracked-files=no` must be empty and `git branch --show-current` must print the row's branch; otherwise stop and report.",
      "2. From row 2 up: when the parent row's tip moved in this run (`git rev-parse <parent branch>` differs from the parent tip before), restack first: `git rebase --onto <parent branch> <parent tip before>`.",
      "3. Fix the row's comments. " + (commits === 'one' ? 'One commit per fixed comment; each message ends with the trailer `Cc-Comment: <id>`.' : "One commit for the row's fixed comments, with one `Cc-Comment: <id>` trailer per fixed comment."),
      '4. A row without comments is only restacked.',
      "5. Note the row's new tip (`git rev-parse HEAD`) before moving up.",
      '',
    );

    out.push('## Work rules', '');
    out.push(work.notes && work.notes.trim() ? fence(work.notes, 'markdown') : '(none)', '');

    const logins = [...new Set(rows.flatMap((r) => r.personas))];
    const excerpts = logins.map((login) => ({ login, ex: reviewAgent.personaExcerpt(login) })).filter((x) => x.ex);
    if (excerpts.length) {
      out.push('## Owner personas', '');
      for (const { login, ex } of excerpts) out.push(`### ${login} — ${ex.heading}`, '', ex.text, '');
    }

    out.push('## Rows', '');
    for (const [i, row] of rows.entries()) {
      out.push(`### Row ${i + 1} — \`${row.branch}\` (${isLocal(row.key) ? 'local, no PR yet' : `PR #${row.key}`})`, '');
      out.push(
        `- Key: \`${row.key}\``,
        `- Scope: ${row.title || ''}`,
        `- Tip before: \`${row.tipBefore}\``,
        i ? `- Parent: \`${row.parent}\`, parent tip before: \`${row.parentTipBefore}\`` : `- Parent: \`${BASE}\` (never restacked in this run)`,
        row.worktree ? `- Place: \`${row.worktree}\`` : `- Place: none yet. \`git worktree add /tmp/cc-stack-${id}/row-${i + 1} ${row.branch}\`, work there, \`git worktree remove /tmp/cc-stack-${id}/row-${i + 1}\` once the run is over.`,
        '',
      );
      if (!row.comments.length) out.push('No comment on this row: restack only.', '');
      for (const c of row.comments) out.push(...commentSection(c, '####'));
    }

    out.push('## How to report', '');
    out.push(
      `- Last step, write \`${resultPath}\`:`,
      '',
      fence(
        JSON.stringify(
          {
            rows: [{ key: '<row key>', branch: '<branch>', tipBefore: '<sha>', tipAfter: '<sha>', restacked: false, error: null }],
            comments: [{ id: '<comment id>', status: 'fixed | declined', commit: '<sha or null>', note: '<one line>' }],
          },
          null,
          1,
        ),
        'json',
      ),
      '',
      '- One `rows` entry per row you reached; `error` says why a row failed (conflicting files for a restack). Rows above a failure are left out.',
      '- One `comments` entry per comment you handled. `commit` is the full sha of the fixing commit as it stands after the last restack, `null` when declined.',
      `- Do not push. ${capitalize(config.owner.name)} reviews the commits and pushes the stack.`,
      '',
    );
    return out.join('\n');
  }

  async function start(slug, input = {}) {
    checkSlug(slug);
    return withLock(async () => {
      const work = works.get(slug);
      if (!work) throw new HttpError(404, 'no such work');
      if (list(slug).some((r) => r.status === 'running')) throw new HttpError(409, 'a stack fix is already running for this work');
      const commits = input.commits === 'squash' ? 'squash' : 'one';
      const rows = await chainOf(work);
      const total = rows.reduce((n, r) => n + r.comments.length, 0);
      if (!total) throw new HttpError(400, 'no open comment on the stack');
      if (total > MAX_COMMENTS) throw new HttpError(400, `at most ${MAX_COMMENTS} comments per stack fix (got ${total})`);
      await refuseBusy(rows);

      const id = crypto.randomBytes(4).toString('hex');
      const brief = briefFile(slug, id);
      const resultPath = resultFile(slug, id);
      fs.mkdirSync(dir(slug), { recursive: true });
      fs.writeFileSync(brief, buildBrief({ work, rows, id, commits, resultPath }));
      const runner = rows[0].worktree ? { mode: 'cwd', cwd: rows[0].worktree } : { mode: 'checkout-branch' };
      const provider = input.provider || config.models.default;
      const agentId = await reviewAgent.launch(runner, { title: `Fix stack ${slug} (${total})`, provider, prompt: `Read ${brief} and follow it end to end.`, labels: { kind: 'stack-fix', run: id, work: slug, comments: total }, requestedBy: input.requestedBy, branch: rows[0].branch });

      const run = {
        id,
        slug,
        startedAt: new Date().toISOString(),
        status: 'running',
        agentId,
        mode: runner.mode,
        cwd: runner.cwd || null,
        commits,
        provider,
        briefPath: brief,
        resultPath,
        rows: rows.map(({ key, branch, title, tipBefore, parent, parentTipBefore, worktree, remoteBefore, comments: cs }) => ({ key, branch, title, tipBefore, parent, parentTipBefore, worktree, remoteBefore, commentIds: cs.map((c) => c.id), tipAfter: null, restacked: null, error: null })),
      };
      writeRun(run);
      for (const row of rows) for (const c of row.comments) await comments.update(slug, row.key, c.id, { status: 'sent', runId: id });
      reviewAgent.timeline(slug, 'agent', `stack fix: sent ${total} comments on ${rows.length} rows to agent ${String(agentId || '').slice(0, 8) || '?'}`);
      return run;
    });
  }

  async function settle(slug, row, id, outcome) {
    const c = (comments.list(slug, row.key).comments || []).find((x) => x.id === id);
    if (!c || c.status !== 'sent') return false;
    await comments.update(slug, row.key, id, outcome);
    return true;
  }

  async function reanchorAll(run) {
    for (const row of run.rows.filter((r) => isLocal(r.key))) {
      try {
        const refs = await code.ensureRefs(row.key);
        await comments.reanchor(run.slug, row.key, { headSha: refs.headSha, mergeBase: refs.mergeBase });
        row.tipAfter = row.tipAfter || refs.headSha;
      } catch (e) {
        row.error = row.error || `re-anchor: ${e.message}`;
      }
    }
  }

  async function ingestRun(run, agents) {
    const slug = run.slug;
    const rowOf = (id) => run.rows.find((r) => r.commentIds.includes(id));
    if (!run.pushWarned) {
      for (const row of run.rows) {
        const now = await reviewAgent.remoteHead(row.key);
        if (now && now !== row.remoteBefore) {
          run.pushWarned = true;
          reviewAgent.timeline(slug, 'warning', `stack fix ${run.id}: remote head of ${row.branch} moved during the run`);
          break;
        }
      }
    }

    const result = fs.existsSync(run.resultPath) ? parseJson(fs.readFileSync(run.resultPath, 'utf8'), null) : null;
    if (result && typeof result === 'object') {
      let fixed = 0;
      let declined = 0;
      for (const e of Array.isArray(result.comments) ? result.comments : []) {
        const row = e && rowOf(e.id);
        if (!row) continue;
        const note = typeof e.note === 'string' ? e.note : '';
        if (e.status === 'fixed' && (await settle(slug, row, e.id, { status: 'fixed', runId: run.id, resolution: { commit: e.commit || null, note } }))) fixed++;
        else if (e.status === 'declined' && (await settle(slug, row, e.id, { status: 'declined', runId: run.id, resolution: { note } }))) declined++;
      }
      for (const row of run.rows) for (const id of row.commentIds) await settle(slug, row, id, { status: 'open', runId: null });
      for (const r of Array.isArray(result.rows) ? result.rows : []) {
        const row = run.rows.find((x) => x.key === r?.key || x.branch === r?.branch);
        if (row) Object.assign(row, { tipAfter: typeof r.tipAfter === 'string' ? r.tipAfter : null, restacked: Boolean(r.restacked), error: r.error ? String(r.error).slice(0, 500) : null });
      }
      await reanchorAll(run);
      const failed = run.rows.find((r) => r.error);
      run.status = failed ? 'failed' : 'done';
      run.finishedAt = new Date().toISOString();
      reviewAgent.timeline(slug, 'agent', `stack fix ${run.id}: ${fixed} fixed, ${declined} declined${failed ? `, stopped at ${failed.branch}: ${failed.error}` : ''}`);
      return writeRun(run);
    }

    let fixed = 0;
    for (const row of run.rows) {
      const tip = await reviewAgent.branchSha(row.branch);
      if (!tip || tip === row.tipBefore) continue;
      for (const t of await reviewAgent.trailersBetween(REPO, row.tipBefore, tip)) {
        const owner = rowOf(t.id);
        if (owner && (await settle(slug, owner, t.id, { status: 'fixed', runId: run.id, resolution: { commit: t.commit, note: 'found via Cc-Comment trailer' } }))) fixed++;
      }
    }
    if (fixed) reviewAgent.timeline(slug, 'agent', `stack fix ${run.id}: ${fixed} fixed from commit trailers`);
    const agent = run.agentId ? agents.find((a) => a.id === run.agentId) : null;
    if (Date.now() - Date.parse(run.startedAt) > SETTLE_MS && (!agent || agent.status !== 'running')) {
      await reanchorAll(run);
      run.status = 'done';
      run.finishedAt = new Date().toISOString();
      reviewAgent.timeline(slug, 'agent', `stack fix ${run.id}: agent stopped without a result file`);
    }
    writeRun(run);
  }

  async function ingest(slug) {
    checkSlug(slug);
    return withLock(async () => {
      const running = list(slug).filter((r) => r.status === 'running');
      if (running.length) {
        const agents = await reviewAgent.agentsList();
        for (const run of running) await ingestRun(run, agents);
      }
      const open = (works.get(slug)?.stack || []).map(rowKey).filter(Boolean).map((key) => ({ key, count: (comments.list(slug, key).comments || []).filter((c) => c.status === 'open').length }));
      return { runs: list(slug), open };
    });
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      const [, slug, , id, action] = parts;
      checkSlug(slug);
      if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
      if (!id) {
        if (req.method === 'GET') return send(res, 200, await ingest(slug));
        if (req.method === 'POST') return send(res, 200, await start(slug, parseJson((await readBody(req)) || '{}', {}) || {}));
        return send(res, 400, { error: `unsupported ${req.method}` });
      }
      const run = /^[0-9a-f]+$/.test(id) && list(slug).find((r) => r.id === id);
      if (!run) return send(res, 404, { error: 'no such stack fix' });
      if (action === 'brief') return send(res, 200, fs.existsSync(run.briefPath) ? fs.readFileSync(run.briefPath, 'utf8') : '', 'text/plain');
      if (action === 'logs') {
        if (!run.agentId) return send(res, 200, { ok: false, out: 'no agent id recorded for this run' });
        const r = await exec('paseo', ['logs', run.agentId, '--tail', '60']);
        return send(res, 200, { ok: r.ok, out: r.stdout || r.stderr });
      }
      return send(res, 200, run);
    } catch (e) {
      return send(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    }
  }

  return { handle, start, ingest, list, buildBrief };
}
