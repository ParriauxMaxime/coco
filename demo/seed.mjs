// Seeds the demo cocopilot (port 8790) with one fictional work, findings, a review plan and a thread.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP = process.env.COCO_APP;
const COCO = process.env.COCO_URL || 'http://127.0.0.1:8790';
const REPO = process.env.DEMO_REPO || '/tmp/coco-demo/widgets';
const DATA = process.env.DEMO_DATA || '/tmp/coco-demo/data';
const SLUG = 'invoice-csv-export';
const { normalizePlan } = await import(path.join(APP, 'server/review-plan.mjs'));

const api = async (method, p, body) => {
  const r = await fetch(COCO + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t}`);
  return JSON.parse(t);
};
const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
const lineOf = (sha, file, needle) => {
  const i = git('show', `${sha}:${file}`).split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not in ${file}`);
  return i + 1;
};

await fetch(`${COCO}/api/works/${SLUG}`, { method: 'DELETE' });
fs.rmSync(path.join(DATA, 'works', SLUG), { recursive: true, force: true });

const description = `Finance teams copy invoices into spreadsheets by hand every month. This work adds a **CSV export** of the invoices list, behind a flag.

| Surface | Before | After |
| --- | --- | --- |
| Invoices page | List only, copy by hand | **Export CSV** button, current date range |
| API | \`GET /invoices\` (JSON) | + \`GET /invoices/export.csv\` |
| Flags | — | \`invoiceCsvExport\`, off until launch |

\`\`\`mermaid
flowchart LR
  A[Invoices page] -->|Export CSV| B[GET /invoices/export.csv]
  B --> C{invoices:export?}
  C -->|yes| D[toCsv] --> E[invoices-2026-10-09.csv]
  C -->|no| F[403]
\`\`\``;

const row = (order, branch, title, scope, personas) => ({ planned: { order, title, scope, branch }, personas });
const ts = (d) => new Date(d).toISOString();

await api('POST', '/api/works', {
  slug: SLUG,
  title: 'Export invoices as CSV',
  summary: 'Finance teams download the invoices list as CSV instead of copying it by hand.',
  description,
  projectName: 'widgets',
  tier: 'Stack',
  personas: ['alice', 'bob', 'carol'],
  stack: [
    row(1, 'export-api', 'CSV serializer and export endpoint', 'Finance admins can download `invoices.csv` from the API, filtered by date range.', ['alice', 'carol']),
    row(2, 'export-ui', 'Export CSV button on the invoices page', 'An **Export CSV** button next to the invoices title downloads the current range.', ['bob']),
    row(3, 'export-toggle', 'Ship it behind invoiceCsvExport', 'The button only shows when the `invoiceCsvExport` flag is on.', ['bob']),
  ],
  links: [
    { label: 'Spec', url: 'https://example.com/acme/specs/invoice-csv-export' },
    { label: 'Design', url: 'https://example.com/acme/design/export-button' },
  ],
  betaFlags: [{ code: 'invoiceCsvExport', why: 'Shows the Export CSV button', prs: [] }],
  notes: `## Do not revisit\n- CSV only for v1; XLSX is a follow-up.\n\n## Precedents\n- The payouts export (2025) streams rows; reuse its cursor helper.\n`,
  timeline: [
    { ts: ts('2026-10-09T14:31:00+02:00'), kind: 'note', text: 'export-toggle committed locally' },
    { ts: ts('2026-10-08T16:46:00+02:00'), kind: 'note', text: 'export-ui committed locally' },
    { ts: ts('2026-10-06T15:41:00+02:00'), kind: 'note', text: 'export-api committed locally' },
    { ts: ts('2026-10-05T09:00:00+02:00'), kind: 'created', text: 'work created from the spec' },
  ],
  createdAt: ts('2026-10-05T09:00:00+02:00'),
  decisions: [
    {
      id: 'd1-range',
      title: 'D1 · Export scope',
      question: 'What does Export CSV download?',
      details: 'The invoices page shows a date range and a status filter. Finance asked for "what I see".',
      confidence: 80,
      options: [
        { key: 'view', label: 'What the page shows (range + status)', details: 'Same query as the list; the button passes both filters.', confidence: 80 },
        { key: 'range', label: 'The date range only', details: 'Simpler; status filtered in the spreadsheet.' },
        { key: 'all', label: 'Every invoice of the account', details: 'Largest file; needs streaming first.' },
      ],
      recommended: 'view',
      positions: { alice: 'What the page shows: least surprise.', carol: 'Fine, as long as the query stays bounded.' },
      source: 'Spec review',
      pr: 'b:export-ui',
    },
    {
      id: 'd2-flag',
      title: 'D2 · Rollout',
      question: 'How do we roll it out?',
      options: [
        { key: 'flag', label: 'Behind a flag, off by default' },
        { key: 'direct', label: 'Ship to everyone' },
      ],
      recommended: 'flag',
      status: 'taken',
      choice: 'flag',
      rationale: 'Finance beta first, then everyone.',
      decidedAt: ts('2026-10-07T10:00:00+02:00'),
    },
  ],
});

