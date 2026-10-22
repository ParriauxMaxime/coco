// "Ask coco": natural language → Claude Code headless run with the cocopilot MCP server, streamed over SSE.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rowKey } from './stack.mjs';

const READ_CONNECTORS = ['mcp__claude_ai_Notion__notion-fetch', 'mcp__claude_ai_Notion__notion-search', 'mcp__claude_ai_Slack__slack_read_thread', 'mcp__claude_ai_Slack__slack_read_channel', 'mcp__claude_ai_Slack__slack_search_public', 'mcp__claude_ai_Slack__slack_read_user_profile'];

export function createAsk({ DATA, APP, REPO, config, works }) {
  const DIR = path.join(DATA, 'asks');
  fs.mkdirSync(DIR, { recursive: true });
  const mcpConfig = path.join(APP, 'server/mcp-config.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { cocopilot: { command: 'node', args: [path.join(APP, 'server/mcp.mjs')] } } }, null, 1));
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

  // onEnd(run) fires once the run is over; run.rulesProposal holds a propose_rules call.
  // connectors: the user's claude.ai Notion and Slack connectors load too, their read tools only.
  function start({ prompt, workSlug, model, kind = 'ask' }, { onEnd, connectors = false } = {}) {
    const id = randomUUID();
    const file = path.join(DIR, `${id}.jsonl`);
    const run = { id, prompt, workSlug, kind, startedAt: new Date().toISOString(), status: 'running', events: [], proposal: null, agentProposal: null, rulesProposal: null, text: '', listeners: new Set(), sessionId: null, cost: null };
    runs.set(id, run);
    const push = (ev) => {
      run.events.push(ev);
      fs.appendFileSync(file, JSON.stringify(ev) + '\n');
      for (const l of run.listeners) l(ev);
    };
    const context = workSlug ? `\nCurrent work: ${workSlug} (use get_work first).` : '';
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', mcpConfig, ...(connectors ? [] : ['--strict-mcp-config']), '--permission-mode', 'default', '--allowedTools', 'mcp__cocopilot__*', 'Read', 'Grep', 'Glob', 'Bash(gh pr view *)', 'Bash(gh issue view *)', 'Bash(gh search *)', 'Bash(git log *)', 'Bash(paseo * ls *)', 'WebFetch', ...(connectors ? READ_CONNECTORS : []), '--append-system-prompt', SYSTEM + context, '--max-turns', '40'];
    if (model) args.push('--model', model);
    args.push(prompt);
    push({ type: 'meta', text: `claude ${args.slice(0, 4).join(' ')} … (cwd ${REPO})` });
    const child = spawn('claude', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDECODE: '' } });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          push({ type: 'raw', text: line });
          continue;
        }
        handle(ev);
      }
    });
    child.stderr.on('data', (d) => push({ type: 'stderr', text: String(d).slice(0, 2000) }));
    child.on('close', (code) => {
      run.status = run.status === 'running' ? (code === 0 ? 'done' : 'error') : run.status;
      push({ type: 'end', code, status: run.status, proposal: run.proposal, agentProposal: run.agentProposal, cost: run.cost });
      fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ id, prompt, workSlug, kind, startedAt: run.startedAt, status: run.status, proposal: run.proposal, agentProposal: run.agentProposal, rulesProposal: run.rulesProposal, text: run.text, sessionId: run.sessionId, cost: run.cost }, null, 1));
      onEnd?.(run);
    });
    function handle(ev) {
      if (ev.type === 'system' && ev.session_id) run.sessionId = ev.session_id;
      if (ev.type === 'assistant') {
        for (const block of ev.message?.content || []) {
          if (block.type === 'text') {
            run.text += block.text + '\n';
            push({ type: 'text', text: block.text });
          }
          if (block.type === 'tool_use') {
            if (block.name === 'mcp__cocopilot__propose_work_scaffold') run.proposal = block.input;
            if (block.name === 'mcp__cocopilot__propose_paseo_agent') run.agentProposal = block.input;
            if (block.name === 'mcp__cocopilot__propose_rules') run.rulesProposal = block.input;
            push({ type: 'tool', name: block.name, input: JSON.stringify(block.input).slice(0, 600) });
          }
        }
      }
      if (ev.type === 'user') {
        for (const block of ev.message?.content || []) if (block.type === 'tool_result') push({ type: 'tool_result', text: (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)).slice(0, 400) });
      }
      if (ev.type === 'result') {
        run.cost = ev.total_cost_usd ?? null;
        run.status = ev.is_error ? 'error' : 'done';
        if (ev.result && !run.text) run.text = ev.result;
      }
    }
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
    const args = ['run', '-d', '--title', p.title.slice(0, 60), '--provider', p.provider || config.models.default, '--thinking', p.thinking || 'high', '--mode', p.mode || 'auto', '--label', 'source=cocopilot', '--label', `ask=${id.slice(0, 8)}`];
    if (p.workspaceId) args.push('--workspace', p.workspaceId);
    else args.push('--cwd', p.cwd || REPO);
    args.push(p.prompt);
    const r = await new Promise((resolve) => execFile('paseo', args, { maxBuffer: 4e6 }, (err, out, errout) => resolve({ ok: !err, out: String(out || ''), err: String(errout || err?.message || '') })));
    const agentId = (r.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0] || null;
    if (p.workSlug) {
      const work = works.get(p.workSlug);
      if (work) {
        work.timeline.unshift({ ts: new Date().toISOString(), kind: 'agent', text: `${r.ok ? 'started' : 'failed to start'} Paseo agent "${p.title}"${agentId ? ` (${agentId.slice(0, 8)})` : ''} from ask ${id.slice(0, 8)}` });
        works.save(work);
      }
    }
    return r.ok ? { ok: true, agentId, out: r.out.slice(0, 500) } : { error: (r.err || r.out).slice(0, 500) };
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
