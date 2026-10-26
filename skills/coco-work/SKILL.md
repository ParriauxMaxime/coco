---
name: coco-work
description: "Work inside a cocopilot work: find the work and PR row the current worktree belongs to, read its brief, decisions and rules, build on the PR branch, report findings and decisions back to cocopilot. Use when a task mentions a cocopilot work, when a brief was written by cocopilot, or when the worktree's branch is a row of a work."
argument-hint: "[PR number or branch]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, mcp__cocopilot__get_work, mcp__cocopilot__upsert_finding, mcp__cocopilot__upsert_decision, mcp__cocopilot__attach_media, mcp__cocopilot__import_artifact
---

# coco-work

cocopilot (`${COCO_URL:-http://127.0.0.1:8777}`) keeps the long-term context
of a feature shipped as one PR or a stack of PRs: the stack plan, decisions,
rules, review comments and findings. You are one agent on one row of that
stack. The user decides; you build and report.

Inside a coco agent the `cocopilot` MCP is mounted: read with `get_work`,
write with `upsert_finding`, `upsert_decision`, `attach_media` and
`import_artifact`, which default to your agent's work and row. The curl
below is the fallback for a session without that MCP, with
`COCO=${COCO_URL:-http://127.0.0.1:8777}`.

## 1. Find your work and row

Inside a coco agent your launch prompt names them: skip this.

```bash
COCO=${COCO_URL:-http://127.0.0.1:8777}
curl -s -X POST "$COCO/api/paseo-link/resolve" -H 'Content-Type: application/json' -d "{\"cwd\": \"$PWD\"}"
# → { branch, work: { slug, title, stack: [101, 102] }, pr: { number, comments } | null, runs }
```

- `work: null`: the branch belongs to no work. Say so and work from the
  user's prompt only.
- `pr: null` with a work: your row is a local branch not opened as a PR yet;
  its key is `b:<branch>`.

## 2. Read before you touch code

1. Your brief. When the launch prompt names a file, that file is your full
   task: read it end to end. Otherwise fetch the rendered one:
   `curl -s "$COCO/api/works/<slug>/briefs/<n>"`.
2. The work: `cocopilot.get_work` (or `curl -s "$COCO/api/works/<slug>"`) gives the stack, links,
   notes and decisions. In the notes, `## Decisions taken`, `## Do not
   revisit` and `## Rules` are settled: follow them, never reopen them.
3. The repo's own instructions (`AGENTS.md`, `CLAUDE.md`, any rules folder
   they point to), then the precedents the brief names: same design, same
   tests, same commit granularity. A source the brief marks forbidden is
   never read for code.
4. Your siblings: other rows of the stack belong to other agents. Touch only
   the files your row owns; list expected conflicts in your report.

## 3. Build

- Commit locally on your branch, small commits that each make sense.
- Run the repo's gates (type check, lint, format, tests) and quote their
  output in the report: "N passing, M failing (why)". Never claim a gate
  passed without running it.
- Tests: list the candidate behaviors (behavior + the bug it would catch)
  and ask which to keep before writing them.
- Comments rare, one line, only for the why the code cannot say.

## 4. Never

- `git push`, force-push, `gh pr create|edit|ready|comment|review`: the
  user pushes. cocopilot records the remote head before a run and flags
  any move it did not see coming.
- Pinging people, posting to Slack, Notion or GitHub.
- Reopening a decision the work already took. Disagree in the report, as a
  question.
- Scope creep: list what you found; the user picks what gets built.

## 5. Report back to cocopilot

- Review findings (yours or a reviewer's you were asked to run): post them
  with the `coco-findings` skill, one finding per issue.
- An open product or tech question: write it as a decision card instead of
  asking in chat, so the user answers it on the Decisions tab. Its evidence
  goes in `summary` + `blocks` + `sources`, the same typed blocks as a
  finding (see "Blocks" in the `coco-findings` skill), never a markdown
  `details` wall. Inside a coco agent call `cocopilot.upsert_decision` with
  `id` plus the body below (work and `pr` default to your agent's); without
  that MCP, curl it:

  ```bash
  curl -s -X PUT "$COCO/api/works/<slug>/decisions/<id>" \
    -H 'Content-Type: application/json' --data @- <<'JSON'
  {
    "title": "D1 · Export CSV · Scope",
    "question": "What does Export CSV download?",
    "summary": "The invoices page shows a date range and a status filter; the export ignores both.",
    "blocks": [{ "type": "table", "columns": ["Filter", "Page", "Export"], "rows": [["Date range", "applied", { "text": "ignored", "tone": "risk" }]] }],
    "options": [
      { "key": "view", "label": "What the page shows" },
      { "key": "all", "label": "Every invoice of the account" }
    ],
    "recommended": "view",
    "confidence": 70,
    "pr": "101"
  }
  JSON
  ```

  Leave `status`, `choice`, `rationale` and `decidedAt` out: they are the
  user's.
- Kit files (PR body draft, diagram, demo clip): import them as artifacts
  so the kit line turns fresh (the file must sit under one of the
  configured `importRoots`, a worktree or `/tmp` by default):
  `cocopilot.import_artifact` with `{ path, pr, kind }`, or
  `curl -s -X POST "$COCO/api/works/<slug>/artifacts" -H 'Content-Type: application/json' -d '{"path": "<abs path>", "pr": <n>, "kind": "body"}'`.
- A run brief that asks for a result file
  (`reviews/pr-<n>-run-<id>-result.json`): write
  `[{ "id", "status": "fixed" | "declined", "commit", "note" }]` before you
  stop, and add `Cc-Comment: <id>` trailers to the fixing commits.

## 6. Final message

Short, in this order:

- Commits: sha + one line each.
- `git diff --shortstat origin/<base>`.
- Gate results, quoted.
- Deviations from the brief, with why.
- Open questions, each as yes/no + recommendation + tradeoff (and the
  decision card id when you wrote one).
- Next steps the user can pick from.
