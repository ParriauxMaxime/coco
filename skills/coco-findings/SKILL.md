---
name: coco-findings
description: "Report code-review findings to cocopilot's Findings board, one structured finding per issue (title, severity, confidence, location, body). Use at the end of any review of a PR that belongs to a cocopilot work: a persona review, a local review, an audit, a second opinion, a stack review."
argument-hint: "[PR number] [reviewer id]"
allowed-tools: Bash, Read
---

# coco-findings

cocopilot (`${COCO_URL:-http://127.0.0.1:8777}`) lists every finding on a PR in
one board. A finding posted here lands there with its claim, severity and
confidence, and the user triages it: accept, dismiss with a reason, or
dispatch to an agent.

All commands below use `COCO=${COCO_URL:-http://127.0.0.1:8777}`.

## 1. Resolve the work and the head

```bash
COCO=${COCO_URL:-http://127.0.0.1:8777}
curl -s -X POST "$COCO/api/paseo-link/resolve" -H 'Content-Type: application/json' -d "{\"cwd\": \"$PWD\"}"
# → { work: { slug, stack: [101, 102, …] }, … }   work null: not a cocopilot work, stop and say so
curl -s "$COCO/api/code/pr/<n>/refs?fresh=1"
# → { headSha, … }   anchor every finding on this sha
```

A local row without a PR number uses the key `b:<branch>` instead of `<n>`.
Post each finding on the PR whose diff contains its file; in a stack, that is
the highest PR touching the file.

## 2. One finding per issue

| Field | Rule |
| --- | --- |
| `title` | The row label: max ~70 chars (server refuses over 100), subject + what breaks. "Customer names starting with = run as formulas in Excel". Not the category ("Test gap"), not the fix, no explanation. |
| `summary` | The full one-sentence claim the title shortens, max 400 chars: what breaks, for whom, through which call. Shown as the lede. |
| `severity` | `blocking` (security, data loss, broken prod path) · `major` (wrong behavior a user hits) · `minor` (edge case, test gap, consistency) · `nit` (naming, copy, docs). |
| `confidence` | Integer 0-100: how sure the defect is real. 90+ reproduced or traced end to end; 70-89 read the full path; 50-69 likely, one link unchecked; below 50 a question, not a finding. |
| `path`, `startLine`, `endLine` | Repo-relative file and line range at `headSha`, on the line that holds the defect. |
| `author` | The reviewer id: `as-<login>` for a persona review (shown as a persona), else the agent name (`opus-review`, `opus-audit`, `review-local`). |
| `category` | Short class, max 80 chars: `In-stack bug`, `Existing bug on main (security)`, `Test gap`, `Product call`, `Rule violation`, `Copy`. |
| `recommendation` | The fix in one sentence, max 600 chars, inline markup allowed. "Fix in #102: …", "Decide (you, with the product owner): …", "You pick (AGENTS.md): …". |
| `blocks` | The evidence, as typed blocks (below). Never a wall of text. |
| `sources` | `[{ "label": "#101 reviewer H1", "path": ".claude/reviews/….md" }]`, or `url` for an https link. |

Never send `body` with `blocks`: the server writes the markdown twin that fix
agents and threads read.

### Blocks

Pick the block that carries the evidence best; a finding is usually 2-4
blocks. Inline text everywhere supports `**bold**`, `*italic*`, `` `code` ``,
`path/file.ts:123` refs (clickable), and tone marks
`<risk>…</risk>` `<warn>…</warn>` `<ok>…</ok>` `<note>…</note>`
`<mute>…</mute>`. Mark the one phrase that matters, not whole sentences.

