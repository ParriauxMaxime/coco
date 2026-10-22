// Threads and dispatch: the owner sends a decision card or a review comment to a small scoped agent and approves or dismisses what it suggests.
// Items on the same subject share a group: one agent and, for code, one worktree branched off the PR head (comments join the group touching their file).
// The agent writes its reply to a file; a code change is one commit per item (Cc-Comment trailer) that Approve cherry-picks onto the PR branch;
// a card change is a JSON file of fields that Approve writes to the card.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyLabel, parseKey, rowKey } from './stack.mjs';
import { capitalize, commentSection, fenced, sharedRules } from './review-agent.mjs';
import { blocksToMarkdown, validateBlocks } from './blocks.mjs';

const SETTLE_MS = 15000;
const MAX_DIFF = 20000;
const STATE_FIELDS = ['id', 'status', 'choice', 'rationale', 'decidedAt'];
const OPEN_SUGGESTION = ['pending', 'queued', 'conflict'];
// d.<decision id> · c.<row file key>.<comment id> · p.<row file key> (the review plan)
const KEY = /^(d\.[\w-]+|c\.[\w.~-]+\.[0-9a-f]+|p\.[\w.~-]+)$/;
const GROUP = /^[0-9a-f]{6}$/;
const alive = (a) => a.status !== 'closed' && a.status !== 'error';
const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
const hex = (n) => crypto.randomBytes(n).toString('hex');
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLOCKS_DOC = path.join(APP_ROOT, 'skills/coco-findings/SKILL.md');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseThreadKey(key) {
  if (!KEY.test(String(key))) return null;
  if (key.startsWith('d.')) return { kind: 'decision', id: key.slice(2) };
  const rest = key.slice(2);
  if (key.startsWith('p.')) {
    const n = parseKey(rest.replaceAll('~', ':'));
    return n ? { kind: 'plan', n } : null;
  }
  const dot = rest.lastIndexOf('.');
  const n = parseKey(rest.slice(0, dot).replaceAll('~', ':'));
  return n ? { kind: 'comment', n, id: rest.slice(dot + 1) } : null;
}

const defaultExec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });

