// Notion sync: one way, cocopilot → Notion. The linked page is owned by cocopilot (body replaced on every sync).
// Sync runs headless Claude Code with the claude.ai Notion connector; only the user's click starts it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const PAGE_ID_RE = /([0-9a-f]{32})(?:[?#]|$)/i;

export const pageIdFromUrl = (url) => {
  const m = (url || '').replace(/-/g, '').match(PAGE_ID_RE);
  return m ? m[1].toLowerCase() : null;
};

const stateOf = (pr) => (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : !pr.number ? 'planned' : pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : 'in review');

export function renderWorkMarkdown(work, prs) {
  const merged = prs.filter((p) => p.state === 'MERGED').length;
  const rows = prs.map((pr, i) => {
    const row = work.stack[i] || {};
    const planned = row.planned;
    const title = row.notionPage ? `<mention-page url="${row.notionPage.url}">${row.notionPage.title}</mention-page>` : pr.title || planned?.title || `PR ${i + 1}`;
    const ref = pr.number ? `[#${pr.number}](${pr.url})` : `planned · \`${planned?.branch || ''}\``;
    const scope = (row.scope || planned?.scope || '—').replace(/\|/g, '\\|');
    const reviewers = (row.personas || []).join(', ') || '—';
    return `| ${ref} | ${title} | ${scope} | ${stateOf(pr)} | ${reviewers} |`;
  });
  const childPages = (work.stack || []).filter((s) => s.notionPage).map((s) => `<page url="${s.notionPage.url}">${s.notionPage.title}</page>`);
  const links = (work.links || []).map((l) => `- [${l.label}](${l.url})`);
  const artifacts = (work.artifacts || []).map((a) => `- ${a.name}`);
  return [
    `# ${work.title}`,
    '',
    work.description || work.summary || '',
    '',
    '## Progress',
    '',
    `${merged}/${prs.length} merged · ${work.tier ? `${work.tier} tier · ` : ''}Paseo ${work.projectName || '—'}`,
    '',
    '| PR | Page | Scope | State | Reviewers |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Links',
    '',
    ...(links.length ? links : ['- none']),
    '',
    work.notes || '',
    '',
    ...(artifacts.length ? ['## Artifacts (kept in cocopilot)', '', ...artifacts] : []),
    '',
    ...(childPages.length ? ['## PR pages', '', ...childPages] : []),
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

export const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function createNotionSync({ DATA, REPO, works }) {
  const running = new Map();
  const runsFile = (slug) => path.join(DATA, 'works', slug, 'notion-runs.jsonl');
  const mdFile = (slug) => path.join(DATA, 'works', slug, 'notion-sync.md');

  function status(work, prs) {
    const markdown = renderWorkMarkdown(work, prs);
    const currentHash = hashOf(markdown);
    const n = work.notion || null;
    const run = running.get(work.slug);
    return {
      linked: Boolean(n?.pageId),
      pageId: n?.pageId || null,
      url: n?.url || null,
      syncedAt: n?.syncedAt || null,
      currentHash,
      outOfSync: Boolean(n?.pageId) && n.syncedHash !== currentHash,
      editedInNotion: n?.editedInNotion || null,
      lastError: n?.lastError || null,
      running: run?.mode || null,
      startedAt: run?.startedAt || null,
      preview: n?.preview && n.preview.hash === currentHash ? n.preview : null,
    };
  }

  function link(slug, url) {
    const work = works.get(slug);
    const pageId = pageIdFromUrl(url);
    if (!work || !pageId) return { error: 'no such work or no page id in url' };
    work.notion = { pageId, url, syncedAt: null, syncedHash: null, editedInNotion: null, lastError: null };
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `linked Notion page ${pageId}` });
    works.save(work);
    return { ok: true, pageId };
  }

  function discardPreview(slug) {
    const work = works.get(slug);
    if (!work?.notion) return { error: 'no such work' };
    work.notion.preview = null;
    works.save(work);
    return { ok: true };
  }

  function unlink(slug) {
    const work = works.get(slug);
    if (!work) return { error: 'no such work' };
    delete work.notion;
    work.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: 'Notion page unlinked' });
    works.save(work);
    return { ok: true };
  }

  function prompt({ work, markdown, force, parentPageId }) {
    const n = work.notion || {};
    const target = n.pageId
      ? `Target page id: ${n.pageId}. First call notion-fetch on it and read its last_edited_time. ${force ? 'Overwrite whatever is there.' : `If last_edited_time is later than ${n.syncedAt || '1970-01-01T00:00:00Z'}, STOP without writing and answer with status "edited-in-notion".`} Then notion-update-page with command replace_content, keeping the page title "${work.title}".`
      : `No page yet. Create ONE page titled "${work.title}" under parent page id ${parentPageId} with notion-create-pages and put the content in it.`;
    return `You sync a cocopilot work to Notion. Read the markdown in ${mdFile(work.slug)} (Read tool). ${target}
Content rules: start with a gray callout "Synced from cocopilot on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Edits here are overwritten on the next sync; write in cocopilot or in a child page." Then the markdown as is: headings stay headings, tables become native tables, a mermaid block becomes a code block with language mermaid, links stay links, <mention-page> and <page> tags stay as they are (the <page> tags keep the existing child pages in place). Do not add, summarise or reorder anything. Do not touch comments or child pages. Do nothing else in Notion.
Final answer: one line of JSON only: {"status":"synced"|"edited-in-notion"|"error","pageId":"<id>","url":"<page url>","lastEditedTime":"<iso or null>","message":"<short>"}`;
  }

  function previewPrompt({ work }) {
    return `You prepare a Notion sync for a cocopilot work, read-only: you write nothing. Fetch Notion page ${work.notion.pageId} with notion-fetch and note its last_edited_time. Read the new content in ${mdFile(work.slug)} (Read tool). Compare the page as it is now with the new content and list what the sync would change for a reader of the page, one line per change, grouped by section (description, progress and stack, links, notes, other). Severity per change: "high" when a rule, a decision, a behaviour in the Before/After table or a whole section changes or disappears, or when text written by a human on the page (not present in the new content) would be lost; "medium" when a PR, reviewer set, open question or link changes; "low" for progress, state, dates and wording. Call out separately any paragraph on the page that is not in the new content: that is human text the sync would erase.
Final answer: one line of JSON only: {"lastEditedTime":"<iso or null>","changes":[{"section":"<name>","severity":"high"|"medium"|"low","what":"<one sentence>"}],"lostText":["<verbatim first words of each paragraph that would be erased>"],"summary":"<two sentences max>"}`;
  }

  function sync(slug, { force = false, parentPageId = null, mode = 'apply' } = {}) {
    const work = works.get(slug);
    if (!work) return { error: 'no such work' };
    if (running.has(slug)) return { error: 'sync already running' };
    if (!work.notion?.pageId && !parentPageId) return { error: 'no linked page: pass parentPageId to create one' };
    return works.detailPrs(slug).then((prs) => {
      const markdown = renderWorkMarkdown({ ...work, artifacts: works.listArtifacts(slug) }, prs);
      fs.mkdirSync(path.dirname(mdFile(slug)), { recursive: true });
      fs.writeFileSync(mdFile(slug), markdown);
      const hash = hashOf(markdown);
      const preview = mode === 'preview';
      const tools = preview ? ['Read', 'mcp__claude_ai_Notion__notion-fetch'] : ['Read', 'mcp__claude_ai_Notion__notion-fetch', 'mcp__claude_ai_Notion__notion-update-page', 'mcp__claude_ai_Notion__notion-create-pages'];
      // --allowedTools is variadic: the prompt must come before it or it is read as a tool name.
      const args = ['-p', preview ? previewPrompt({ work }) : prompt({ work, markdown, force, parentPageId }), '--output-format', 'json', '--permission-mode', 'default', '--max-turns', '8', '--allowedTools', ...tools];
      const child = spawn('claude', args, { cwd: REPO || DATA, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDECODE: '' } });
      const run = { mode, startedAt: new Date().toISOString(), out: '', err: '' };
      running.set(slug, run);
      child.stdout.on('data', (d) => (run.out += d));
      child.stderr.on('data', (d) => (run.err += String(d).slice(0, 2000)));
      child.on('close', (code) => {
        running.delete(slug);
        const w = works.get(slug);
        let result = null;
        let cost = null;
        try {
          const j = JSON.parse(run.out);
          cost = j.total_cost_usd ?? null;
          const m = String(j.result || '').match(/\{[\s\S]*\}/);
          result = m ? JSON.parse(m[0]) : null;
        } catch {
          result = null;
        }
        const n = w.notion || {};
        if (preview) {
          if (result?.changes) {
            w.notion = { ...n, preview: { at: new Date().toISOString(), hash, ...result }, lastError: null };
          } else {
            w.notion = { ...n, lastError: result?.message || run.err.slice(0, 300) || `preview failed (claude exited ${code})` };
          }
        } else if (result?.status === 'synced') {
          w.notion = { ...n, pageId: result.pageId || n.pageId, url: result.url || n.url, syncedAt: new Date().toISOString(), syncedHash: hash, editedInNotion: null, lastError: null, preview: null };
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `${n.pageId ? 'synced' : 'created and synced'} Notion page ${w.notion.pageId}` });
        } else if (result?.status === 'edited-in-notion') {
          w.notion = { ...n, editedInNotion: result.lastEditedTime || 'unknown', lastError: null };
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `sync stopped: page edited in Notion at ${result.lastEditedTime}; confirm to overwrite` });
        } else {
          w.notion = { ...n, lastError: result?.message || run.err.slice(0, 300) || `claude exited ${code}` };
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `sync failed: ${w.notion.lastError}` });
        }
        works.save(w);
        fs.appendFileSync(runsFile(slug), JSON.stringify({ ts: run.startedAt, mode, force, parentPageId, code, cost, result, err: run.err.slice(0, 500) }) + '\n');
      });
      return { ok: true, startedAt: run.startedAt };
    });
  }

  return { status, link, unlink, discardPreview, sync, renderWorkMarkdown };
}
