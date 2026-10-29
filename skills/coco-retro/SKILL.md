---
name: coco-retro
description: "Self-improvement round for cocopilot: read the owner's recent conversations with coco agents, spot friction (corrections, repeats, workarounds, dismissed cards, going back to another tool), rank it with evidence, then ship the picked fixes straight to coco's main. Use when the owner says \"retro\", \"self-improvement round\", \"what annoyed me today\", \"evaluate our last conversations\", or asks why they still leave coco for something."
argument-hint: "[since: 2026-10-28 | 1d | last]"
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, Agent, mcp__cocopilot__list_works, mcp__cocopilot__get_work, mcp__cocopilot__propose_work_scaffold, mcp__cocopilot__propose_stack_edit, mcp__cocopilot__mark_row_landed, mcp__cocopilot__set_next, mcp__cocopilot__propose_rules, mcp__cocopilot__screenshot, mcp__cocopilot__post_blocks, mcp__cocopilot__ask
---

# coco-retro

One round: **find** friction in the owner's recent use of coco, **rank** it with
evidence, let the owner **pick**, **ship** the picks to coco's `main`, **report**.
coco is `${COCO_URL:-http://127.0.0.1:8777}`; its checkout is the app repo (`GET /api/server` names the running sha).

Arguments: `$ARGUMENTS` is the window. `last` (default) starts where the previous
round ended: the `retro` line in the `## Rounds` notes of the newest retro work.
Without a previous round, take 1 day.

## 1. Gather (read only)

Collect the owner's own words and coco's signals inside the window. Delegate the
transcript sweep to a sub-agent when it spans more than a few sessions; keep
only quotes, times and agent ids.

- **Claude sessions**: `~/.claude/projects/*/*.jsonl` modified in the window.
  Owner messages are `type: "user"` lines whose content is text, not a tool
  result. Skip lines inside `<system-reminder>`, hook output and pasted blocks.
- **Paseo agents** (other providers): `paseo ls -a --json`, then
  `paseo logs <id> --since <window start> --json` for agents updated in the window.
- **Cards**: `<data>/cards/*.json` (`COCO_DATA`, default `~/.cocopilot/data`):
  answered with free text in Other, dismissed, or left open after the agent ended.
- **UI usage**: `<data>/ui-events.jsonl`, one line per event: `view` (`hash`, `ms` spent
  there while the window showed) and `click` (`hash`, `label`, `cls`). Look for views
  left within seconds, tabs never opened, the same click repeated in a row (nothing
  happened), long dwell before a card answer, back-and-forth between two views.
- **Errors**: `<data>/client-errors.log`, failures in `<data>/server-restart.log`.
- **Flagged**: findings raised with `flag_coco_issue` on the coco work, still open.
- **What changed**: `git log --since=<window start>` in the app repo, to mark
  friction already fixed during the window.

## 2. Spot friction

A friction is a moment where coco cost the owner time or trust. Signals, strongest first:

1. The owner left coco to do it elsewhere (another app, a terminal, the Paseo app).
2. The owner corrected an agent ("no", "again", "I said", "we fixed that", "still").
3. The same ask repeated across sessions, or the same fix landed in several rounds.
4. The owner pasted a screenshot of coco to explain a problem.
5. A card answered in Other because no option fitted, or dismissed.
6. An agent ended half done, an error, a restart that lost state.
7. A question about where something is ("where are…", "how do I…").
8. A UI pattern in `ui-events.jsonl`: repeated clicks, bounces, a view hopped through to reach another.

Group signals by cause, not by message. Drop anything already fixed on `main`
(name the sha) and anything listed under **Do not revisit** in the coco works' notes.

## 3. Rank and show

Post one `post_blocks` card: a table `# | Friction | Evidence (quote, time) | Cost | State`,
most costly first, eight rows at most. Cost = how often × how much it blocked.
Then an `ask` card of kind `rows`: one row per friction, the fix in one line,
the recommended ones pre-ticked. Stated rules ("always…", "never…") go to
`propose_rules` instead of the table.

## 4. Plan the picks

Create the round's work with `propose_work_scaffold`: slug `coco-retro-<date>`,
parent the main coco work, tier `stack`, one planned row per pick (branch
`retro/<short-name>`), the friction table in the description, and in notes a
`## Rounds` line: `retro <window start> → <window end>`.

## 5. Ship

For each row, in order, once the owner approved the work:

- Build on `main` (or a worktree merged back fast-forward). Follow the repo's
  rules files and the style of the code around the change.
- Tests and typecheck green, then commit in the repo's message style.
- `POST /api/server/restart`, wait until `GET /api/server` shows the new sha,
  then `screenshot` the page the fix touches and look at it.
- `mark_row_landed` on the row with the commit.

Every three or four rows: run the whole test suite and screenshot the main
pages (Waiting, Agents, a work's Overview and Review) for layout regressions.
Never push to a public remote: pushing is the owner's call.

## 6. Report

`set_next` on the round's work: what to try, what was not tried live, what
waits on the owner (push, rebuild an app). Close the `## Rounds` line with the
end sha. Reply with the shipped rows and their shas, nothing else.