const keys = { api: 'b:export-api', ui: 'b:export-ui', toggle: 'b:export-toggle' };
const head = {};
for (const [k, n] of Object.entries(keys)) head[k] = (await api('GET', `/api/code/pr/${n}/refs?fresh=1`)).headSha;

const CSV = 'src/invoices/csv-export.ts';
const ROUTE = 'src/api/routes/export.routes.ts';
const TEST = 'test/csv-export.test.ts';
const BTN = 'src/client/ExportButton.tsx';
const HOOK = 'src/client/use-export.ts';
const FLAGS = 'src/config/flags.ts';

const escapeStart = lineOf(head.api, CSV, 'const escapeCell');
const permLine = lineOf(head.api, ROUTE, "can(req.caller, 'invoices:read')");
const isoLine = lineOf(head.api, CSV, 'const isoDate');
const loadLine = lineOf(head.api, ROUTE, 'const invoices = await findInvoices');
const fileLine = lineOf(head.api, ROUTE, 'Content-Disposition');
const describeLine = lineOf(head.api, TEST, "describe('toCsv'");
const clickLine = lineOf(head.ui, BTN, 'onClick=');
const errLine = lineOf(head.ui, HOOK, "setError('Export failed");
const flagLine = lineOf(head.toggle, FLAGS, 'invoiceCsvExport');