| Block | Use for | Shape |
| --- | --- | --- |
| `text` | 1-3 sentences of context. Split long prose into steps or a table. | `{ "type": "text", "text": "…" }` |
| `steps` | The path from input to wrong outcome; repro steps. | `{ "type": "steps", "title": "Repro", "items": ["…", "…"], "outcome": "…" }` |
| `table` | Permutations: role × action × result, before/after per surface, truth tables. Sortable. | `{ "type": "table", "caption": "…", "columns": ["Role", "List", "Export"], "rows": [["support", { "text": "allowed", "tone": "ok" }, { "text": "allowed", "tone": "risk" }]] }` |
| `suggestion` | A local fix, max ~15 lines. The server reads `before` at the sha. | `{ "type": "suggestion", "path": "…", "startLine": 235, "endLine": 237, "lang": "ts", "after": "…" }` |
| `code` | An excerpt the reader needs and the anchor does not show (another file, a caller). | `{ "type": "code", "path": "…", "line": 12, "lang": "ts", "code": "…" }` |
| `diagram` | Several actors or calls in order (client, API, hook, DB). Mermaid. | `{ "type": "diagram", "mermaid": "sequenceDiagram\n…", "caption": "…" }` |
| `callout` | One thing the reader must not miss: a decision already taken, a counter-argument, a scope note. | `{ "type": "callout", "tone": "warn", "title": "Settled", "text": "…" }` |
| `media` | A UI finding: screenshot or short clip of the local app. Upload first (below). | `{ "type": "media", "kind": "image", "src": "/api/works/<slug>/media/<file>", "caption": "…" }` |

Media upload (raw bytes; `image/png|jpeg|webp|gif`, `video/mp4|webm`, max
50 MB) returns the `src` to use:

```bash
curl -s -X POST "$COCO/api/works/<slug>/media" -H 'Content-Type: image/png' --data-binary @shot.png
# → { "src": "/api/works/<slug>/media/3f2a….png" }
```

Two reviewers on the same lines is fine: the board folds findings on the same
spot into one row. Never merge two defects into one finding to save rows.
Never post praise, a summary or a verdict as a finding.

## 3. Post

```bash
curl -s -X POST "$COCO/api/works/<slug>/prs/<n>/comments" \
  -H 'Content-Type: application/json' -d @finding.json
```

```json
{
  "path": "src/invoices/csv-export.ts",
  "side": "head",
  "sha": "<headSha>",
  "startLine": 12,
  "endLine": 15,
  "author": "opus-review",
  "severity": "blocking",
  "confidence": 85,
  "title": "Customer names starting with = run as formulas in Excel",
  "summary": "A customer named `=HYPERLINK(...)` lands in the CSV as is: Excel evaluates it when finance opens the export.",
  "category": "In-stack bug (security)",
  "recommendation": "Fix in #101 before #102 merges: prefix cells starting with `=`, `+`, `-` or `@` with a `'`.",
  "blocks": [
    {
      "type": "steps",
      "title": "Path",
      "items": [
        "A customer signs up as `=HYPERLINK(\"https://evil.example\",\"Refund\")`",
        "`invoiceToRow` copies `customerName` untouched",
        "`escapeCell` only quotes `\"`, `,` and newlines"
      ],
      "outcome": "<risk>Formula runs</risk> on the finance laptop that opens the export"
    },
    {
      "type": "suggestion",
      "path": "src/invoices/csv-export.ts",
      "startLine": 13,
      "endLine": 13,
      "lang": "ts",
      "after": "const value = /^[=+\\-@]/.test(raw) ? `'${raw}` : raw;"
    }
  ],
  "sources": [{ "label": "#101 reviewer H1", "path": ".claude/reviews/2026-10-09-invoice-csv-export-101.md" }]
}
```

A 400 names the bad field (`blocks[2].rows[1] must hold 3 cells`, a line
range outside the file at that sha): fix it and post again. Do not post the
same finding twice; check `GET …/prs/<n>/comments` first when re-running a
review, and update an existing one with `PUT …/prs/<n>/comments/<id>` (any of
`title`, `severity`, `confidence`, `category`, `recommendation`, `blocks`,
`sources`).

## 4. Review page (optional)

When the review also writes `.claude/reviews/<date>-<work>-<pr>.md`, give each
finding a `### N. <same title>` heading with its `` `path:line` `` and
`Severity:` / `Confidence: N%` lines. The board matches the page entry to the
posted finding by file and title, so it appears once.

## 5. Report

End with one line per finding posted:
`#<n> <severity> <confidence>% <path>:<line> <title>`, then the board link:
`$COCO/#/work/<slug>/findings-<n>`.
