// "Ask coco": natural language → a Paseo agent with the cocopilot MCP server, its transcript streamed over SSE.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rowKey } from './stack.mjs';
import { createPaseoAgents, workCwd } from './paseo-agent.mjs';

const TIMEOUT_MS = 20 * 60 * 1000;
const DELTA_MS = 100;

export function createAsk({ DATA, APP, REPO, config, works, agents = createPaseoAgents({ APP }) }) {
  const DIR = path.join(DATA, 'asks');
  fs.mkdirSync(DIR, { recursive: true });
  const runs = new Map();
  const OWNER = config.owner.name;
  const diagramSkill = config.gateSkills?.['kit-diagram']?.[0];
  const method = Boolean(config.methodSkill);
  const notes = method && config.methodNotes;

  const SYSTEM = `You are coco, the assistant inside cocopilot, ${OWNER}'s local tool for running large features with Paseo agents, reviewer personas and "works" (long-term context per PR stack).
Rules: read before proposing (${notes ? `read_skill ${notes} for how ${OWNER} wants a scaffold shaped, ` : ''}${method ? 'read_skill SKILL.md for the method, ' : ''}list_works, list_personas, list_paseo, github_pr/github_search when a PR or issue is named). Never create, push, post or send anything: you only propose.
For a new work, end with exactly one propose_work_scaffold call carrying the full proposal${notes ? `, shaped as ${notes} asks` : ''}:
- Stack: strict linear chain; order PRs so each merges safely on its own, user-visible switch last${notes ? `, following ${notes}` : ''}. Run suggest_personas on the files each PR touches; a PR whose files match no persona is a gap to flag in notes.
- Precedent works: get_work on the closest ones first and inherit their Rules and Do-not-revisit lines verbatim. A decision pinned there (chain shape, companion PRs, test rules) is not an open question.
- Pending decisions already listed in the work's notes stay open: carry them as open questions, never mark one settled yourself; only ${OWNER} closes a decision.
- Open questions: product questions only, the ones a PM or ${OWNER} must answer, four at most, each yes/no with a recommendation and its tradeoff. Process questions settled by ${method ? 'SKILL.md or ' : ''}a precedent are not questions.
- paseoProject: reuse an id from list_paseo when one matches the slug; otherwise give createNamed only and omit rootPath (the worktree exists only once the work is applied).
- Diagrams: ${diagramSkill ? `read_skill ${diagramSkill} for the house style (init line, new/same/rm classDef, shapes, quoted labels, under ~15 nodes)${notes ? `, with the overrides from ${notes}` : ''}: ` :'Mermaid, under ~15 nodes, quoted labels; '}no legend box; lanes (subgraphs) group what colour would have to explain, the heading above each diagram states the point plus the one colour rule that matters, emoji are decoration only. At most a Before/After and, for a stack, a merge-order diagram.
- Links: product spec and decision log first, then the precedent PR or stack; four at most.
- Feature flags: find the flags checked around the entry points of every surface the work touches; each flag that gates one goes in betaFlags with the PRs it applies to, so testers and PR bodies name it.
To start a Paseo agent (a local Claude Code session in a work's PR workspace, from list_paseo), end with exactly one propose_paseo_agent call carrying the full brief: the card lets ${OWNER} start it. For a question, answer in prose, short, English. Quote file paths and PR numbers exactly.`;

  const providerFor = (model) => (!model ? config.models.default : model.includes('/') ? model : `${config.models.default.split('/')[0]}/${model}`);

  // onEnd(run) fires once the run is over; run.rulesProposal holds a propose_rules call.
  // A run about a work goes to the workspace of that work's stack worktree, any other to the repo's.
  function start({ prompt, workSlug, model, kind = 'ask' }, { onEnd } = {}) {
    const id = randomUUID();
    const file = path.join(DIR, `${id}.jsonl`);
    const run = { id, prompt, workSlug, kind, startedAt: new Date().toISOString(), status: 'running', events: [], proposal: null, agentProposal: null, rulesProposal: null, text: '', listeners: new Set(), agentId: null, cost: null };
    runs.set(id, run);
    const push = (ev) => {
      run.events.push(ev);
      fs.appendFileSync(file, JSON.stringify(ev) + '\n');
      for (const l of run.listeners) l(ev);
    };
    // text deltas only go to whoever is watching, batched; the finished text is pushed as one event
    let delta = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (delta) for (const l of run.listeners) l({ type: 'delta', text: delta });
      delta = '';
    };
    const onDelta = (text) => {
      delta += text;
      timer ||= setTimeout(flush, DELTA_MS);
    };
    const onEntry = (e) => {
      if (e.type === 'text') {
        clearTimeout(timer);
        timer = null;
        delta = '';
        push({ type: 'text', text: e.text });
      } else if (e.type === 'tool') {
        push({ type: 'tool', name: e.name, input: JSON.stringify(e.input ?? null).slice(0, 600) });
        if (e.output || e.error) push({ type: 'tool_result', text: String(e.error || e.output).slice(0, 400) });
      } else if (e.type === 'error') push({ type: 'stderr', text: e.text.slice(0, 2000) });
    };
    const work = workSlug ? works.get(workSlug) : null;
    (work ? workCwd({ repo: REPO, work, prInfo: works.prInfo }) : Promise.resolve(REPO))
      .then((cwd) =>
        agents.run({
          title: `Ask: ${prompt.split('\n')[0]}`,
          prompt,
          systemPrompt: SYSTEM + (workSlug ? `\nCurrent work: ${workSlug} (use get_work first).` : ''),
          provider: providerFor(model),
          cwd,
          labels: { source: 'cocopilot', kind, ask: id.slice(0, 8), work: workSlug },
          mcp: true,
          timeoutMs: TIMEOUT_MS,
          onStart: ({ agentId, workspaceId, createdWorkspace }) => {
            run.agentId = agentId;
            if (createdWorkspace) push({ type: 'meta', text: `no Paseo workspace was open on ${cwd}: created ${createdWorkspace}` });
            push({ type: 'meta', text: `Paseo agent ${agentId.slice(0, 8)} in workspace ${workspaceId} (${cwd})` });
          },
          onDelta,
          onEntry,
          onPermission: (what) => push({ type: 'meta', text: `waiting for a permission in Paseo: ${what}` }),
        }),
      )
      .then((r) => {
        run.proposal = r.submitted.propose_work_scaffold || null;
        run.agentProposal = r.submitted.propose_paseo_agent || null;
        run.rulesProposal = r.submitted.propose_rules || null;
        run.text = r.text;
        run.cost = r.cost;
        run.status = r.status === 'done' ? 'done' : 'error';
        if (r.error) push({ type: 'stderr', text: r.error });
      })
      .catch((e) => {
        run.status = 'error';
        push({ type: 'stderr', text: e.message.slice(0, 2000) });
      })
      .finally(() => {
        clearTimeout(timer);
        push({ type: 'end', status: run.status, proposal: run.proposal, agentProposal: run.agentProposal, cost: run.cost });
        fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ id, prompt, workSlug, kind, startedAt: run.startedAt, status: run.status, proposal: run.proposal, agentProposal: run.agentProposal, rulesProposal: run.rulesProposal, text: run.text, agentId: run.agentId, cost: run.cost }, null, 1));
        onEnd?.(run);
      });
    return run;
  }

  function apply(id, options = {}) {
    const run = runs.get(id) || (fs.existsSync(path.join(DIR, `${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')) : null);
    if (!run?.proposal) return { error: 'no proposal on this run' };
    const p = run.proposal;
    const existing = works.get(p.slug);
    const stack = (p.stack || []).map((s) => ({ number: s.existingPr || null, planned: { order: s.order, title: s.title, scope: s.scope, branch: s.branch }, personas: s.personas || [] }));
    const notes = [p.notes, '', '## Surface table', '', '| Surface | Entry point | Coverage |', '| --- | --- | --- |', ...(p.surfaces || []).map((s) => `| ${s.surface} | ${s.entryPoint} | ${s.coverage} |`), '', '## Open questions', '', ...(p.openQuestions || []).map((q, i) => `${i + 1}. ${q.question} Recommended: ${q.recommendation}. Tradeoff: ${q.tradeoff}`), '', '## Next steps', '', ...(p.nextSteps || []).map((s) => `- ${s}`)].join('\n');
    const work = {
      ...(existing || { createdAt: new Date().toISOString(), timeline: [] }),
      slug: p.slug,
      title: (p.title || '').slice(0, 100),
      description: p.description || '',
      summary: p.summary,
      tier: p.tier,
      projectId: p.paseoProject?.existingProjectId || existing?.projectId || null,
      projectName: p.paseoProject?.createNamed || existing?.projectName || null,
      stack: existing?.stack?.length && !options.replaceStack ? existing.stack : stack,
      personas: p.personas || [],
      links: p.links || [],
      notes,
      // a flag tied to planned PR orders follows those rows' keys (PR number once opened, else the branch)
      betaFlags: !p.betaFlags ? existing?.betaFlags || [] : p.betaFlags.map((f) => ({ code: f.code, why: f.why, ...(f.prs?.length ? { prs: f.prs.map((order) => rowKey(stack.find((s) => s.planned.order === order) || {})).filter(Boolean) } : {}) })),
    };
    work.timeline = [{ ts: new Date().toISOString(), kind: 'coco', text: `${existing ? 'updated' : 'created'} from ask ${id.slice(0, 8)}: "${run.prompt.slice(0, 120)}"` }, ...(work.timeline || [])];
    works.save(work);
    return { ok: true, slug: work.slug, created: !existing };
  }

  async function startAgent(id) {
    const run = runs.get(id) || (fs.existsSync(path.join(DIR, `${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')) : null);
    const p = run?.agentProposal;
    if (!p) return { error: 'no agent proposal on this run' };
    let started = {};
    let error = '';
    const work = p.workSlug ? works.get(p.workSlug) : null;
    try {
      const cwd = p.workspaceId ? null : p.cwd || (work ? await workCwd({ repo: REPO, work, prInfo: works.prInfo }) : REPO);
      started = await agents.start({ title: p.title, prompt: p.prompt, provider: providerFor(p.provider), thinking: p.thinking, mode: p.mode === 'bypass' ? 'bypassPermissions' : p.mode, workspaceId: p.workspaceId || null, cwd, labels: { source: 'cocopilot', ask: id.slice(0, 8) } });
    } catch (e) {
      error = e.message;
    }
    const { agentId = null, createdWorkspace = null } = started;
    if (work) {
      work.timeline.unshift({ ts: new Date().toISOString(), kind: 'agent', text: `${error ? 'failed to start' : 'started'} Paseo agent "${p.title}"${agentId ? ` (${agentId.slice(0, 8)})` : ''} from ask ${id.slice(0, 8)}${createdWorkspace ? `, in workspace ${createdWorkspace} created for it` : ''}` });
      works.save(work);
    }
    return error ? { error: error.slice(0, 500) } : { ok: true, agentId, out: `started ${agentId}${createdWorkspace ? ` in new workspace ${createdWorkspace}` : ''}` };
  }

  function list() {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  async function handle(req, res, parts, readBody, send) {
    const [, id, action] = parts;
    if (!id) {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body.prompt) return send(res, 400, { error: 'prompt required' });
        const run = start(body);
        return send(res, 200, { id: run.id });
      }
      return send(res, 200, list());
    }
    if (action === 'events') {
      const run = runs.get(id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (!run) {
        const file = path.join(DIR, `${id}.jsonl`);
        if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) write(JSON.parse(l));
        return res.end();
      }
      for (const ev of run.events) write(ev);
      if (run.status !== 'running') return res.end();
      run.listeners.add(write);
      req.on('close', () => run.listeners.delete(write));
      return;
    }
    if (action === 'apply' && req.method === 'POST') return send(res, 200, apply(id, JSON.parse((await readBody(req)) || '{}')));
    if (action === 'start-agent' && req.method === 'POST') return send(res, 200, await startAgent(id));
    const run = runs.get(id);
    if (run) return send(res, 200, { id, status: run.status, proposal: run.proposal, agentProposal: run.agentProposal, text: run.text, cost: run.cost });
    const f = path.join(DIR, `${id}.json`);
    return send(res, fs.existsSync(f) ? 200 : 404, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { error: 'no such run' });
  }

  return { handle, start };
}