const findings = [
  [keys.api, {
    path: CSV, sha: head.api, startLine: escapeStart, endLine: escapeStart + 3, author: 'opus-review', severity: 'blocking', confidence: 88,
    title: 'Customer names starting with = run as formulas in Excel',
    summary: 'A customer named `=HYPERLINK(...)` lands in the CSV as is: Excel and Sheets evaluate it when finance opens the file.',
    category: 'In-stack bug (security)',
    recommendation: 'Fix in export-api: prefix cells starting with `=`, `+`, `-`, `@`, tab or CR with a `\'` before quoting.',
    blocks: [
      { type: 'steps', title: 'Path', items: ['A customer signs up as `=HYPERLINK("https://evil.example","Refund")`', '`invoiceToRow` copies `customerName` untouched', '`escapeCell` only quotes `"`, `,` and newlines'], outcome: '<risk>Formula runs</risk> on the finance laptop that opens the export' },
      { type: 'table', caption: 'Cell starts with', columns: ['Prefix', 'Excel', 'Google Sheets', 'After fix'], rows: [
        ['`=`', { text: 'formula', tone: 'risk' }, { text: 'formula', tone: 'risk' }, { text: 'text', tone: 'ok' }],
        ['`+` / `-`', { text: 'formula', tone: 'risk' }, { text: 'formula', tone: 'risk' }, { text: 'text', tone: 'ok' }],
        ['`@`', { text: 'formula', tone: 'risk' }, { text: 'text', tone: 'ok' }, { text: 'text', tone: 'ok' }],
      ] },
      { type: 'suggestion', path: CSV, startLine: escapeStart, endLine: escapeStart + 3, lang: 'ts', after: "const escapeCell = (raw: string) => {\n  const value = /^[=+\\-@\\t\\r]/.test(raw) ? `'${raw}` : raw;\n  if (/[\",\\n]/.test(value)) return `\"${value.replaceAll('\"', '\"\"')}\"`;\n  return value;\n};" },
    ],
    sources: [{ label: 'OWASP CSV injection', url: 'https://owasp.org/www-community/attacks/CSV_Injection' }],
  }],
  [keys.api, {
    path: ROUTE, sha: head.api, startLine: permLine, endLine: permLine, author: 'as-alice', severity: 'major', confidence: 92,
    title: 'Export checks invoices:read, not invoices:export',
    summary: 'Any member who can see the list downloads every invoice of the account, while `invoices:export` exists for exactly this.',
    category: 'In-stack bug (permissions)',
    recommendation: 'Fix in export-api: check `invoices:export` before reading the query.',
    blocks: [
      { type: 'table', caption: 'Who can do what', columns: ['Role', 'List invoices', 'Export today', 'Expected'], rows: [
        ['admin', { text: 'yes', tone: 'ok' }, { text: 'yes', tone: 'ok' }, 'yes'],
        ['finance', { text: 'yes', tone: 'ok' }, { text: 'yes', tone: 'ok' }, 'yes'],
        ['support', { text: 'yes', tone: 'ok' }, { text: 'yes', tone: 'risk' }, { text: 'no', tone: 'warn' }],
      ] },
      { type: 'diagram', mermaid: "sequenceDiagram\n  participant S as Support agent\n  participant API as export.routes\n  participant DB as invoices\n  S->>API: GET /invoices/export.csv\n  API->>API: can(invoices:read) ✓\n  API->>DB: findInvoices(account)\n  DB-->>S: every invoice as CSV", caption: 'A support agent exports the whole account' },
      { type: 'suggestion', path: ROUTE, startLine: permLine, endLine: permLine, lang: 'ts', after: "  if (!can(req.caller, 'invoices:export')) return res.status(403).json({ error: 'forbidden' });" },
    ],
  }],
  [keys.api, {
    path: CSV, sha: head.api, startLine: isoLine, endLine: isoLine, author: 'as-carol', severity: 'major', confidence: 74,
    title: 'Issue dates shift a day for accounts west of UTC',
    summary: 'Dates are cut from the UTC ISO string, so an invoice issued on Sep 30 at 18:30 in New York exports as Oct 1.',
    category: 'In-stack bug',
    recommendation: 'Fix in export-api: format dates in the account time zone (`Intl.DateTimeFormat` with `timeZone`).',
    blocks: [
      { type: 'table', caption: 'Invoice issued 2026-09-30 18:30 local', columns: ['Account zone', 'Exported', 'Expected'], rows: [
        ['Europe/Paris', { text: '2026-09-30', tone: 'ok' }, '2026-09-30'],
        ['America/New_York', { text: '2026-10-01', tone: 'risk' }, '2026-09-30'],
        ['America/Los_Angeles', { text: '2026-10-01', tone: 'risk' }, '2026-09-30'],
      ] },
      { type: 'text', text: 'The test fixture uses `2026-09-30T22:30:00Z` and expects `2026-09-30`: it passes only because the suite runs in UTC.' },
    ],
  }],
  [keys.api, {
    path: ROUTE, sha: head.api, startLine: loadLine, endLine: loadLine + 1, author: 'as-carol', severity: 'minor', confidence: 68,
    title: 'Whole export held in memory for large accounts',
    summary: 'The biggest account has ~210k invoices: `findInvoices` then `toCsv` holds about 180 MB per request.',
    category: 'Performance',
    recommendation: 'Follow-up: stream rows with the cursor helper of the payouts export.',
    blocks: [
      { type: 'callout', tone: 'note', title: 'Not blocking', text: 'Behind a flag for the finance beta; the largest beta account has 4k invoices.' },
      { type: 'code', path: ROUTE, line: loadLine, lang: 'ts', code: 'const invoices = await findInvoices({ accountId: req.caller.accountId, from, to });\nconst csv = toCsv(invoices);' },
    ],
  }],
  [keys.api, {
    path: TEST, sha: head.api, startLine: describeLine, endLine: describeLine, author: 'as-alice', severity: 'minor', confidence: 85,
    title: 'No test for the refused export',
    summary: 'The suite covers the CSV shape only; nothing checks that a caller without the permission gets a 403.',
    category: 'Test gap',
    recommendation: 'Add a route test: a caller without `invoices:export` gets 403 and no body.',
    blocks: [{ type: 'steps', title: 'Missing case', items: ['Caller with `invoices:read` only', '`GET /invoices/export.csv`'], outcome: 'Expect `403`, no `Content-Disposition` header' }],
  }],
  [keys.api, {
    path: ROUTE, sha: head.api, startLine: fileLine, endLine: fileLine, author: 'opus-review', severity: 'nit', confidence: 60,
    title: 'File name uses epoch milliseconds',
    summary: '`invoices-1760000000000.csv` tells finance nothing; the date range does.',
    category: 'Copy',
    recommendation: 'Name it `invoices-<from>-to-<to>.csv`.',
    blocks: [{ type: 'text', text: 'Finance keeps one file per month: a readable name sorts them in the Downloads folder.' }],
  }],
  [keys.ui, {
    path: BTN, sha: head.ui, startLine: clickLine, endLine: clickLine + 2, author: 'as-bob', severity: 'major', confidence: 90,
    title: 'Double click downloads the export twice',
    summary: 'The button stays enabled while the request runs: two fast clicks start two exports and save two files.',
    category: 'In-stack bug (UX)',
    recommendation: 'Fix in export-ui: expose `pending` from `useExport` and disable the button while it is true.',
    blocks: [
      { type: 'steps', title: 'Repro', items: ['Open Invoices with a 12-month range', 'Click **Export CSV** twice quickly'], outcome: 'Two `invoices.csv` files land in Downloads' },
      { type: 'suggestion', path: BTN, startLine: clickLine, endLine: clickLine + 2, lang: 'tsx', after: '      <button type="button" disabled={pending} onClick={() => exportCsv({ from, to })}>\n        {pending ? \'Exporting…\' : \'Export CSV\'}\n      </button>' },
    ],
  }],
  [keys.ui, {
    path: HOOK, sha: head.ui, startLine: errLine, endLine: errLine, author: 'as-bob', severity: 'nit', confidence: 80,
    title: 'Export error does not say what to do',
    summary: '"Export failed. Try again in a minute." also shows on a 403, where waiting will not help.',
    category: 'Copy',
    recommendation: 'On 403 say "Ask an admin for the Export invoices permission."',
    blocks: [{ type: 'table', columns: ['Status', 'Message today', 'Proposed'], rows: [['403', { text: 'Try again in a minute', tone: 'warn' }, 'Ask an admin for the Export invoices permission'], ['5xx', 'Try again in a minute', 'Try again in a minute']] }],
  }],
  [keys.toggle, {
    path: FLAGS, sha: head.toggle, startLine: flagLine, endLine: flagLine, author: 'opus-review', severity: 'minor', confidence: 82,
    title: 'invoiceCsvExport ships on by default',
    summary: 'The flag default is `true`, so every account gets the button at deploy, against decision D2 (finance beta first).',
    category: 'Rule violation',
    recommendation: 'Fix in export-toggle: `default: false`.',
    blocks: [
      { type: 'callout', tone: 'warn', title: 'Settled in D2', text: 'Behind a flag, off by default.' },
      { type: 'suggestion', path: FLAGS, startLine: flagLine, endLine: flagLine, lang: 'ts', after: "  invoiceCsvExport: { default: false, description: 'Export invoices as CSV from the invoices page' }," },
    ],
  }],
];

