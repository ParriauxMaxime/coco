// Notion sync: one way, cocopilot → Notion. The linked page is owned by cocopilot (body replaced on every sync).
// Sync runs a Paseo agent with the claude.ai Notion connector; only the user's click starts it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPaseoAgents, workCwd } from './paseo-agent.ts';
import type { Config } from './config.ts';
import { errorMessage } from './core-types.ts';
import type { Artifact, PrInfo, StackRow, Work } from './core-types.ts';
import { rowKey } from './stack.ts';
import { deferredJob } from './jobs.ts';
import type { Jobs } from './jobs.ts';

const PAGE_ID_RE = /([0-9a-f]{32})(?:[?#]|$)/i;
const TIMEOUT_MS = 10 * 60 * 1000;

export interface AgentJson {
  status?: string;
  pageId?: string;
  url?: string;
  lastEditedTime?: string | null;
  message?: string;
  changes?: unknown;
  [key: string]: unknown;
}

interface AgentRun {
  status?: string;
  finalText?: string;
  text?: string;
  cost?: unknown;
  agentId?: string | null;
  workspaceId?: string | null;
  createdWorkspace?: string | null;
  error?: string | null;
}

export interface NotionAgents {
  run(opts: { title: string; prompt: string; provider: string; cwd: string; workspaceId?: string | null; labels: Record<string, string>; timeoutMs: number }): Promise<AgentRun>;
}

interface NotionWorks {
  get(slug: string): Work | null;
  save(work: Work): unknown;
  listArtifacts(slug: string): Artifact[];
  detailPrs(slug: string): Promise<PrInfo[]>;
  prInfo(number: number | null): Promise<PrInfo>;
  // the work's root workspace, when placement is wired
  place?(slug: string): Promise<{ workspaceId: string; cwd: string }> | null;
}

// the agent ends on one line of JSON; the last such line wins, then any object in the text
export const lastJson = (text: unknown): AgentJson | null => {
  const attempt = (s: string): AgentJson | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  for (const line of String(text).split('\n').reverse()) {
    const m = line.match(/\{.*\}/);
    const v = m && attempt(m[0]);
    if (v) return v;
  }
  const m = String(text).match(/\{[\s\S]*\}/);
  return m ? attempt(m[0]) : null;
};

export const pageIdFromUrl = (url: string | null | undefined): string | null => {
  const m = (url || '').replace(/-/g, '').match(PAGE_ID_RE);
  return m ? m[1].toLowerCase() : null;
};

const stateOf = (pr: PrInfo) => (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : !pr.number ? 'planned' : pr.isDraft ? 'draft' : pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : 'in review');

export function renderWorkMarkdown(work: Work, prs: PrInfo[]): string {
  const merged = prs.filter((p) => p.state === 'MERGED').length;
  const rows = prs.map((pr, i) => {
    const row: StackRow = work.stack[i] || {};
    const planned = row.planned;
    const title = row.notionPage ? `<mention-page url="${row.notionPage.url}">${row.notionPage.title}</mention-page>` : pr.title || planned?.title || `PR ${i + 1}`;
    const ref = pr.number ? `[#${pr.number}](${pr.url})` : `planned · \`${planned?.branch || ''}\``;
    const scope = (row.scope || planned?.scope || '—').replace(/\|/g, '\\|');
    const reviewers = (row.personas || []).join(', ') || '—';
    return `| ${ref} | ${title} | ${scope} | ${stateOf(pr)} | ${reviewers} |`;
  });
  const childPages = (work.stack || []).flatMap((s) => (s.notionPage ? [`<page url="${s.notionPage.url}">${s.notionPage.title}</page>`] : []));
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

export const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

interface SyncOptions {
  force?: boolean;
  parentPageId?: string | null;
  mode?: string;
  rowPages?: { row: string; title: string }[];
}

interface FinishArgs {
  status?: string;
  result?: AgentJson | null;
  cost?: unknown;
  agentId?: string | null;
  workspaceId?: string | null;
  createdWorkspace?: string | null;
  err?: string;
}

export function createNotionSync({ DATA, REPO, config, works, agents = createPaseoAgents(), jobs }: { DATA: string; REPO: string; config: Config; works: NotionWorks; agents?: NotionAgents; jobs?: Pick<Jobs, 'start' | 'link'> }) {
  const running = new Map<string, { mode: string; startedAt: string }>();
  const runsFile = (slug: string) => path.join(DATA, 'works', slug, 'notion-runs.jsonl');
  const mdFile = (slug: string) => path.join(DATA, 'works', slug, 'notion-sync.md');

  function status(work: Work, prs: PrInfo[]) {
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
      outOfSync: Boolean(n?.pageId) && n?.syncedHash !== currentHash,
      editedInNotion: n?.editedInNotion || null,
      lastError: n?.lastError || null,
      running: run?.mode || null,
      startedAt: run?.startedAt || null,
      preview: n?.preview && n.preview.hash === currentHash ? n.preview : null,
    };
  }

  function link(slug: string, url: string) {
    const work = works.get(slug);
    const pageId = pageIdFromUrl(url);
    if (!work || !pageId) return { error: 'no such work or no page id in url' };
    work.notion = { pageId, url, syncedAt: null, syncedHash: null, editedInNotion: null, lastError: null };
    (work.timeline ??= []).unshift({ ts: new Date().toISOString(), kind: 'notion', text: `linked Notion page ${pageId}` });
    works.save(work);
    return { ok: true, pageId };
  }

  function discardPreview(slug: string) {
    const work = works.get(slug);
    if (!work?.notion) return { error: 'no such work' };
    work.notion.preview = null;
    works.save(work);
    return { ok: true };
  }

  function unlink(slug: string) {
    const work = works.get(slug);
    if (!work) return { error: 'no such work' };
    delete work.notion;
    (work.timeline ??= []).unshift({ ts: new Date().toISOString(), kind: 'notion', text: 'Notion page unlinked' });
    works.save(work);
    return { ok: true };
  }

  function prompt({ work, force, parentPageId, rowPages = [] }: { work: Work; force: boolean; parentPageId: string | null; rowPages?: { row: string; title: string }[] }) {
    const n = work.notion || {};
    const target = n.pageId
      ? `Target page id: ${n.pageId}. First call notion-fetch on it and read its last_edited_time. ${force ? 'Overwrite whatever is there.' : `If last_edited_time is later than ${n.syncedAt || '1970-01-01T00:00:00Z'}, STOP without writing and answer with status "edited-in-notion".`} Then notion-update-page with command replace_content, keeping the page title "${work.title}".`
      : `No page yet. Create ONE page titled "${work.title}" under parent page id ${parentPageId} with notion-create-pages and put the content in it.`;
    return `You sync a cocopilot work to Notion. Read the markdown in ${mdFile(work.slug)} (Read tool). ${target}
Content rules: start with a gray callout "Synced from cocopilot on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Edits here are overwritten on the next sync; write in cocopilot or in a child page." Then the markdown as is: headings stay headings, tables become native tables, a mermaid block becomes a code block with language mermaid, links stay links, <mention-page> and <page> tags stay as they are (the <page> tags keep the existing child pages in place). Do not add, summarise or reorder anything. Do not touch comments or child pages. Do nothing else in Notion.${rowPages.length ? `
After the content, create ONE child page under the work page (notion-create-pages, parent = the work page) for each of these rows, titled as given, with a one-line body: ${rowPages.map((r) => `${r.row} "${r.title}"`).join('; ')}. Add "rowPages":[{"row":"<row as given>","url":"<page url>","title":"<page title>"}] to the JSON.` : ''}
Final answer: one line of JSON only: {"status":"synced"|"edited-in-notion"|"error","pageId":"<id>","url":"<page url>","lastEditedTime":"<iso or null>","message":"<short>"}`;
  }

  function previewPrompt({ work }: { work: Work }) {
    return `You prepare a Notion sync for a cocopilot work, read-only: you write nothing. Fetch Notion page ${work.notion?.pageId} with notion-fetch and note its last_edited_time. Read the new content in ${mdFile(work.slug)} (Read tool). Compare the page as it is now with the new content and list what the sync would change for a reader of the page, one line per change, grouped by section (description, progress and stack, links, notes, other). Severity per change: "high" when a rule, a decision, a behaviour in the Before/After table or a whole section changes or disappears, or when text written by a human on the page (not present in the new content) would be lost; "medium" when a PR, reviewer set, open question or link changes; "low" for progress, state, dates and wording. Call out separately any paragraph on the page that is not in the new content: that is human text the sync would erase.
Final answer: one line of JSON only: {"lastEditedTime":"<iso or null>","changes":[{"section":"<name>","severity":"high"|"medium"|"low","what":"<one sentence>"}],"lostText":["<verbatim first words of each paragraph that would be erased>"],"summary":"<two sentences max>"}`;
  }

  function sync(slug: string, { force = false, parentPageId = null, mode = 'apply', rowPages = [] }: SyncOptions = {}) {
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
      const brief = preview ? previewPrompt({ work }) : prompt({ work, force, parentPageId, rowPages });
      const run = { mode, startedAt: new Date().toISOString() };
      running.set(slug, run);
      const tracked = deferredJob(jobs, { work: slug, action: `notion-${mode}`, label: `Notion ${preview ? 'preview' : 'sync'}`, kind: 'sync' });
      const finish = (args: FinishArgs) => {
        settle(args);
        const n = works.get(slug)?.notion;
        if (tracked.job) jobs?.link(tracked.job, args.agentId);
        if (preview ? n?.preview && !n.lastError : n?.syncedHash === hash && !n.lastError) tracked.resolve();
        else tracked.reject(new Error(n?.editedInNotion ? 'the page was edited in Notion: confirm to overwrite' : n?.lastError || `Notion ${mode} failed`));
      };
      const settle = ({ status = 'error', result = null, cost = null, agentId = null, workspaceId = null, createdWorkspace = null, err = '' }: FinishArgs) => {
        running.delete(slug);
        const w = works.get(slug);
        if (!w) return;
        const n = w.notion || {};
        w.timeline ??= [];
        if (preview) {
          if (result?.changes) {
            w.notion = { ...n, preview: { at: new Date().toISOString(), hash, ...result }, lastError: null };
          } else {
            w.notion = { ...n, lastError: result?.message || err.slice(0, 300) || `preview failed (agent ${status})` };
          }
        } else if (result?.status === 'synced') {
          w.notion = { ...n, pageId: result.pageId || n.pageId, url: result.url || n.url, syncedAt: new Date().toISOString(), syncedHash: hash, editedInNotion: null, lastError: null, preview: null };
          for (const p of (Array.isArray(result.rowPages) ? result.rowPages : []) as { row?: string; url?: string; title?: string }[]) {
            const row = w.stack.find((x) => String(rowKey(x)) === p.row && !x.notionPage);
            if (row && p.url && /^https:\/\/(www\.)?notion\.(so|site)\//.test(p.url)) row.notionPage = { url: p.url, title: p.title || rowPages.find((r) => r.row === p.row)?.title || String(p.row) };
          }
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `${n.pageId ? 'synced' : 'created and synced'} Notion page ${w.notion.pageId}` });
        } else if (result?.status === 'edited-in-notion') {
          w.notion = { ...n, editedInNotion: result.lastEditedTime || 'unknown', lastError: null };
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `sync stopped: page edited in Notion at ${result.lastEditedTime}; confirm to overwrite` });
        } else {
          const lastError = result?.message || err.slice(0, 300) || `agent ${status}`;
          w.notion = { ...n, lastError };
          w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `sync failed: ${lastError}` });
        }
        if (createdWorkspace) w.timeline.unshift({ ts: new Date().toISOString(), kind: 'notion', text: `no Paseo workspace was open for this work: created ${createdWorkspace}` });
        works.save(w);
        fs.appendFileSync(runsFile(slug), JSON.stringify({ ts: run.startedAt, mode, force, parentPageId, agentId, workspaceId, createdWorkspace, status, cost, result, err: err.slice(0, 500) }) + '\n');
      };
      (works.place?.(slug) || (REPO ? workCwd({ repo: REPO, work, prInfo: works.prInfo }) : Promise.resolve(DATA)).then((cwd) => ({ cwd, workspaceId: null })))
        .then((where) => agents.run({ title: `Notion ${preview ? 'preview' : 'sync'}: ${work.title}`, prompt: brief, provider: config.models.fast || config.models.default, ...where, labels: { source: 'cocopilot', kind: `notion-${mode}`, work: slug }, timeoutMs: TIMEOUT_MS }))
        .then(
          (r) => finish({ status: r.status, result: lastJson(r.finalText) || lastJson(r.text), cost: r.cost, agentId: r.agentId, workspaceId: r.workspaceId, createdWorkspace: r.createdWorkspace, err: r.error || '' }),
          (e: unknown) => finish({ err: errorMessage(e) }),
        );
      return { ok: true, startedAt: run.startedAt };
    });
  }

  return { status, link, unlink, discardPreview, sync, renderWorkMarkdown };
}
