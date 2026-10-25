// Opportunity inbox: a Notion page, a GitHub PR or issue, or a Slack permalink becomes a work scaffold proposal.
// Coco reads the link with read-only tools and ends with propose_work_scaffold; the work exists only once the user presses Create work.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sources = (github) => [
  { kind: 'notion', re: /^https:\/\/(www\.)?notion\.(so|site)\//, read: 'Read the page with notion-fetch (and notion-search for linked specs if needed).' },
  ...(github ? [{ kind: 'github', re: new RegExp(`^https://github\\.com/${escape(github)}/(pull|issues)/(\\d+)`), read: `Read it with github_pr for a PR or \`gh issue view <n> --repo ${github} --comments\` for an issue.` }] : []),
  { kind: 'slack', re: /^https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/, read: 'Read the thread with slack_read_thread (channel id and message ts from the permalink: p1712345678123456 is ts 1712345678.123456). Slack is read-only: never send, reply or react.' },
];

export function inboxPrompt(url, note = '', { github = '', owner = 'the user', methodSkill = '', methodNotes = '' } = {}) {
  const u = String(url || '').trim();
  const source = sources(github).find((s) => s.re.test(u));
  if (!source) return null;
  return {
    kind: source.kind,
    prompt: [
      `New opportunity from ${source.kind}: ${u}`,
      ...(note.trim() ? ['', `${owner}'s note: ${note.trim()}`] : []),
      '',
      source.read,
      `Then frame it as a work${methodSkill && methodNotes ? ` (read_skill ${methodNotes} first for how a scaffold is shaped)` : ''}: size it (tier: small, stacked or unattended), find precedent works and PRs (list_works, get_work on the closest, github_search), the surfaces touched, the owner personas per planned PR (suggest_personas on the paths), and the planned stack.`,
      'Title: product label, 100 characters at most. Description: one summary paragraph, then the Surface | Before | After table. Put the precedents (PR numbers, shas, works) as bullets under `## Precedents` in the notes, and the source link first in links.',
      `End with exactly one propose_work_scaffold call. Nothing is created until ${owner} presses Create work.`,
    ].join('\n'),
  };
}

export function createInbox({ ask, config }) {
  const opts = { github: config.repo.github, owner: config.owner.name, methodSkill: config.methodSkill, methodNotes: config.methodNotes };
  async function handle(req, res, parts, readBody, send) {
    if (req.method !== 'POST') return send(res, 404, { error: 'no route' });
    const { url, note = '' } = JSON.parse((await readBody(req)) || '{}');
    const p = inboxPrompt(url, note, opts);
    if (!p) return send(res, 400, { error: `paste a Notion page, ${opts.github ? `a ${opts.github} PR or issue, ` : ''}or a Slack permalink` });
    const run = ask.start({ prompt: p.prompt, kind: 'inbox' });
    return send(res, 200, { id: run.id, kind: p.kind });
  }
  return { handle };
}