const posted = [];
for (const [n, f] of findings) posted.push({ n, ...(await api('POST', `/api/works/${SLUG}/prs/${n}/comments`, { side: 'head', ...f })) });

// coco review plan on export-api, with two watch points
const files = git('diff', '--name-only', `main...export-api`).split('\n').filter(Boolean).map((filename) => ({ filename }));
const mergeBase = git('merge-base', 'main', 'export-api').trim();
const plan = normalizePlan({
  summary: 'Finance admins get a CSV of the invoices list. Read the endpoint first (who can call it, what it loads), then the serializer (what lands in each cell).',
  surface: [
    { area: 'Export endpoint', entryPoints: 'GET /invoices/export.csv', risk: 'high', note: 'New read path over every invoice of an account.' },
    { area: 'CSV serializer', entryPoints: 'toCsv, invoiceToRow', risk: 'medium', note: 'User-controlled text written to a file opened in Excel.' },
  ],
  personas: ['alice', 'carol'],
  steps: [
    { title: 'Who can export, and what is loaded', why: 'The permission and the query bound the blast radius.', files: [{ path: ROUTE, focus: 'Permission name, date parsing, unbounded load.' }] },
    { title: 'What lands in each cell', why: 'Cells come from customer-controlled names.', files: [{ path: CSV, focus: 'Escaping, money formatting, dates.' }] },
    { title: 'What the tests pin', why: 'Refusal path and edge cases.', files: [{ path: TEST, focus: 'Missing 403 case; UTC-only dates.' }] },
  ],
  skim: [],
  watchPoints: [
    { path: ROUTE, startLine: permLine, endLine: permLine, body: 'The route checks `invoices:read`; `invoices:export` exists in `src/auth/permissions.ts` and is never used.', severity: 'major', confidence: 80 },
    { path: CSV, startLine: escapeStart + 1, endLine: escapeStart + 1, body: 'Cells starting with `=` are not neutralized: CSV injection when opened in a spreadsheet.', severity: 'major', confidence: 70 },
  ],
}, files, {}, {});
const reviews = path.join(DATA, 'works', SLUG, 'reviews');
fs.mkdirSync(reviews, { recursive: true });
fs.writeFileSync(path.join(reviews, 'pr-b~export-api-plan.json'), JSON.stringify({
  run: { status: 'done', startedAt: ts('2026-10-09T15:00:00+02:00'), finishedAt: ts('2026-10-09T15:02:10+02:00'), headSha: head.api, error: '', cost: 0.42, progress: [] },
  plan: { ...plan, headSha: head.api, mergeBase, createdAt: ts('2026-10-09T15:02:10+02:00') },
  ticks: {}, watch: {},
}, null, 1));