export function createThreads({ DATA, REPO, config, works, comments, reviewAgent, reviewPlan, exec = defaultExec }) {
  const MODELS = { sonnet: config.models.fast, opus: config.models.default };
  const SHARED_RULES = sharedRules(config);
  const OWNER = config.owner.name;
  const Owner = capitalize(OWNER);
  const git = (cwd, args) => exec('git', ['-C', cwd, ...args]);
  const dir = (slug) => path.join(DATA, 'works', slug, 'threads');
  const groupDir = (slug) => path.join(DATA, 'works', slug, 'groups');
  const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
  const writeJson = (f, data) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    return data;
  };
  const read = (slug, key) => readJson(path.join(dir(slug), `${key}.json`), { key, groupId: null, waiting: null, messages: [] });
  const write = (slug, thread) => writeJson(path.join(dir(slug), `${thread.key}.json`), thread);
  const readGroup = (slug, id) => (GROUP.test(String(id)) ? readJson(path.join(groupDir(slug), `${id}.json`), null) : null);
  const writeGroup = (slug, group) => writeJson(path.join(groupDir(slug), `${group.id}.json`), { ...group, updatedAt: new Date().toISOString() });
  const listJson = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []);
  const listGroups = (slug) => listJson(groupDir(slug));
  const listThreads = (slug) => listJson(dir(slug));
  const message = (role, text, extra = {}) => ({ id: hex(4), role, text, ts: new Date().toISOString(), ...extra });

  const locks = new Map();
  const withLock = (key, fn) => {
    const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  };

  const check = (slug, key) => {
    const work = works.get(slug);
    if (!work) throw new HttpError(404, 'no such work');
    const ref = parseThreadKey(key);
    if (!ref) throw new HttpError(400, 'bad thread key');
    return { work, ref };
  };
  const itemOf = (slug, work, ref) => {
    if (ref.kind === 'decision') return (work.decisions || []).find((d) => d.id === ref.id) || null;
    if (ref.kind === 'plan') return reviewPlan.planOf(slug, ref.n);
    return (comments.list(slug, ref.n).comments || []).find((c) => c.id === ref.id) || null;
  };
  async function prOf(work, n) {
    const index = (work.stack || []).findIndex((s) => rowKey(s) === n);
    if (index < 0) throw new HttpError(404, `${keyLabel(n)} is not in this work`);
    return reviewAgent.rowPr(work, index);
  }
  const branchHead = async (branch) => {
    const r = await git(REPO,['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
    return r.ok ? r.stdout.trim() : null;
  };

  function summaries(slug) {
    return Object.fromEntries(listThreads(slug).map((t) => [t.key, {
      count: t.messages.length,
      waiting: Boolean(t.waiting),
      lastTs: t.messages.at(-1)?.ts || null,
      groupId: t.groupId,
      open: t.messages.filter((m) => OPEN_SUGGESTION.includes(m.suggestion?.state)).length,
    }]));
  }

  // the group a dispatch goes to: the one asked for, the thread's own, else for a comment the open group of that PR touching its file, for a card the card's group
  function pickGroup(slug, ref, item, thread, { groupId, model }) {
    const open = listGroups(slug).filter((g) => g.status === 'active');
    const sameModel = (g) => !model || g.model === model;
    if (groupId && groupId !== 'new') {
      const g = open.find((x) => x.id === groupId);
      if (!g) throw new HttpError(404, 'no such open group');
      return g;
    }
    if (groupId !== 'new' && !thread.newGroup) {
      const own = open.find((g) => g.id === thread.groupId && sameModel(g));
      if (own) return own;
      const subject = open.find((g) => sameModel(g) && (ref.kind === 'decision' ? g.kind === 'decision' && g.decisionId === ref.id : ref.kind === 'plan' ? g.kind === 'plan' && g.n === ref.n : g.kind === 'code' && g.n === ref.n && g.files.includes(item.path)));
      if (subject) return subject;
    }
    const base = { id: hex(3), model: model || 'sonnet', agentId: null, items: [], status: 'active', createdAt: new Date().toISOString() };
    if (ref.kind === 'decision') return { ...base, kind: 'decision', decisionId: ref.id };
    if (ref.kind === 'plan') return { ...base, kind: 'plan', n: ref.n };
    return { ...base, kind: 'code', n: ref.n, branch: `cocopilot/${base.id}`, worktree: null, files: [item.path] };
  }

  const findingRule = [
    `Only when ${OWNER} asks you to accept, dismiss or edit this finding, add to the reply JSON`,
    '`"finding": { "action": "accept" | "dismiss", "reason": "…", "patch": { "title", "severity", "confidence", "summary", "recommendation", "blocks" } }`',
    '(each part optional; dismiss needs a reason). cocopilot applies it after your turn; accept or dismiss may end your session. Never on your own initiative.',
  ].join(' ');
  const replyRule = (replyPath, kind) => [
    `Last step of your turn: write your reply to \`${replyPath}\` as JSON \`{ "blocks": [...] }\`, never markdown.`,
    `Blocks (full reference: "Blocks" in \`${BLOCKS_DOC}\`): \`text\` (1-3 sentences), \`steps\` ({ title, items, outcome }), \`table\` ({ caption, columns, rows; a cell may be { text, tone } }),`,
    '`suggestion` ({ path, startLine, endLine, lang, after }: the code you propose at those lines; cocopilot shows it as a diff), `code` ({ path, line, lang, code }), `diagram` ({ mermaid, caption }), `callout` ({ tone, title, text }).',
    'Inline text: **bold**, `code`, path/file.ts:12 refs and <risk>…</risk> <warn> <ok> <note> marks. Lead with the answer; short.',
    ...(kind === 'comment' ? [findingRule] : []),
  ].join(' ');

  function buildPrompt({ work, ref, item, thread, text, group, replyPath, cardPath, pr }) {
    const history = thread.messages.filter((m) => m.role !== 'system').map((m) => `**${m.role === 'user' ? Owner : 'You'}:** ${m.text}${m.suggestion ? ` _(suggestion ${m.suggestion.state})_` : ''}`);
    const about = {
      decision: () => ({ title: `decision "${item.title}"`, section: ['## Decision card', '', fenced(JSON.stringify(item, null, 1), 'json')] }),
      plan: () => ({ title: `review plan of ${keyLabel(ref.n)}`, section: ['## Review plan (coco)', '', fenced(JSON.stringify(item, null, 1), 'json')] }),
      comment: () => ({ title: `review comment on ${item.path}:${item.startLine}-${item.endLine}, ${keyLabel(ref.n)}`, section: ['## Comment', '', ...commentSection(item), `PR branch \`${pr.head}\`${pr.url ? ` · ${pr.url}` : ''}.`] }),
    }[ref.kind]();
    const rules = {
      decision: [
        `- To suggest a card change (question, details, options, rows, positions, confidence), write only the fields to change as one JSON object to \`${cardPath}\`. Never status, choice, rationale or decidedAt: ${OWNER} takes the decision. Do not change files in the repo.`,
        SHARED_RULES[0],
      ],
      plan: [
        `- Read PR code only through git at the plan's head sha (\`git show ${item.headSha}:<path>\`, \`git grep -n <term> ${item.headSha}\`, \`git diff ${item.mergeBase} ${item.headSha} -- <path>\`); the working tree is on another branch. Change nothing.`,
        `- When the plan should be redone, say so and give the guidance in one short paragraph: ${OWNER} re-plans from cocopilot with it.`,
        SHARED_RULES[0],
      ],
      comment: [
        `- You work in your own worktree on branch \`${group.branch}\`, branched off the PR head; stay on it. To suggest a change, make it and commit ONE commit with the trailer \`Cc-Comment: ${item.id}\`. On Approve cocopilot cherry-picks that commit onto \`${pr?.head}\`, so keep it self-contained. When you disagree, say why instead of changing it.`,
        ...SHARED_RULES,
      ],
    }[ref.kind];
    return [
      `# cocopilot · ${about.title} (work \`${work.slug}\`)`,
      '',
      `You are a scoped agent of cocopilot group ${group.id}${group.files ? ` (files: ${group.files.join(', ')})` : ''}. ${Owner} writes from cocopilot and reads your reply inline, under the item, then approves or dismisses each suggestion you make.`,
      '',
      ...about.section,
      '',
      ...(history.length ? ['## Thread so far', '', ...history, ''] : []),
      `## ${Owner}'s message`,
      '',
      text,
      '',
      '## How to answer',
      '',
      `- ${replyRule(replyPath, ref.kind)} Only that file shows in cocopilot.`,
      ...rules,
      '',
    ].join('\n');
  }

  // the agent still holds this thread in its context: only the new turn goes out, with what changed since its last answer
  function followUpPrompt({ ref, item, thread, text, replyPath, cardPath, agentId }) {
    const lastSeen = thread.messages.findLastIndex((m) => m.agentId === agentId && m.role !== 'system');
    const lastSuggestion = thread.messages.slice(0, lastSeen + 1).findLast((m) => m.suggestion)?.suggestion;
    const since = [
      ...(lastSuggestion && lastSuggestion.state !== 'pending' ? [`- Your last suggestion is now ${lastSuggestion.state}.`] : []),
      ...thread.messages.slice(lastSeen + 1).filter((m) => m.role === 'system').map((m) => `- ${m.text}`),
    ];
    const where = ref.kind === 'comment' ? `the comment on ${item.path}:${item.startLine}` : ref.kind === 'plan' ? `the review plan of ${keyLabel(ref.n)}` : `decision "${item.title}"`;
    return [
      `# cocopilot · follow-up on ${where}`,
      '',
      ...(since.length ? ['## Since your last answer', '', ...since, ''] : []),
      `## ${Owner}'s message`,
      '',
      text,
      '',
      `Same rules as before${ref.kind === 'decision' ? `; a card change goes to \`${cardPath}\`` : ''}. ${replyRule(replyPath, ref.kind)}`,
      '',
    ].join('\n');
  }

  const AGENTS_TTL_MS = 5000;
  let agentsCache = null;
  const agentsNow = () => {
    if (!agentsCache || Date.now() - agentsCache.at > AGENTS_TTL_MS) agentsCache = { at: Date.now(), list: reviewAgent.agentsList() };
    return agentsCache.list;
  };
  const liveAgent = async (group) => (group?.agentId && (await agentsNow()).find((a) => a.id === group.agentId && alive(a))) || null;

  // sends the message to the group's agent, starting it (and its worktree) on the first dispatch
  async function sendToGroup(slug, work, group, prompt, pr, known) {
    const runner = known
      ? { mode: 'send', agentId: known.id }
      : group.kind === 'code'
        ? { mode: 'branch-off', newBranch: group.branch, base: pr.sha || pr.head, slug: `cc-${group.id}` }
        : { mode: 'cwd', cwd: REPO };
    const title = { code: () => `cc ${keyLabel(group.n)} · ${group.files[0].split('/').pop()}`, plan: () => `cc plan ${keyLabel(group.n)}`, decision: () => `cc decision ${group.decisionId}` }[group.kind]();
    return reviewAgent.launch(runner, { title, provider: MODELS[group.model], prompt, labels: { kind: 'cc-group', work: slug, group: group.id } });
  }

  function post(slug, key, { text, model, groupId } = {}) {
    const { work, ref } = check(slug, key);
    if (!String(text || '').trim()) throw new HttpError(400, 'text required');
    if (model && !MODELS[model]) throw new HttpError(400, `model must be one of ${Object.keys(MODELS).join(', ')}`);
    return withLock(`${slug}:${key}`, () => dispatch(slug, work, ref, key, { text: text.trim(), model, groupId, role: 'user' }));
  }

  // a message (the owner's, or cocopilot's own after a failed apply) goes to the item's group agent
  async function dispatch(slug, work, ref, key, { text, model, groupId, role }) {
    const thread = read(slug, key);
    if (thread.waiting) throw new HttpError(409, 'the agent is still answering');
    const item = itemOf(slug, work, ref);
    if (!item) throw new HttpError(404, `no such ${ref.kind}`);
    const group = pickGroup(slug, ref, item, thread, { groupId, model });
    const pr = ref.kind === 'comment' ? await prOf(work, ref.n) : null;
    const msg = message(role, text, model ? { model } : {});
    const replyPath = path.join(dir(slug), `${key}-${msg.id}-reply.json`);
    const cardPath = path.join(dir(slug), `${key}-${msg.id}-card.json`);
    agentsCache = null;
    const known = await liveAgent(group);
    const seen = known && thread.messages.some((m) => m.agentId === known.id && m.role !== 'system');
    const prompt = seen ? followUpPrompt({ ref, item, thread, text, replyPath, cardPath, agentId: known.id }) : buildPrompt({ work, ref, item, thread, text, group, replyPath, cardPath, pr });
    const sha = group.kind === 'code' ? (await branchHead(group.branch)) || pr.sha : null;
    group.agentId = await sendToGroup(slug, work, group, prompt, pr, known);
    if (!group.items.includes(key)) group.items.push(key);
    writeGroup(slug, group);
    if (thread.groupId && thread.groupId !== group.id) leaveGroup(slug, thread.groupId, key);
    thread.messages.push({ ...msg, agentId: group.agentId, groupId: group.id, ...(seen ? { turn: 'follow-up' } : {}) });
    thread.groupId = group.id;
    delete thread.newGroup;
    thread.waiting = { msgId: msg.id, groupId: group.id, agentId: group.agentId, sentAt: msg.ts, replyPath, cardPath, sha };
    return write(slug, thread);
  }

  function leaveGroup(slug, id, key) {
    const g = readGroup(slug, id);
    if (g) writeGroup(slug, { ...g, items: g.items.filter((k) => k !== key) });
  }

  // what the agent suggested for this item since the message: its latest commit with the item's trailer, or a card JSON
  async function suggestionOf(slug, ref, waiting) {
    if (ref.kind === 'decision') {
      const fields = readJson(waiting.cardPath, null);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
      for (const k of STATE_FIELDS) delete fields[k];
      return Object.keys(fields).length ? { kind: 'card', fields, state: 'pending' } : null;
    }
    const group = readGroup(slug, waiting.groupId);
    if (!group || !waiting.sha) return null;
    const fix = (await reviewAgent.trailersBetween(REPO,waiting.sha, `refs/heads/${group.branch}`)).find((t) => t.id === ref.id);
    if (!fix) return null;
    const [diff, names] = await Promise.all([git(REPO,['show', '--format=', '--stat', '--patch', fix.commit]), git(REPO,['show', '--format=', '--name-only', fix.commit])]);
    const files = names.stdout.split('\n').filter(Boolean);
    writeGroup(slug, { ...group, files: [...new Set([...group.files, ...files])] });
    return { kind: 'commit', commit: fix.commit, files, diff: diff.stdout.slice(0, MAX_DIFF), state: 'pending' };
  }

  // a reply is `{ "blocks": [...] }` (typed blocks, as on finding cards); `text` keeps its markdown twin for the next prompts' history.
  // Older waits point at a `.md` reply; a reply that is not valid blocks still shows, as text
  async function readReply(file, sha) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (file.endsWith('.md')) return { text: raw };
    let blocks;
    let finding;
    try {
      const json = JSON.parse(raw);
      blocks = validateBlocks(json.blocks);
      finding = json.finding && typeof json.finding === 'object' ? json.finding : null;
    } catch (e) {
      return { text: raw, error: e.message };
    }
    // a suggestion's `before` is read at the agent's base, never trusted
    for (const b of blocks.filter((x) => x.type === 'suggestion')) {
      const r = sha ? await git(REPO,['show', `${sha}:${b.path}`]) : { ok: false };
      const lines = r.ok ? r.stdout.split('\n') : null;
      b.before = lines && b.endLine <= lines.length ? lines.slice(b.startLine - 1, b.endLine).join('\n') : undefined;
    }
    return { blocks, text: blocksToMarkdown({ blocks }), finding };
  }

  // what an agent asked to do to its own finding (only on the owner's request, per its prompt): edit it now, accept or dismiss once the thread lock is free
  const PATCHABLE = ['title', 'severity', 'confidence', 'summary', 'recommendation', 'blocks'];
  let findingActor = null;
  const setFindingActor = (fn) => (findingActor = fn);
  const addNote = (slug, key, text) => withLock(`${slug}:${key}`, () => {
    const thread = read(slug, key);
    thread.messages.push(message('system', text));
    return write(slug, thread);
  });
  async function applyFinding(slug, ref, key, finding) {
    const notes = [];
    const patch = Object.fromEntries(Object.entries(finding.patch || {}).filter(([k]) => PATCHABLE.includes(k)));
    if (Object.keys(patch).length) {
      try {
        await comments.update(slug, ref.n, ref.id, patch);
        notes.push(`The agent edited the finding: ${Object.keys(patch).join(', ')}.`);
      } catch (e) {
        notes.push(`The agent's edit of the finding was refused: ${e.message}`);
      }
    }
    const { action } = finding;
    const reason = String(finding.reason || '').trim().slice(0, 300);
    if (action === 'dismiss' && !reason) notes.push('The agent asked to dismiss the finding without a reason: not applied.');
    else if ((action === 'accept' || action === 'dismiss') && findingActor) {
      // after this turn's lock: accept or dismiss releases the thread, which waits on the same lock
      setImmediate(() => findingActor(slug, ref.n, ref.id, { action, reason }).catch((e) => addNote(slug, key, `The agent's ${action} failed: ${e.message}`)));
      notes.push(`The agent ${action === 'accept' ? 'accepted' : 'dismissed'} the finding${reason ? `: ${reason}` : ''}.`);
    } else if (action) notes.push(`Unknown finding action "${action}": not applied.`);
    return notes;
  }

  function ingest(slug, key, agents) {
    const { ref } = check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const { waiting } = thread;
      if (!waiting) return thread;
      const replied = fs.existsSync(waiting.replyPath);
      const agent = (agents || (await reviewAgent.agentsList())).find((a) => a.id === waiting.agentId);
      const idle = Date.now() - Date.parse(waiting.sentAt) > SETTLE_MS && agent?.status !== 'running';
      if (!replied && !idle) return thread;
      const group = readGroup(slug, waiting.groupId);
      if (group?.kind === 'code' && !group.worktree && agent?.cwd) writeGroup(slug, { ...group, worktree: expandHome(agent.cwd) });
      const suggestion = await suggestionOf(slug, ref, waiting);
      const reply = replied ? await readReply(waiting.replyPath, waiting.sha) : { text: suggestion ? '' : 'The agent ended its turn without writing a reply.' };
      thread.messages.push(message(replied || suggestion ? 'agent' : 'system', reply.text, { agentId: waiting.agentId, groupId: waiting.groupId, ...(reply.blocks ? { blocks: reply.blocks } : {}), ...(suggestion ? { suggestion } : {}) }));
      if (reply.error) thread.messages.push(message('system', `Reply not in blocks (${reply.error}): shown as text.`));
      if (reply.finding && ref.kind === 'comment') for (const note of await applyFinding(slug, ref, key, reply.finding)) thread.messages.push(message('system', note));
      thread.waiting = null;
      return write(slug, thread);
    });
  }

  // the PR worktree can take a cherry-pick when it has no tracked change and no agent is mid-turn in it
  async function prTarget(pr) {
    const wt = await reviewAgent.worktreeFor(pr.head);
    if (!wt) return { wt: null, busy: false };
    const [status, agents] = await Promise.all([git(wt, ['status', '--porcelain', '--untracked-files=no']), reviewAgent.agentsList()]);
    const busy = Boolean(status.stdout.trim()) || agents.some((a) => a.status === 'running' && a.cwd && reviewAgent.sameDir(a.cwd, wt));
    return { wt, busy };
  }

  async function cherryPick(pr, commit) {
    const { wt, busy } = await prTarget(pr);
    if (busy) return { queued: true };
    const cwd = wt || path.join(os.tmpdir(), `cc-apply-${hex(3)}`);
    if (!wt) {
      const add = await git(REPO,['worktree', 'add', cwd, pr.head]);
      if (!add.ok) return { error: `cannot check out ${pr.head}: ${add.stderr.slice(0, 200)}` };
    }
    try {
      const pick = await git(cwd, ['cherry-pick', commit]);
      if (!pick.ok) {
        await git(cwd, ['cherry-pick', '--abort']);
        return { conflict: pick.stderr.slice(0, 400) || 'cherry-pick failed' };
      }
      return { applied: (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim() };
    } finally {
      if (!wt) await git(REPO,['worktree', 'remove', '--force', cwd]);
    }
  }

  // Approve on a code suggestion: cherry-pick onto the PR branch, or queue while its worktree is busy, or send the conflict back to the group agent
  async function apply(slug, work, ref, key, thread, msg) {
    const s = msg.suggestion;
    if (s.kind === 'card') {
      works.upsertDecision(slug, { ...s.fields, id: ref.id });
      s.state = 'applied';
      thread.messages.push(message('system', 'Card updated.'));
      return;
    }
    const pr = await prOf(work, ref.n);
    const out = await cherryPick(pr, s.commit);
    if (out.queued) {
      s.state = 'queued';
      return;
    }
    if (out.error) {
      s.state = 'pending';
      s.error = out.error;
      return;
    }
    if (out.conflict) {
      s.state = 'conflict';
      s.error = out.conflict;
      if (thread.waiting) {
        thread.messages.push(message('system', `Commit ${s.commit.slice(0, 7)} no longer applies on ${pr.head}. Ask the agent to rebase once it has answered.`));
        return;
      }
      thread.messages.push(message('system', `Commit ${s.commit.slice(0, 7)} no longer applies on ${pr.head}; sent back to the agent.`));
      write(slug, thread);
      await dispatch(slug, work, ref, key, { role: 'system', text: `Your commit ${s.commit} does not apply on \`${pr.head}\` any more (head ${pr.sha}). Rebase your branch on that head (\`git rebase ${pr.sha}\`), resolve, and commit the change for this comment again with its trailer.` });
      Object.assign(thread, read(slug, key));
      return;
    }
    s.state = 'applied';
    s.appliedCommit = out.applied;
    delete s.error;
    await comments.update(slug, ref.n, ref.id, { status: 'fixed', resolution: { commit: out.applied, note: 'approved from the thread' } });
    thread.messages.push(message('system', `Applied on ${pr.head} as ${out.applied.slice(0, 7)}.`));
  }

  function decideSuggestion(slug, key, msgId, action) {
    const { work, ref } = check(slug, key);
    if (!['approve', 'dismiss'].includes(action)) throw new HttpError(400, "action must be 'approve' or 'dismiss'");
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const msg = thread.messages.find((m) => m.id === msgId && m.suggestion);
      if (!msg) throw new HttpError(404, 'no such suggestion');
      if (!OPEN_SUGGESTION.includes(msg.suggestion.state)) throw new HttpError(400, `suggestion is already ${msg.suggestion.state}`);
      if (action === 'dismiss') msg.suggestion.state = 'dismissed';
      else await apply(slug, work, ref, key, thread, msg);
      return write(slug, thread);
    });
  }

  // approvals waiting on a busy PR worktree: try them again
  async function drainQueue(slug) {
    const work = works.get(slug);
    if (!work) return;
    for (const t of listThreads(slug).filter((x) => x.messages.some((m) => m.suggestion?.state === 'queued'))) {
      const ref = parseThreadKey(t.key);
      if (!ref) continue;
      await withLock(`${slug}:${t.key}`, async () => {
        const thread = read(slug, t.key);
        for (const msg of thread.messages.filter((m) => m.suggestion?.state === 'queued')) await apply(slug, work, ref, t.key, thread, msg);
        write(slug, thread);
      });
    }
  }

  // move a thread to another open group of the same subject kind, or mark it for a new group on its next dispatch
  function regroup(slug, key, groupId) {
    const { ref } = check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      if (thread.waiting) throw new HttpError(409, 'the agent is still answering');
      if (groupId === 'new') {
        if (thread.groupId) leaveGroup(slug, thread.groupId, key);
        return write(slug, { ...thread, groupId: null, newGroup: true });
      }
      const g = readGroup(slug, groupId);
      const fits = g && g.kind === { comment: 'code', plan: 'plan', decision: 'decision' }[ref.kind] && (ref.kind === 'decision' || g.n === ref.n);
      if (!fits || g.status !== 'active') throw new HttpError(400, 'that group cannot take this item');
      if (thread.groupId) leaveGroup(slug, thread.groupId, key);
      writeGroup(slug, { ...g, items: [...new Set([...g.items, key])] });
      return write(slug, { ...thread, groupId, newGroup: false });
    });
  }

  // a code group archives its Paseo workspace (agent and worktree) and drops its branch: approved commits already live on the PR branch
  async function closeGroup(slug, id) {
    const g = readGroup(slug, id);
    if (!g) throw new HttpError(404, 'no such group');
    const r = g.worktree ? await exec('paseo', ['workspace', 'ls', '--json']) : { ok: false };
    const ws = r.ok ? JSON.parse(r.stdout).find((w) => w.cwd && reviewAgent.sameDir(w.cwd, g.worktree)) : null;
    if (ws) await exec('paseo', ['workspace', 'archive', ws.workspaceId]);
    else if (g.agentId) await exec('paseo', ['archive', g.agentId]);
    if (g.branch) await git(REPO,['branch', '-D', g.branch]);
    return writeGroup(slug, { ...g, status: 'closed' });
  }

  // the item is settled (finding accepted or dismissed): it leaves its group, and the group's agent and worktree go once no item is left;
  // kept while the agent is answering or a suggested commit is not applied yet, since closing deletes its branch
  function release(slug, key) {
    check(slug, key);
    return withLock(`${slug}:${key}`, async () => {
      const thread = read(slug, key);
      const g = thread.groupId && readGroup(slug, thread.groupId);
      if (!g || g.status !== 'active') return { key, outcome: 'none' };
      if (thread.waiting) return { key, outcome: 'kept', reason: 'the agent is still answering' };
      if (thread.messages.some((m) => OPEN_SUGGESTION.includes(m.suggestion?.state))) return { key, outcome: 'kept', reason: 'a suggestion is not applied yet' };
      const items = g.items.filter((k) => k !== key);
      if (items.length) {
        writeGroup(slug, { ...g, items });
        return { key, outcome: 'left', group: g.id, others: items.length };
      }
      await closeGroup(slug, g.id);
      return { key, outcome: 'pruned', group: g.id };
    });
  }

  // the Paseo plugin reports a finished turn: read back the threads waiting on that agent, then retry queued approvals
  async function turnEnded(agentId) {
    const agents = await reviewAgent.agentsList();
    for (const work of works.list().filter((w) => !w.archived)) {
      for (const t of listThreads(work.slug)) if (t.waiting?.agentId === agentId) await ingest(work.slug, t.key, agents);
      await drainQueue(work.slug);
    }
  }

  async function handle(req, res, parts, readBody, send) {
    try {
      const [, slug, b, key, sub, msgId] = parts;
      if (!works.get(slug)) return send(res, 404, { error: 'no such work' });
      const body = async () => JSON.parse((await readBody(req)) || '{}');
      if (b === 'groups') {
        if (key && sub === 'close' && req.method === 'POST') return send(res, 200, await closeGroup(slug, key));
        return send(res, 200, listGroups(slug));
      }
      if (!key) {
        await drainQueue(slug);
        return send(res, 200, summaries(slug));
      }
      if (sub === 'suggestions' && req.method === 'POST') return send(res, 200, await decideSuggestion(slug, key, msgId, (await body()).action));
      if (req.method === 'POST') return send(res, 200, await post(slug, key, await body()));
      if (req.method === 'PUT') return send(res, 200, await regroup(slug, key, (await body()).groupId));
      const thread = await ingest(slug, key);
      const group = thread.groupId && readGroup(slug, thread.groupId);
      const agent = group?.status === 'active' ? await liveAgent(group) : null;
      return send(res, 200, { ...thread, agent: group?.agentId ? { id: group.agentId, live: Boolean(agent), status: agent?.status || null } : null });
    } catch (e) {
      return send(res, e instanceof HttpError ? e.status : 500, { error: e.message });
    }
  }

  return { handle, post, ingest, turnEnded, summaries, decideSuggestion, drainQueue, regroup, release, setFindingActor };
}