// a finished thread on the CSV injection finding
const inj = posted.find((p) => p.title?.startsWith('Customer names'));
const threadKey = `c.b~export-api.${inj.id}`;
const threads = path.join(DATA, 'works', SLUG, 'threads');
fs.mkdirSync(threads, { recursive: true });
const replyBlocks = [
  { type: 'text', text: 'A leading `\'` covers `=`, `+`, `-` and `@`. Tab and CR matter too: Excel strips them and then reads the `=` behind.' },
  { type: 'table', caption: 'Checked against the fixtures', columns: ['Cell', 'Before', 'After'], rows: [
    ['`=1+1`', { text: '2', tone: 'risk' }, { text: "'=1+1", tone: 'ok' }],
    ['`\\t=1+1`', { text: '2', tone: 'risk' }, { text: "'\\t=1+1", tone: 'ok' }],
    ['`-42.00` (credit note)', '-42', { text: "'-42.00", tone: 'warn' }],
  ] },
  { type: 'callout', tone: 'warn', title: 'Trade-off', text: 'Amounts are written by `formatCents`, never by a customer: skip the prefix on the **total** column so credit notes stay numbers.' },
  { type: 'suggestion', path: CSV, startLine: escapeStart, endLine: escapeStart + 3, lang: 'ts', after: "const escapeCell = (raw: string, numeric = false) => {\n  const value = !numeric && /^[=+\\-@\\t\\r]/.test(raw) ? `'${raw}` : raw;\n  if (/[\",\\n]/.test(value)) return `\"${value.replaceAll('\"', '\"\"')}\"`;\n  return value;\n};" },
];
const lines = git('show', `${head.api}:${CSV}`).split('\n');
for (const b of replyBlocks.filter((x) => x.type === 'suggestion')) b.before = lines.slice(b.startLine - 1, b.endLine).join('\n');
const { blocksToMarkdown } = await import(path.join(APP, 'server/blocks.mjs'));
fs.writeFileSync(path.join(threads, `${threadKey}.json`), JSON.stringify({
  key: threadKey, groupId: null, waiting: null,
  messages: [
    { id: 'a1b2c3d4', role: 'user', text: 'Is a leading apostrophe enough? What about tabs, CR, and negative amounts?', ts: ts('2026-10-09T15:10:00+02:00'), model: 'sonnet' },
    { id: 'e5f6a7b8', role: 'agent', text: blocksToMarkdown({ blocks: replyBlocks }), blocks: replyBlocks, ts: ts('2026-10-09T15:11:30+02:00') },
  ],
}, null, 1));

// checklist: export-api self review and manual test done
for (const g of ['self-review', 'manual-test']) await api('POST', `/api/works/${SLUG}/gates/${keys.api}/${g}`, { action: 'done' });

console.log(JSON.stringify({ slug: SLUG, posted: posted.map((p) => `${p.n} ${p.id} ${p.severity} ${p.title}`), threadKey }, null, 1));
