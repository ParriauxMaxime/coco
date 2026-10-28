# cocopilot guide

The full reference: every surface, what it reads and writes, and the HTTP
routes agents call. Start with the [README](../README.md) to install, and
[configuration.md](configuration.md) for the keys named below
(`repo.path`, `dataDir`, `personasDir`, …).

cocopilot drives the reviewer personas, the works (long-term context per PR
stack) and the local Paseo agents. Node + Vite + React front, Node stdlib API
server over the file system, `git`, `gh` and the `paseo` CLI. Single user,
local.

In this guide, "the repo" is `repo.path`, "the default branch" is
`repo.defaultBranch`, and `data/…` paths live in `dataDir`
(`~/.cocopilot/data` by default).

## Run

```bash
npm ci
npm start                              # build, then serve on 127.0.0.1:8777
node server/index.ts 8777 127.0.0.1   # serve an existing build; port and bind are optional
```

No authentication. Keep the default `127.0.0.1` bind: on any other address
the app serves your repo and starts agents for anyone who can reach the port.

Dev loop: `npm run serve` in one shell, `npm run dev` in another (Vite on
8778 proxies `/api`).

### Setup checklist (first install and updates)

Until the setup is complete, the Dashboard shows a checklist: config file,
repository, `gh` login, Paseo plugin (installed from this checkout and
enabled), skills, skills matching this version (optional), personas
(optional) and a first work. Ticks are derived on each load, never stored;
each open step shows its command to copy. "Ask an agent to finish the
setup" starts a Paseo agent in auto mode in the app folder on
[setup.md](setup.md), which handles a fresh install and an update alike.
When the config file changed after the server started, the card asks for a
restart. "Hide" covers the steps open at that moment (`cc.onboarded` in
this browser); a step that opens later, after an update, shows the card
again.

Routes: `GET /api/setup` (steps, `done`, `restart`), `POST /api/setup/agent`.

## What it reads and writes

- Personas: `personasDir/*.md|json` (read, inline edit with a `.bak` copy).
- Skills: `skillsDir/*/SKILL.md` and sibling `.md` (read, inline edit).
- Agents and workspaces: `paseo ls --json`, `paseo workspace ls --json`,
  `paseo logs <id>`.
- Rituals: `paseo run -d --mode auto --cwd <repo> "<prompt>"`, one per
  configured ritual; history in `data/rituals.jsonl`.
- Feedback: `data/feedback.jsonl`.
- Reviews: `<repo>/<repo.reviewsDir>/`.
- Git refs: `refs/cocopilot/head/<n>` and `refs/cocopilot/base/<n>` in the
  repo (fetched from `pull/<n>/head` and the PR base, the head moved to the
  local branch tip when that holds unpushed commits; dropped when the work
  is archived). Code is read with `git show`, `git ls-tree`, `git diff` and
  `git grep` on those shas, never from the working tree.
- Review comments: `data/works/<slug>/comments/` (one file per PR).
- Review runs and briefs: `data/works/<slug>/reviews/` (`pr-<n>-run-<id>.md`
  brief, `pr-<n>-run-<id>.json` run record, `pr-<n>-run-<id>-result.json`
  written by the agent).

Nothing here pushes, posts or sends; a ritual starts an agent that follows
the same rule. Review comments never leave the laptop: they go to an agent
brief, never to GitHub. An agent thread on a comment talks to the agent of
the PR branch, which makes local commits there; it never pushes.

## Works (long-term context)

A work ties a Paseo project to what Paseo forgets: the PR stack (live state,
CI, review decision via `gh`), Notion and GitHub links, the personas owning
the touched surfaces (suggested from the stack's files), markdown notes
(rules, do-not-revisit), a timeline, and artifacts copied from `/tmp` or a
worktree (`.claude/reviews/*`, PR review pages, briefs, demo clips) so they
outlive the scratch folders. Stored under `data/works/<slug>.json` and
`data/works/<slug>/artifacts/`, served at `/works/<slug>/artifacts/…`.

### What's next

A work can carry `next`: the owner's to-do as of now, written by the
orchestrating agent at the end of each cycle and shown as the first card
under the Plan hero. The cocopilot MCP `set_next`, or `PUT /api/works/<slug>` with
`{ next: { summary, blocks, by } }`: `summary` is one plain sentence,
`blocks` the typed blocks of findings and decision cards (a `steps` block
for the actions in order, a `callout` for a blocker, a `table` for PRs to
review), `by` who wrote it. The server stamps `at`. `{ next: null }` clears
it. It names what the owner does (review, merge, answer, push), not what
agents are doing: the stack's own "Next" line in the hero already says
which PR is first in line.

### Decisions

A work can carry `decisions[]`: `{ id, title, question, details,
confidence, options: [{ key, label, details, confidence }], recommended,
positions: { <who>: <markdown> }, source, pr, status: pending | taken,
choice, rationale, decidedAt }`. `pr` (optional) is the stack row key the
card belongs to (`101`, or `b:<branch>` for a local row) and lets a PR's
review feed keep only its cards. `confidence` (0-100, optional) is how sure
the author is: on the card, of the recommendation; on an option, that it is
the right call; on a row of a `rows` card, of its recommended pick. It shows
as a "NN% sure" chip (green from 75, orange from 50, red under). Agents
should fill it: a low score tells you where to look hardest.

The `Decisions` view (sidebar, or beside the Overview) works like the
Findings board: filters Open, Taken, All and Archived with their counts, a
PR strip (Whole work or one PR) once they span several, and the list
grouped by PR, each row with its title, question, the recommended option
(or the one taken), its "NN% sure" and whether its thread waits on you.
`J` and `K` move. The selected decision opens on the right: its question,
the evidence (blocks and sources, folded once taken), the reviewers'
positions, then the options picked with the same picker as agent cards
(recommended and "NN% sure" chips, folded details) or the `rows` table with
one pick per row, the rationale box, Take decision or Reopen, Archive or
Unarchive, and its thread with the thread agent's cards. "Copy taken as
markdown" sits in the header. An Overview open decision opens it there, and
the PR inspector lists the PR's decisions (its count opens the view filtered
to that PR). The Review tab's activity feed (in the inspector, or its own
pane) shows the same detail inline.

`title`, `question` and option `label` stay short plain text: they are the
scannable view. The explanation goes in the card, not in the Plan
description: `details` (the context and the why), option `details` (what
that option means, its code, its tradeoff), `positions` values and the
`rationale` are markdown, rendered like the Plan (tables, code blocks,
mermaid). The recommended option of an open decision shows its details, the
others behind "details".

A card with `rows: [{ key, label, details, recommended: <option key> }]` is a
table of sub-decisions, one pick per row, the card `options` as columns
(e.g. which tests to write: options Write / Skip, one row per candidate
test). Its `choice` is `{ <row key>: <option key> }`, every row required;
the notes bullet lists one sub-bullet per row. Use it instead of a markdown
table the user has to answer in chat.

```json
{
  "id": "t1-tests", "title": "T1 · Tests", "question": "Which tests do we write?",
  "options": [{ "key": "write", "label": "Write" }, { "key": "skip", "label": "Skip" }],
  "rows": [
    { "key": "bullet", "label": "Multi-line rationale bullet", "details": "Catches a code block breaking out of `## Decisions taken`.", "recommended": "write" },
    { "key": "upsert-new", "label": "Upsert appends a new card", "recommended": "skip" }
  ]
}
```

"Take decision" posts to `POST /api/works/<slug>/decisions` (`{ id, choice,
rationale }`), which stores the choice, appends a bullet under `## Decisions
taken` in the notes (a multi-line rationale goes indented under it) and a
`decision` timeline entry, so agents reading `get_work` see it at once.
"Reopen" (`{ id, status: 'pending' }`) clears the choice; the notes bullet
stays as history. "Copy taken as markdown" gives the bullets to paste into
PLAN.md. `{ id, archived: true }` archives a card overtaken by later work:
it leaves the counts, the briefs and the review feed, and stays listed under
"archived" (`archived: false` brings it back).

Agents write cards with the cocopilot MCP `upsert_decision` (coco agents) or
`PUT /api/works/<slug>/decisions/<id>`: the body is
merged into the card with that id, or appended as a new `pending` card. Leave
`status`, `choice`, `rationale` and `decidedAt` out so a decision the user
already took stays. `PUT /api/works/<slug>` with the whole `decisions` array
still works, but overwrites a decision taken in between.

A card carries its evidence like a finding does: `summary` (one-sentence
lede), `blocks` (the typed blocks of the `coco-findings` skill: table,
steps, diagram, code, suggestion, media, callout, text) and `sources`. The
server validates them, writes the markdown twin into `details` for agents
and briefs, and reads a suggestion's `before` at the card's `sha`. Findings
are about code at a line; decisions are product or tech choices with
options; both share one block format and one renderer. Option `details`
stay one or two plain sentences.

```bash
curl -s -X PUT http://127.0.0.1:8777/api/works/<slug>/decisions/d3-export-denied \
  -H 'Content-Type: application/json' --data @- <<'JSON'
{
  "title": "D3 · Export CSV · Without the permission",
  "question": "A member without invoices:export opens the invoices page: what do they see?",
  "summary": "Today every member who lists invoices can export them.",
  "blocks": [
    { "type": "table", "caption": "Invoices page", "columns": ["", "Before", "After"], "rows": [["Export CSV button", "shown, works", { "text": "hidden", "tone": "ok" }]] },
    { "type": "diagram", "mermaid": "flowchart LR\n  A[Member opens Invoices] --> B{invoices:export?} -->|no| C[No Export CSV button]" }
  ],
  "options": [
    { "key": "hidden", "label": "Button hidden", "details": "Same as the other admin-only actions." },
    { "key": "disabled", "label": "Button disabled with a tooltip", "details": "Shows the feature exists; tells them to ask an admin." }
  ],
  "recommended": "hidden",
  "positions": { "alice": "Hidden, same as the other admin-only actions (D1)." },
  "source": "PR #102 review"
}
JSON
```

## Code review

Open it from a PR card ("review ▸") or the `review-<n>` tab, laid out like
an editor in three resizable panes. Left: the changed files in suggested
review order (or as a tree), category chips, ticks and comment counts, the
scrolled file highlighted. Center: every file stacked as a lazy Monaco diff
card in hunk view; `j`/`k` step files. Right: the review plan, then one
activity feed of coco's watch points, the PR's comments and the work's
decision cards, latest activity first, filtered by all / open / to review
(an agent working or a suggestion waiting for you); "This PR's decisions"
keeps the cards whose `pr` field is this row key. The header bar carries the
PR chip, title, state and comment counts, the `nav` chip, then Findings,
Expand all, Collapse all and Side by side; on a narrow pane the buttons drop
their labels and the counts hide. Phones and narrow split panes get the panes
folded above the cards. "Open in tab" gives `diff-<n>~<path>`; files outside the diff open
as `file-<n>~<path>`. Monaco is a lazy chunk, desktop only; phones get LiteDiff.
A page refresh brings the center pane back to the file and offset you were reading (kept per work and PR in localStorage), unless you scroll or pick a file first.

The diff base is `git merge-base <baseSha> <headSha>`, so a stacked PR shows
its own slice, like GitHub's three-dot diff, not what the default branch gained since.
Refs, tree, file, diff and search come from `server/code.ts`
(`GET /api/code/pr/<n>/refs|tree|file|diff|search`); the head is re-resolved
from `gh pr view` (60 s cache; `?fresh=1` skips it but shares a lookup
younger than 10 s) and refetched when it moved.

Comments are local, anchored to a line range of a side (`head` or `base`)
with the range text and 3 lines of context each side. Create one by dragging
in the line-number gutter, by selecting lines and pressing `c`, or with the
"+" shown on hover. Statuses: `open`, `sent` (given to an agent), `fixed`,
`declined`, `outdated`. A comment card (sidebar and in-diff zone) carries
↗ jump, ✓ resolve / ✕ decline (↺ reopen once closed), 💬 remark, ✎ edit, 🗑
delete; a remark is kept as the comment's `resolution.note` and sent, with
the verdict, to the work notes under `## Review remarks` and to the timeline
(`PUT …/comments/<id>` with `remark`). When the head or the merge-base moves, comments are
re-anchored: `git diff -U0 -M <old> <new> -- <path>` shifts each range
through the hunks, a range inside a hunk is searched by its snippet near the
mapped line, and no match marks it `outdated` (kept, greyed, old snippet
shown). An outdated comment becomes `open` again if a later head matches it.
Only `open` comments turn `outdated`: `sent`, `fixed` and `declined` keep
their status, since a run settles a sent comment from its result. Stored by
`server/comments.ts` in `data/works/<slug>/comments/`.

### Review plan and reading order

Each changed file gets a category, computed on the server from its path and
diff shape (`server/review-plan.ts`, no LLM): `core` (logic), `refactor`
(renames, formatting only, code moved from removed lines, call-site edits of
3 lines or fewer), `wiring` (registries, config entries, `.d.ts`, index
files, hunks that only touch imports/exports), `tests`, and `other` (docs,
generated files). `fileLayers` in the config replaces the path patterns
behind `wiring`, `other` and the core layers. The reason shows as a tooltip on the card
chip and in the tree. The chips above the tree hide or show a category in
the tree and the cards; hidden cards do not mount Monaco. Jumping to a file
in a hidden category shows that category again.

"Plan this review" starts a Paseo agent (`coco · Plan review …`, on
`models.fast`) in the workspace of the PR's worktree (else the stack's top
worktree, else the repo), archived once the plan is in.
Its prompt carries no diff and no file list: only the PR, the work, the head
and merge-base shas and the git commands to read them (`git diff --name-status`
lists the changed files, then `git diff`, `git show`, `git grep` at the head
sha), plus `github_pr` and `get_work`. The guidance typed for the run, the
rules and the owner personas come from the `get_review_context` tool
(cocopilot MCP). What is already raised comes from `get_pr_findings`: every
finding on the PR with its status, resolution and thread end, plus the watch
points you dismissed (kept across re-plans). The plan never raises one again
unless the code it judged changed, and then names the finding it reopens.
Files the plan leaves out land in skim with their category.
It ends with one `propose_review_plan` call (cocopilot MCP) that returns:

- a summary, product first;
- the review surface, with a risk level per area;
- the owner personas;
- ordered steps, each with a focus note per file;
- a skim list;
- up to 8 watch points, each with a severity (`blocking`, `major`, `minor`,
  `nit`) and a confidence from 0 to 100 that the finding is real.

The server normalizes the plan: each changed file appears once, and files the
plan leaves out go to skim. It is stored with its head sha in
`data/works/<slug>/reviews/pr-<n>-plan.json`. When the head moves, the plan
is flagged "head moved" and "Re-plan" redoes it in full. "💬 ask or re-plan"
opens the plan's thread (`p.<row key>`): **Start agent** asks a scoped agent
about the plan (read-only, through git at the plan's head), **↻ Re-plan with
this** re-runs the plan with the text as guidance (`POST
…/review-plan { guidance }`).

The `plan | tree` toggle reorders the tree and the cards together. In plan
order the tree is flat and grouped by step, then Skim; `j`/`k` follow it.
Before any plan exists, the same mode groups files by category in a
deterministic order: core grouped by feature, in the order of the
`fileLayers.layers` list (by default controller, use-case, service, domain,
repository, client). The focus note of a file shows
under its card header. Watch points appear as dashed "coco suggests" zones in
the diff and in the activity feed, worst and surest first, with their
severity and confidence chips, ↗ jump, ✓ accept (becomes a real open
comment, keeping severity and confidence), ✕ dismiss and "💬 discuss or
dispatch". That box sends the text to a scoped agent (accepting the watch
point as a comment first), or accepts / dismisses with the text as reason. A
reason is saved under a `## Review remarks` heading in the work notes (so
coco and the agents read it through `get_work`) and as a `review` timeline
entry.

"Reviewed" on a card collapses it and ticks the file in the tree and its
step. Ticks are stored per head sha, so a push starts them over. The order
mode and the hidden categories are kept per PR in localStorage.

## Findings board

One Findings view: `Findings` in the sidebar opens the whole work, and
`findings` in the Review bar or Findings in the PR inspector opens
`findings-<n>` ("Findings #n"), the same view with its PR filter preset to
that PR. One list merges every remark on the work (`server/findings.ts`,
`GET /api/works/<slug>/findings`, `?pr=<n>` for one row):

- review pages: the work's `Review*` artifacts, `<repo.reviewsDir>/*.md` of
  the PR worktrees, and the repo's `<repo.reviewsDir>/*.md` naming a stack PR; a
  title "Review as … (`login`)" makes the source `review-as:<login>`, else
  `review-local`. A finding goes to the last row whose diff has its path.
- coco's watch points (review plan), local comments,
- GitHub (read only, cached 120 s): inline review comments and review bodies
  from anyone but the PR author, bot comments (grouped by `botGroups`, e.g.
  Sentry), failed checks of `gh pr checks`.

**Import review…** in the Findings view header lists the review pages above
and turns each finding of the picked one into an open local comment on the
last PR whose diff holds its file (`GET|POST /api/works/<slug>/import-review`).

Buckets Open, Accepted, Resolved and Dismissed with their counts, a PR strip
(All PRs or one), grouped By PR or By severity, worst first. The reviewer
strip lists who raised something by trigger: personas, me, agents, team
(GitHub humans), one per bot group, ci; a click hides a reviewer or a whole
group. CI failures are hidden by default (`cc.fd.hidden`). Each row: a
checkbox and its number, severity, claim, file:line, reviewer, age. Tick rows,
or type "pick 1-3, 5, 7" above the list, for a bulk Accept or Dismiss…; the
header checkbox ticks every row shown. `J` and `K` move, `X` ticks, `A`
accepts, `D` dismisses. Accept turns a finding into an open local comment at
the head (a finding without a file is only marked accepted; an open comment is
marked accepted); Dismiss asks a one-line reason (declines a comment,
dismisses a watch point, otherwise a `## Review remarks` line). The toast
offers Undo. The selected finding opens on the right: chips, title, PR,
file:line (opens the diff), body, Accept / Dismiss… / Reopen / Open on
GitHub, then its agent thread (cards, composer; "Dismiss with this reason"
uses the typed text). A new finding with a file shows the composer with
"Accept & ask agent": it accepts the finding as a comment and starts the
thread with your text. While the group's agent is alive and has seen the thread ("agent live"),
a message goes out as a new turn only (the message, what changed since its
last answer, the reply path), not the whole brief again. Accept or dismiss
releases the finding's thread from its group and prunes the group's agent,
worktree and branch once no item is left; it keeps them while the agent is
answering or a suggested commit is not applied. "prune agent" in a thread
does the same by hand.

"Fix accepted (N)" in the view header opens the stack fix dialog (the rows
bottom-up, one commit per finding or per row, the model) and starts a stack
fix (`POST …/stack-fix` with `select: "accepted"`), then opens its
`stack-<id>` tab; the last run sits beside it as "Stack fix <status>". It is
limited to the open comments whose finding is accepted in `findings.json`;
`select` also takes `{ "<row key>": [comment ids] }`, and no `select` keeps
every open comment. The brief adds each comment's triage: the board note,
your thread messages and the agent's last reply; the agent follows the
outcome agreed there and declines anything needing a GitHub write, with the
drafted text in its note. Sent findings show `sent` until the run settles.
An agent running in a row's worktree refuses the run, except the one that
asked for it (`requestedBy`).

Thread agents reply in typed blocks, not markdown: `{ "blocks": [...] }` to
`threads/<key>-<msg>-reply.json`, rendered like a finding card (a
`suggestion` shows as a diff, its `before` read at the agent's base sha).
The message keeps the markdown twin as `text` for the next prompts' history.
A reply that fails validation still shows, as text, with a system note; an
older `.md` reply path is read as markdown.

On your request only (its prompt says so), a comment's agent may act on
its own finding: `"finding": { "action": "accept" | "dismiss", "reason",
"patch": { title, severity, confidence, summary, recommendation, blocks } }`
in the reply JSON. The patch applies at ingest; accept or dismiss runs right
after the turn through the findings board (ledger, comment status, agent
release), and each step leaves a system note in the thread.

Review agents report through the `coco-findings` skill
(`skills/coco-findings/` in this repo, installed into your skills folder):
coco agents call the cocopilot MCP `upsert_finding` (work, PR and head sha
from the agent's labels; same author, path and title updates) and
`attach_media`, other sessions curl the routes below;
one comment per finding with `title`,
`severity`, `confidence`; author `as-<login>` shows as a persona. A persona
review dispatched from coco gets the review plan's rule in its task: call
`get_pr_findings` before reviewing and never raise again what it lists unless
the code it judged changed. The task also lists the findings already on the PR
(title, place, status: open, fixed, declined…), and `get_pr_findings` returns
resolved and declined ones with their status too. Comments
without a title get their claim from the body, skipping `Class:` /
`Severity:` / `Recommendation:` header lines; a `Confidence: N%` in a body is
read too.

Structured findings: `title` is the short row label (max 100 chars, refused
above); a comment may carry `summary` (the full claim, shown as the lede),
`category` (shown as the class plus one chip per parenthesized qualifier,
security in red), `recommendation`,
`sources` and `blocks` (`server/blocks.ts`, validated on POST/PUT, the error
names the field). Block types: `text`, `callout` (tone), `steps` (+ outcome),
`diagram` (mermaid), `code`, `suggestion` (`before` read at the comment's
sha, never trusted), `table` (sortable, cell tones), `media` (image or video
uploaded to `POST /api/works/<slug>/media`, raw bytes, stored in
`data/works/<slug>/media/`). Inline text: `**bold**`, `*italic*`, `` `code` ``,
code refs, and `<risk|warn|ok|note|mute>` marks; any other tag shows as text.
`src/components/Blocks.tsx` + `blocks.css` render them on the board and in
the diff comment zone. The server keeps `body` as the markdown twin for fix
agents, threads and briefs; a hand edit of `body` drops the blocks.

Loading: the last board of each view is saved to
`data/works/<slug>/findings-cache/<pr|stack>.json`. The tab asks
`?stale=1` first (the saved board at once, "refreshing" in the bar) and the
live one next; both share one refresh, and a decision taken during it keeps
its stale result out of the caches.

`POST …/findings { action: accept | dismiss | reopen, keys, reason, pr }`.
The ledger `data/works/<slug>/findings.json` is keyed by `(source, file,
normalized claim)`: the next run of the same reviewer does not raise a
dismissed finding again (folded, "dismissed on <date>: <reason>"). A CI
failure is keyed per head sha.

## Feature flags to test

A work lists the flags a tester must switch on: `betaFlags: [{ code, why,
prs? }]` (no `prs` = every PR; coco proposes them in a scaffold). With a
`featureFlags.provider` configured (`server/feature-flags.ts` loads it, see
[configuration.md](configuration.md#feature-flag-provider)), the provider
reads what your repo says about each flag and how to switch it on. The PR
card then shows a "test with:" line, orange until the PR body names the
flag, and the PR agent's brief gets a "Feature flags to test" section and a
kit item. Without a provider, no flag line shows.

## PR agent and its brief

"agent ▸" on a PR card opens `brief-<n>`: the Paseo agent sitting in the PR
worktree (if any) and the brief rendered from the work (`server/briefs.ts`;
a section with nothing to say is dropped):
title and description, the row (branch, base, scope, siblings, what merged),
links, precedents (`## Precedents` in the notes and `stack[i].precedents`,
with `git show` / `gh pr view` lines for the shas and PR numbers found),
forbidden sources (`## Forbidden sources`, `stack[i].forbidden`), taken
decisions of the work or this row plus `## Do not revisit`, rules, owner
personas, and the kit expected (`stack[i].kit`, e.g. `{ "video": false }`
for "no demo"; any extra `kitKinds`). All new fields are optional.

- **Save brief** writes `artifacts/briefs/pr-<n>-<date>.md` (listed in
  Artifacts).
- **Start agent with this brief** saves it and starts a Paseo agent (mode
  auto) in the PR worktree, so the same workspace; without a worktree Paseo
  checks the PR or branch out. Prompt: "Read `<file>` and follow it end to
  end; it is your full task brief."
- **Handoff** (an agent sits in the worktree) renders the branch state
  (local tip, remote head, base and fork point, commits since the base,
  uncommitted files, open comments, pending decisions of the PR, the exact
  `rebase --onto` lines, the push left to you) above the brief, stores it
  as `pr-<n>-<date>-handoff.md` and starts the fresh agent in the same
  worktree. The old agent keeps running until archived. "handoff preview"
  shows it first (`GET …/briefs/<n>?handoff=1`).

Routes: `GET /api/works/<slug>/briefs/<n>`, `POST …/briefs/<n>/save|start|handoff`.

## Kit freshness

Each PR card shows a `kit:` line (`server/kit.ts`, `GET
/api/works/<slug>/kit/<n>`): one piece per `kitKinds` entry (body, diagram,
video by default) plus Notion, each fresh (green), stale (orange, the head
moved since it was made), missing, or present (made, head unknown). Hover
shows where it comes from, the head it was made for and the current head.

The kit scope says which pieces the PR needs, and the kit milestone counts
only those. Unscoped, the body alone counts. The review-plan agent scopes
every kind at once through the MCP `set_kit_scope` (`stack[i].kit` and
`stack[i].kitScope { by, why, at }`); a click on a piece flips it, dashed
"+ piece" when out of scope (`POST /api/works/<slug>/kit/<n> { pieces, by,
why }`). Briefs keep naming the pieces of `stack[i].kit` over the defaults.

- An artifact imported with `{ pr, kind: <one of kitKinds> }`
  (`POST /api/works/<slug>/artifacts` or the cocopilot MCP
  `import_artifact`, or the PR and kind pickers in
  Artifacts) records the PR head at import in `artifacts/.meta.json`; the
  latest one of a kind wins and is compared by sha. Briefs ask agents to
  hand their kit files over that way.
- Otherwise the PR body on GitHub stands for body, diagram (a mermaid
  block) and video (a `user-attachments/assets` or `.mp4` link), compared by
  time: the body's `lastEditedAt` against the head commit date (one GraphQL
  call, cached 60 s).
- A custom kind with no imported artifact (a docs companion PR, say): the
  companion PR in the work's links, its `updatedAt`. Notion:
  `work.notion.syncedAt`.

### Drift

The Drift block on the work page (`server/drift.ts`, `GET
/api/works/<slug>/drift`, also `drift` in the work payload and the MCP
`get_drift`) lists what moved on the open PRs, recomputed on read and cached
30 s (`?fresh=1` skips the cache). Each line has one button that you click;
coco starts nothing by itself.

- Unpushed: the local branch is ahead of the PR head on GitHub ("3 local
  commits not pushed"); **Push** runs `git push origin <branch>` (in the
  branch's worktree, else the repo clone) and **Copy push** copies it. The
  output of the repo's pre-push hooks (check-ts, say) shows as is when the
  push fails. A branch that diverged from GitHub is flagged with no button,
  since a force push could drop GitHub's commits; coco never force-pushes.
- A stale kit piece (body, diagram, video, by the freshness rules above)
  starts that kit gate's skill, for example `/lem-pr` for the body.
- A blocked demo beat: importing a video (`kind: video`) reads the
  `<name>.report.json` lem-demo-video writes beside it and keeps its
  `blocked` list on the artifact; each beat of the PR's latest video shows
  what blocked it and the one action that unblocks it.
- The GitHub stack differs: a PR's base is not the row below it (or the
  default branch for the first open row), or an open PR sits on a row's
  branch but is not in the work. **Fix base** runs `gh pr edit <n> --base <b>`
  (**Copy base fix** copies it); the other opens the Stack.
- Two worktrees for a PR: the workspace remembered for a row is not the
  worktree on the PR's head branch (or sits on a stale branch name). Listed
  with no button; the agents run in the remembered workspace and the brief
  names that same directory, so fix it from Worktrees.
- `POST /api/works/<slug>/drift/run { id }` backs Push and Fix base: the
  server recomputes the drift, refuses (409) an item that no longer applies,
  builds the command itself (the page never sends one; a `command` it shows
  is only compared) and runs it. On success it drops the drift and PR caches
  and announces the change, so the item disappears.
- PR title format is not checked: no title convention is configured.

Below them, suggested next steps: "Update PR body" when an imported video
is newer than the body, and "Persona review as <login>" (the row's first
persona) for a pushed head with no `as-<login>` finding, review-pr plan or
ticked review-pr gate at that head. They are computed, not written to
`next`.

## Milestones

Each PR header carries six milestones in order (`server/gates.ts`):
self-reviewed › kit › pushed › ready › approved › merged. A pill each (○ todo,
● running, ✓ done, struck through when skipped); the current one, the first
not done or skipped, is outlined and open with its action. Once a PR-branch
agent committed, a "checks" pill leads the rail with coco's last run of the
repo checks on its commits (✓ passed, ✕ failed, – unavailable; see "Agent
worktrees"). Each is derived:

- self-reviewed: a review ran at the head (a `self-review` or `review-pr`
  skill run that finished there, or an `as-<login>` persona finding at that
  sha) and no finding is open. Its skills (`gateSkills` `self-review`, then
  `review-pr`) run from the chevron of the header's Review code button or the
  milestone, through the review runner (`send` to the agent of the PR
  worktree, else a new agent there); a mid-turn agent is refused. A run shows
  running and settles once the agent is idle, keeping the head it left.
- kit: every piece in the PR's kit scope is fresh or present, and the body
  fits `kitBody`. See "Kit freshness" for the scope. Open, it carries the
  drift's kit buttons for that PR: Update PR body or Redo <piece> for a stale
  piece, Make <piece> for a missing one in scope (a suggested next step when
  a `kit-<piece>` gate skill exists).
- pushed: the local branch tip is GitHub's head, or there is no local branch.
- ready: out of draft. Once self-reviewed, kit and pushed are done or
  skipped, "Mark ready for review" runs `gh pr ready <n>` from the server.
- approved: GitHub approved with no unresolved thread; it opens the Review tab.
- merged: from GitHub.

✓ done, skip… (one-line reason) and ↺ reset work on every milestone; a tick
or a skip wins over what is derived. Stored on `stack[i].gates` (optional).
Under the milestones, two badges: the push badge (see "Drift") and the PR's
own commits on top of its base, orange above 5 and red from 15, with "Tidy
history" (the `history` gate skill) above 5. The Stack view shows each row's
current milestone, and the sidebar bar colors open PRs by it once the Stack
view computed them. Routes: `GET /api/works/<slug>/gates` (each row's current
milestone), `GET /api/works/<slug>/gates/<n>`, `POST …/gates/<n>/<milestone>
{ action: run | ready | done | skipped | todo, skill, args, reason }`.

## Stack keeper

When a stack PR merges while the next row is still open, the sidebar shows
a `restack` chip on the work (from the last GitHub snapshot, no gh call) and
the overview a "Restack needed" chip that opens the Stack view. There,
**Restack…** in the header opens the keeper (`server/stack-keeper.ts`,
`GET /api/works/<slug>/stack-keeper`). The dry run lists, bottom-up, each
open child with its tip and the exact lines: `git fetch origin <default>`,
then `git rebase --onto origin/<default> <merged parent head> <child>` (with
`<default>` the default branch) for the first
child and `git rebase --onto <previous child> <its old tip> <child>` for the
next ones. A first child that no longer holds the merged parent head is
"already rebased" and blocks Apply.

**Apply locally** (`POST …/stack-keeper/apply`) refuses a worktree with
tracked changes or a mid-turn agent, fetches the default branch, rebases
each child in its worktree (a temporary one when the branch is not checked
out), points the Paseo workspace's base at the new base, and sets `refs/cocopilot/base/<n>`. A conflict aborts that
rebase, stops the run and lists the files. The result shows the
`git push --force-with-lease origin <branch>` lines and the
`gh pr edit <n> --base <default>` line to copy: both stay yours. Applied
rows get `stack[i].keeper = { parent, at }`, which drops the badge;
**restacked by hand** (`POST …/stack-keeper/dismiss`) sets it without
touching git.

## Dev servers

With the dev-servers Paseo plugin installed
([dev-servers/OVERVIEW.md](../dev-servers/OVERVIEW.md), config in
[configuration.md](configuration.md#dev-servers)), the Plan shows the
servers of the work's stack (`server/dev-servers.ts`,
`src/workbench/tabs/DevServers.tsx`). Without it, or with it down, the hero
says `dev servers off` (hover for why) and nothing else changes.

- Hero: a `Dev servers` line, `Dev servers 2/3 · 1 building` (slots taken
  out of `cap`, building, crashed).
- PR card: a `dev server:` line. The row maps to a worktree of `repo.path`
  by branch (the PR head, else the planned branch). It shows the state and
  port of the server serving the row, `served from <worktree>` when that is
  a stack top, a `pinned` chip, then holders, opt-ins and the idle stop
  time. `none` means no server yet; `not checked
  out` means no worktree has the branch.
- Buttons: **Start** (no server runs) or **Use this server** (one runs,
  this row does not hold it), **Open**, **Open logged in** (projects with a
  login provider: open the server, then copy one snippet into that tab's
  developer console), **Logs** (last 80 lines, every 3 s), **Pin** /
  **Unpin**, **Stop**, or **Force stop** when others hold it or it is
  pinned, after a confirmation naming who loses it.

Agents start none by default (the slots are few). A code-writing agent
(see "Agent worktrees") reads in its brief when to start one: only for UI
or runtime behavior that lint, types and tests cannot show, through the
dev-servers tools the plugin adds to agents of a matching project
(`dev_server_start`, then `dev_server_status` until ready,
`dev_server_login`, `dev_server_logs`, `dev_server_stop` once done). The
line shows when the config has `devServers.projects`.

Each row holds its own lease, as holder `{ kind: "coco", id:
"<slug>/<row>" }`, so stopping one row's server releases only that row.
The page polls every 5 s while visible (30 s while off); log polling does
not count as using the server, so it never keeps one from its idle stop.

Proxy routes, loopback Host and Origin only, POST bodies in JSON. coco
forwards them to the plugin at `devServers.api` with none of the browser's
headers; an unreachable plugin reads as `{ on: false, reason }`, or a 503
with `code: "dev_servers_off"` on an action. Plugin errors keep their status
as `{ error, code, details? }`.

| Route | Does |
| --- | --- |
| `GET /api/dev-servers/board` | `{ on, board }`: the plugin's `GET /api/board` |
| `GET /api/dev-servers/works/<slug>` | `{ on, board, rows }`, a row being `{ key, label, branch, worktree, holderId, server, servedFrom }` |
| `POST /api/dev-servers/works/<slug>/rows/<key>/start` | `{ dedicated? }`; starts or joins the row's server |
| `POST /api/dev-servers/works/<slug>/rows/<key>/stop` | `{ serverId, force? }` |
| `POST /api/dev-servers/works/<slug>/rows/<key>/pin` | `{ serverId, pinned }` |
| `POST /api/dev-servers/servers/<id>/login` | `{ path? }`: the plugin's login reply |
| `GET /api/dev-servers/servers/<id>/logs?lines=` | At most 200 lines, read with `touch=false` |

The plugin asks coco the other way when two stacks build on a branch:
`GET /api/paseo-link/stack?branch=<branch>` answers `{ work: { slug, title
}, rows: [{ key, branch }] }`, the rows of the live work holding that
branch in merge order, each with its PR head or planned branch;
`{ work: null, rows: [] }` when no work holds it.

## Rules ledger

One-line rules in three scopes (`server/rules.ts`): global
(`data/rules.json`, seeded on first read from `seedRules`), work (`work.rules[]`) and PR row (`stack[i].rules[]`). A
rule is `{ id, text, source, addedAt, status: proposed | kept | retired }`.
The kept rules, global first, then work, then PR, go into every brief
(`## Rules`) and every review plan prompt.

The `Rules` tab of a work and the sidebar's Rules page list them with a
scope chip and keep / retire (drop for a proposed one). "🦜 Propose rules"
on a pasted excerpt, or "🦜 rules" in an agent thread, starts a coco
Paseo agent through the Ask path; it ends with one `propose_rules` call, shown
under the box as a card with one row per candidate, Keep (recommended) or
Drop; the kept ones join the chosen scope as `kept`, the dropped ones leave no
trace. The run is one-shot, so the answer is not sent back to an agent.

Routes: `GET|POST /api/rules`, `PUT /api/rules/<id>`, `POST
/api/rules/propose`; the same under `/api/works/<slug>/rules` with `{ scope:
global | work | pr, pr }`.

## Agent threads

"💬 ask an agent" on a review comment, a watch point or a decision
card, and "💬 ask or re-plan" on the review plan, open the item's one text
box: **Start agent** sends the text to a small scoped agent (`models.fast` by
default; the composer's model and thinking pickers choose another); on a comment, **✓ Resolve** / **✕ Decline** close it
with the text as reason (saved in the work notes). There is no separate
remark box. The agent answers inline and suggests a change; you approve or
dismiss it in the thread. cocopilot is the
orchestration layer (`server/threads.ts`):

- Groups. Items on the same subject share one agent: a comment joins the
  open group of its PR whose files include the comment's file (files grow
  with each suggested commit), a card joins its card's group, else a new
  group starts. "regroup…" on a thread moves it to another open group or to
  a new one on its next dispatch. One live agent per comment: the group
  that already holds a comment takes its messages back whatever model is
  picked, and only "regroup… new" starts another; a fresh agent whose
  comment has a `Cc-Comment` commit on an earlier group's branch is told
  "an earlier agent already committed <sha>: <subject>". A code group gets its own Paseo worktree,
  branch `cocopilot/<group id>` branched off the PR head (`paseo run
  --worktree-mode branch-off`); a decision group runs in the repo and
  touches no file.
- Suggestions. For a comment the agent makes one commit per item with
  `Cc-Comment: <comment id>`; its diff shows in the thread. Approve
  cherry-picks it onto the PR branch, in the PR worktree (a temporary one
  when the branch is not checked out). While that worktree has tracked
  changes or an agent mid-turn, the approval is `queued` and lands when an
  agent turn ends or the feed polls. A commit that no longer applies turns
  `conflict` and goes back to the group agent with a rebase request. An
  applied commit turns the comment `fixed`. For a card the agent writes the
  fields to change as JSON; Approve writes them to the card (status, choice,
  rationale and decidedAt stay yours).
- Ready commit. When the group agent's branch holds a commit with the
  thread's `Cc-Comment` trailer that is not on the PR branch yet (neither the
  same trailer nor the same patch-id there), the thread payload carries `ready`
  (`commit`, `subject`, `stat`, `approve` = the message holding its Approve) and
  the thread shows "commit abc1234 ready: Approve" above the messages, with the
  subject and diffstat. It only shows information; it applies nothing.
- Verify before Approve. **Verify** beside the ready line (`POST
  /api/works/<slug>/threads/<key>/verify`) runs the repo's `agentWorktree`
  checks (lint, format, type check, tests next to the changed files) on the
  files of the ready commit, or the open suggestion's, in the group's worktree,
  in the background. The run is stored per sha in the thread
  (`verifies[sha]`: `status` running | pass | fail | deps-pending, `checks`
  with `name`, `ok`, `ms` and the last 40 lines of a failure) and streams on the
  thread's SSE; a pass or fail is reused until a new commit. With
  `node_modules` missing or installing the status is `deps-pending` with what
  is happening, nothing runs and nothing is installed (a lockfile identical to
  the main checkout's is linked; otherwise `own_deps` does the install); the
  next click tries again. When the worktree's HEAD is past the commit (the agent
  committed again) nothing runs: status `stale-head`, `head` recorded; Verify
  the newest commit. Verify is offered on the ready line and on each open
  commit suggestion (`{ commit }` in the body picks which). Approve shows "verified ✓" or "checks failed" and
  stays clickable.
- The brief. The first turn of a code group carries the work's settled
  decisions (the "Decisions (settled, do not revisit)" lines of the PR brief),
  the other findings of the same PR on the same file (title, place, status),
  a note that a finding's Recommendation is a hypothesis, how a fix is
  delivered (one commit with the `Cc-Comment` trailer, Approve cherry-picks it,
  never cherry-pick or push onto the PR branch, a "dismissed" suggestion is not
  a failure) and the rule that a question gets an answer and an `ask` card with
  a marked recommendation, not a commit. A follow-up turn is a delta: what
  changed since the last answer, the reply file and "same rules as your first
  turn".
- Replies. The agent calls the cocopilot `post_reply({ blocks, thread })`
  tool (blocks checked like `post_blocks`, a refusal names the field), which
  writes `threads/<key>-<msg>-reply.json` for it; writing that file itself
  stays the fallback. Typed blocks (see the Findings board above); cocopilot reads it on the thread poll (3 s while waiting) and when the
  Paseo plugin reports the agent's turn ended. One message at a time per
  thread.
- Questions. To have you pick, the agent asks with `cocopilot.ask` and the
  thread's key: the card shows in the thread, after the reply of its turn,
  and your answer goes through the thread like a message (one line "Answer
  sent" in the log, then the agent's reply). On a decision thread an option
  may take the decision on a card option, on a finding thread an option that
  leaves the code as is may dismiss the finding: picking it does that at
  once, with a note in the thread and no new turn of the agent. The thread
  button says when a question waits on you. Replies from before cards keep
  their options, shown read-only.
- Attachments. The thread composer is the agent composer: paste, drop or
  pick images and files; they go with the message to the group agent and
  stay on it in the thread.
- Storage: threads in `data/works/<slug>/threads/<key>.json` (`d.<decision
  id>`, `c.<row key>.<comment id>`), groups in `data/works/<slug>/groups/`.
  Routes: `GET /api/works/<slug>/threads` (summaries: count, waiting,
  lastTs, groupId, open suggestions, open questions as `asks`; retries
  queued approvals), `GET|POST …/threads/<key>` (GET carries the thread's
  `cards`; POST `{ text, model?: sonnet|opus|<provider>/<model>, thinking?,
  groupId?, attachments?: upload ids }`, sonnet and opus mapped to
  `models.fast` and `models.default`, any other model and the thinking level
  checked against `GET /api/models`, both used only when a new group starts), `PUT
  …/threads/<key>` (`{ groupId | 'new' }`), `POST
  …/threads/<key>/suggestions/<msg id>` (`{ action: approve|dismiss }`),
  `GET …/groups`, `POST …/groups/<id>/close` (archives the group's Paseo
  workspace, agent and worktree, and deletes its branch).

## Agent worktrees

An agent that writes code (a review-comment code group, a PR-branch agent:
dispatch entries that edit, Fix findings, a stack fix, a gate skill) gets a
worktree where the repo's checks run. Read-only agents (Ask, persona review,
plan and decision threads) skip all of it. Settings: `agentWorktree` in the
config (docs/configuration.md); without it nothing changes.
`server/agent-worktree.ts`, `server/agent-checks.ts`.

- Readiness runs before every start and every new turn of such an agent
  (idempotent), so older worktrees get fixed and a lockfile changed by a
  rebase is caught.
- Dependency folders (`deps`): each links to the main checkout's while the
  worktree's lockfile matches the main checkout's. When it differs, coco
  gives the worktree its own copy in the background: an APFS clone of the
  main checkout's folder (`cp -c`, a reflink on Linux), then the entry's
  `install` command, run in the folder's parent. The lockfile it was
  installed for is kept in the worktree's git dir, so a later lockfile
  change reinstalls and an install cut short is retried.
- First prompt hold: a code group's first prompt waits (90 s, polling every
  2 s) while the worktree installs its own copy, in the background: the
  owner's POST returns once the message is stored, the thread shows "waiting
  for deps (n s)" and no lock is held while it waits. Past the timeout the prompt says the checks are not ready and to run
  no install, and the agent gets "checks are available now: <commands>" when
  they work. Check commands are to be run from the worktree root as written
  (a `cd` is part of the command, file paths relative to it), never after a
  `cd` of the agent's own.
- `own_deps`: an agent that must add, upgrade or remove a package calls this
  cocopilot tool first; coco turns the linked folders into the worktree's
  own copy and messages the agent once installed.
- Install guard: coco writes a PreToolUse hook into the worktree's
  `.claude/settings.local.json` (`scripts/install-guard.mjs`); it refuses
  `npm|pnpm|yarn install|ci|add|uninstall|…` while a listed folder is a link,
  pointing to `own_deps`. The brief says the same.
- Brief: a "Your worktree and its checks" section lists the shared and own
  folders and the exact check commands (`checks`, with their `fix`
  variant), or which are not available yet and why. A thread follow-up or an
  owner message to a PR-branch agent repeats the section only when it
  changed.
- Setup failure (a failed install, a main checkout without the folder, a
  check binary missing) never blocks the start: the agent starts, the brief
  says the checks are unavailable, coco retries in the background (1, 2, 5,
  10, 15 min) and messages the agent once they work: a thread agent mid-turn
  gets it as a steer, an idle one reads the changed section with its next
  prompt, any other agent gets a message.
- Verification: the agent runs the checks before committing, then coco
  runs them again itself on what it committed (lint and format on the
  changed files, the type check, the tests next to them; a check whose
  `files` match no change, or lacking what it `needs`, is skipped). On a
  review-comment thread, the suggested commit shows its checks (running,
  passed, failed with the output folded under each check, unavailable with
  why); a failure goes back to the agent once as a new turn, and if its next
  commit fails too the thread shows it red and waits for you: Approve stays,
  as "Approve anyway" with a confirmation. Your next message re-arms the
  send-back. A PR-branch agent is checked when the Paseo plugin reports its
  turn ended, on everything it committed since coco started it, once per new
  head: the result is a card in its chat and the "checks" pill of the PR's
  Gates rail (`agentChecks` on the stack row); a failure goes back to it
  once, until a pass or your next message. Tracked agents live in
  `data/agent-worktrees.json`. When coco starts, it readies again the
  worktrees of active code groups and tracked agents, so an install a
  restart cut short starts over and its agent hears when done.

### Preflight (kit-video dispatches)

A `gate:kit-video:*` dispatch first runs cheap checks (`server/preflight.ts`):
the PR worktree's deps, its dev server (crashed, or running mid
`node_modules` swap), the configured MCP endpoints, the LLM key and
`settings-local.json`, and any configured fixture probes. The Dispatch menu
and the Ask dispatch card show it before you approve: ticks, or red lines with
the fix, and the button reads "Start anyway". Red checks go in the agent's
first message as "Known blockers" with a pointer to the skill's "When a beat
is blocked" ladder. It only reports: nothing is fixed or started, and the key
is checked for existence, never read. Cached 60 s per PR.
`GET /api/works/<slug>/preflight?entry=&key=[&fresh=1]` returns
`{ checks: [{ name, ok, detail, fix }], at }`. Settings: `preflight`
([configuration.md](configuration.md#preflight)).

## Review runs

Agents (and, before threads, the hub) start a run with
`POST …/prs/<n>/review-runs` (`{ commentIds, commits, provider }`): open
comments (max 30), one commit per comment or one squash, the provider
(default `models.default`). `server/review-agent.ts` writes a brief to
`data/works/<slug>/reviews/pr-<n>-run-<id>.md` (rules, PR and stack context,
the work notes, the owner personas' checks, the comments in file order); the
agent prompt is only "read this file and follow it". The runner is chosen
from `git worktree list` in the repo:

- `send`: the PR branch is checked out and a Paseo agent sits there, so
  `paseo send <agent>`.
- `cwd`: checked out, no agent, so `paseo run -d --cwd <worktree>`.
- `checkout-pr`: not checked out, so `paseo run -d --new-workspace worktree
  --worktree-mode checkout-pr --pr-number <n>`.

Sent comments get `status: sent` and the run id, the work timeline gets an
`agent` entry, and an `agent-<runId>` tab shows the run (mode, status, comments,
commit mode, provider, place), the brief folded, then the agent's transcript
with its usage, permissions and composer, the same chat as its `ag-<agent>`
tab; when Paseo no longer knows the agent, its last `paseo logs` lines
instead (every 5 s while running). A `stack-<runId>` tab does the same for a
stack fix, with a line per row (branch, comments, tip before → after,
restacked, error).

Results come back on each `GET …/review-runs` (see below): first the result
JSON the brief asks for, `[{id, status, commit, note}]` in
`pr-<n>-run-<id>-result.json`, else the `Cc-Comment: <id>` trailers of the
commits made in the run's worktree. Comments turn `fixed` or `declined` (the
commit and note show on the comment); the rest stay `sent`. The agent may
not push: the brief forbids `git push`, `gh pr comment|review|edit`, and the
server records the remote head before the run. If the remote head changes
without a click on **I pushed**, the run gets a red "remote head moved" chip
and a timeline entry. **I pushed** (on the run row) tells cocopilot that you
did it; the new head then flows through re-anchoring.

## Waiting on you

`#/waiting` (sidebar, count badge) lists everything that stops until you answer, grouped by work then PR: open cards (a choice's options and a confirm's Approve / Reject as buttons), Ask chats and cc-group threads whose agent ended its turn with the last word, and suggestions with an open Approve (a ready commit names its subject). Each row shows the agent's last message, a one-line reply box that goes to the agent, and Dismiss. Tick rows for **Dismiss selected** or **Send 'go' to selected**; a row without that action is skipped. Dismissing a chat or thread question only hides it until the agent speaks again (`data/waiting-acks.json`); dismissing a card or an Approve is the usual dismiss. Nothing acts without a click.

`server/waiting.ts`: `GET /api/waiting`, `GET /api/works/<slug>/waiting` (items `{ id, kind, work, pr, key, title, excerpt, at, link, actions[] }`; an action is the endpoint a button calls), `POST /api/waiting/ack { ids }`, and the SSE topic `waiting` (recomputed on card, thread and Ask changes, cached like `swr.ts`). Finished dispatch agents are not listed: coco keeps no acknowledged state for them.

## Navigation

Anywhere markdown renders inside a work (plan, decision cards, threads,
comments, PR body), a repo path with a folder and an extension, optionally
`:line` or `:start-end`, as text or inline code, becomes a link: hover shows
the lines around it, click opens the editor tab at that line
(`src/components/CodeRefs.tsx`). Paths are read at the head of a PR: the
Review and code tabs use their own PR, a decision card its `pr` field, and
everything else the last stack row with a PR; a file missing at head is
shown from the merge-base. Paths without a folder (`PLAN.md:245`) stay text.

Go to definition, find references and hover on `.ts`, `.tsx` and `.js` files
of the PR head. `server/lang.ts` runs a TypeScript language service in a
child process (`server/lang-worker.ts`, `--max-old-space-size=4096`, so 4 GB
at most and a blow-up never takes the server down) over the head tree read
with `git show`/`git ls-tree`, with the `paths` of `repo.tsconfig`.
One service lives at a time, for the last head used; it starts on the first
open of a file (about 7 s of indexing, RSS 2.6 to 3 GB), is replaced when
another head is asked for, and is killed after 15 minutes idle. A crash puts
that sha on a 60 s cooldown.

The `nav` chip in a code tab shows `indexing…`, `nav ready`, `nav idle` or
`nav error` (hover for the reason). While the service is not ready, or when
`findReferences` has no answer, references fall back to a `git grep -F`
text search over the head (`/api/code/pr/<n>/search`). Targets inside
`node_modules` open as a peek only. Other file types have no navigation.

## How it stays up to date

Pull based, no webhooks:

- PR state, CI and reviews come from `gh pr view`, cached 60 s per PR; bodies
  and file lists from `gh api pulls/N/files`, cached 120 s. A Work page polls
  every 30 s, refreshes with `?fresh=1` when the tab becomes visible again,
  and has a manual refresh button.
- Each fetch is compared with the previous snapshot
  (`data/works/.snapshots/<slug>.json`); a change (closed, merged, ready, new head,
  CI result, approval or changes requested) is appended to the work timeline
  as a `github` entry, so the history survives even when nobody was looking.
- Review comments: any mounted tab of a PR polls every 30 s while the page is
  visible, re-resolves the head, and re-anchors the comments when it moved.
  Opening the tab, focusing the window or coming back to the page asks
  GitHub again (`fresh=1`), so a push made outside cocopilot shows at once.
- Agent turns: the Paseo plugin's `agent.turn_ended` posts the agent's cwd to
  `/api/paseo-link/turn-ended`. When that branch is a row of a live work (PR
  or local `b:<branch>`), every row of the work re-reads its head (fresh for
  PRs, the branch tip for local rows) and re-anchors its comments, in the
  background, one refresh per work at a time.
- Review runs are ingested on each `GET /api/works/<slug>/prs/<n>/review-runs`
  (the same 30 s poll): result file, `Cc-Comment:` trailers, agent state and
  the push guard are read then, nothing runs in the background.
- Paseo projects, workspaces and agents come from the CLI on each request;
  Projects polls every 20 s, Agents every 15 s.
- Live updates (pending permissions, work saves, a work's agents, agent and
  Ask chats with their cards, agent threads) share one event stream across
  all open coco tabs, so they stay under the browser's 6 connections per host:
  the tab holding the `cocopilot-live` Web Lock opens it for every tab's
  topics and relays events on a BroadcastChannel; the next tab takes over
  when it closes, resubscribing everything (each topic replays, `open` first).
  `GET /api/events?sub=<topic>…` (first event `hello` with the stream id),
  `POST /api/events/<id>/subs` `{ add, remove }` to change topics without
  reconnecting. Topics: `permissions`, `works`, `work:<slug>` (`{ slug, what }`
  for each change of a work: `work` saved, `stack`, `plan`, `drift`,
  `artifacts`; the Overview, Plan, Stack, Drift and Kit views refetch on it,
  the server having dropped its cached drift first), `work-agents:<slug>`,
  `agent-chat:<agentId>`, `ask:<convId>`, `thread:<slug>:<key>` (arguments
  URI-encoded); each message is `{ topic, event, data }`, `open` starting the
  topic's replay (a chat replays its timeline, cards come on subscribe). The
  page reconnects with backoff and resubscribes, also when the server's 25 s
  ping stops. The old per-topic SSE routes still answer.
- Personas and skills are read from disk on each request.
- Avatars: `/api/avatar/<login>` serves `data/avatars/<login>.{png,jpg}` when
  present (drop a photo there), else redirects to the GitHub avatar of
  the login found in the persona title. Link favicons come from Google's
  favicon service.

## Inbox (a link → a work proposal)

Sidebar `Inbox`: paste a Notion page, a PR or issue of `repo.github`, or a
Slack permalink, plus an optional note (`server/inbox.ts`, `POST
/api/inbox { url, note }`; any other link is refused). It starts an Ask run
(`kind: inbox`) that also loads the claude.ai Notion and Slack connectors
when your Claude Code account has them, read tools only (`notion-fetch`,
`notion-search`, `slack_read_thread`, `slack_read_channel`,
`slack_search_public`, `slack_read_user_profile`), and `gh issue view`.
Without the connectors, only GitHub links work. Coco frames the work (size,
title, Surface | Before | After table, precedents under `## Precedents` in
the notes, surfaces, personas per planned PR, stack) and ends with one
`propose_work_scaffold` call, shown as a card in the conversation. **Create
work** on the card applies it; nothing exists before. Past links are listed below. A run costs
about $1 to $2.5.

## Ask coco (natural language → proposals)

`POST /api/ask` starts a Paseo agent (`coco · Ask: …`) in the repo's
workspace, or the work's stack worktree workspace when asked from a work,
with the cocopilot MCP server in its config (`server/mcp.ts`, stdio:
`list_works`, `get_work`, `list_personas`, `read_persona`,
`suggest_personas`, `consult_persona`, `read_skill`, `list_paseo`, `github_pr`,
`github_search`, `propose_work_scaffold`). A message that names a PR comment
(a comment URL, or Sentry, Copilot and the like, or a reviewer, with
answer/reply/comment) gets one line added to that turn:
"draft the answer with cocopilot propose_pr_reply". `consult_persona` is the quick
answer to "what would Camille do?" or "evaluate the tradeoff": a pack of that
reviewer's relevant rules and past comments that the agent answers from in 3-6
lines, then an ask card with their pick marked; a persona review (minutes,
whole PR, findings) starts only when you ask for one. In a code-comment thread
the "Ask <persona>" button beside Send prefills "What would <persona> do
here?" for the reviewer mapped to the file; you still send it. `get_work` is slim by default (summary,
stack rows with number, branch, title, state and Notion page, decisions in one line each,
clipped notes, the last note entries); its `sections` argument (`notes`, `timeline`,
`artifacts`, `decisions`, `full`) adds the rest. The Ask brief ends with the
agent's own model and thinking level. It is a normal Paseo agent: every
MCP server and Paseo's permissions apply. coco follows its timeline live
and streams text as it is written, then each tool call with its input and
result, over SSE to the Ask page; a permission the agent waits on shows as a
line and is answered in Paseo. An ask is a conversation with that one agent:
`POST /api/ask/<id>/messages` sends a follow-up to it as a new turn, or,
while it is still working, steers the turn in flight (the same
`activeTurnBehavior: 'steer'` as thread follow-ups); the page echoes the
message at once, appends the reply live and keeps the composer open. The
agent is archived on **Close** (`POST /api/ask/<id>/close`), on **New
conversation**, or after an hour without a message or any agent output (the
prompt cache's lifetime: past it a kept agent saves no tokens). The agent id
is stored with the conversation: after a coco restart the next message goes
to the same agent if Paseo still has it, a turn that was running is followed
to its end, and a gone agent is replaced by a new one that reads the
conversation so far. Inbox links are conversations too; the rules proposal
stays a one-shot run. The agent never writes: a scaffold ends in one
`propose_work_scaffold` call, shown as a proposal card (below); **Create
work** creates the work, or **Update work** updates an existing slug (stack
with planned PRs and their personas, surface table, open questions, notes,
next steps). The conversation stream also carries the cards of every agent
the conversation had. Runs are kept in `data/asks/`. The same MCP server can
be mounted in any Paseo agent or Codex.

## Agent cards (how agents show and ask)

Every agent coco starts mounts the cocopilot MCP server and talks to you
through cards: `post_blocks` shows a result (tables, diagrams, code), `ask`
puts a question on a card (choice, rows, form, confirm) and returns at once;
your answer, or your dismissal, reaches the agent as a new message, steered
into its turn when it is working. An agent with an open card shows as
waiting on you. `AskUserQuestion` is off for coco agents. Cards live in
`data/cards/`; routes, shapes and delivery are in
[agent-io.md](agent-io.md). An answered or dismissed card folds its
context behind **Show details**; open ones stay unfolded. A thread agent's
cards show in its thread (see Agent threads).

Proposals are cards too. `propose_work_scaffold`, `propose_paseo_agent`,
`dispatch` and `propose_repo` post a confirm card that coco builds from the
proposal (stack, surfaces, open questions and flags as tables, the brief or
prompt as code); its button says what it does (**Create work**, **Update
work**, **Start agent**, **Add repo**) and pressing it runs it
there. An update of a work that already has a stack asks, with a toggle,
whether the planned stack replaces it: on when the proposal differs (other
PRs, rows or order), off when it has no stack or the same one. The card
shows the diff (rows added, removed, moved; "N Notion links kept, M lost",
with a warning when some would be lost). A replaced row with the same PR
number or branch keeps its Notion page, gates, kit, workspace, reviewers and
personas; a scaffold row may carry `notionPage` for a new row. The replace
is for a full re-plan: `propose_split` splits a PR. To change the stack of an
existing work, agents use `propose_stack_edit` instead: an **Apply** card
listing the stack after the edit (rows added after a given PR, updated,
moved or removed; every field the edit does not name stays, Notion pages
included) with a **Then sync the linked Notion page** toggle when the work
has one; with no row change it is a **Sync Notion** card. The sync rewrites
the work's one Notion page; it creates no page per row and renames none (a
row's page is linked by url and title). The card then shows the outcome with
an **Open** link to the work, the agent's tab or the repo, and the agent
gets your answer with that outcome (`Done:` or `Failed:`). Reject or a note
runs nothing. To split a PR, an agent first cuts the branches and opens the
PRs, then posts one **Split** card (`propose_split`): the original row
replaced in place by the parts in order, each with the GitHub base it will
get (the first on the original's base, each next on the previous part, the
row after the split on the last part), the first part keeping the original's
Notion page. Two toggles, both on: **Create Notion pages for the new rows**
and **Then refresh PR bodies**, which posts one Start agent card per PR for
the body gate and starts nothing itself. Pressing **Split** applies the rows,
runs `gh pr edit --base` for the PRs that exist and shows each step's
outcome; if one failed, the agent proposes the same split again and only the
missing steps run. An agent started from **Start agent** carries the work's
label (and its row when the conversation has one), so it lists among the
work's agents. Ask any agent to answer a PR comment (a reviewer, Sentry, a
finding) and it posts a **Post reply** card: the comment it answers, the
draft in an editable box and a **Then resolve the thread** toggle. Edit and
press **Post reply** to post it with gh, or write a note to have the agent
refine the draft. `propose_rules` is a rows card (see Rules ledger);
`propose_review_plan` stays the review plan's result, not a card.
Conversations saved before cards keep their proposals in the transcript as
the tool call, read-only.

The same MCP carries the agents' writes to the work, in place of curl:
`upsert_finding`, `upsert_decision`, `attach_media`, `import_artifact` and
`set_next`, each defaulting to the agent's work and row; the HTTP routes stay
for you, scripts and sessions without the MCP.

When you ask any coco agent for a change to coco itself ("read local head, not
origin"), it calls `flag_coco_issue` instead of saying another session owns it:
a finding with no file or line lands on the cocopilot work's first row (the work
whose repo is `cocopilot`, or `cocoWork` in the config) with your words, the
agent and work that raised it, and the agent answers with its link
(`#/work/<slug>/findings-<row>/f-<id>`, opening the Findings tab on it). The same
title updates the finding. Nothing is dispatched; no fix agent starts and the
Fix accepted run skips these findings.

## Model, thinking and mode (composer)

Every agent composer shows, next to the paperclip, the model (Sonnet 5.5),
the thinking level (High, or the model's default) and an **auto** chip.
Each opens a small menu: the models Paseo lists for the providers your
`models.default` and `models.fast` use (`default` and `fast` tagged), and the
thinking levels of the picked model. The model menu lists the newest release
of each family (Opus, Sonnet, Fable, Haiku…), plus the defaults and your
current pick even when older; **Show all models** at its foot adds the older
releases and the 1M-context variants, and is remembered in this browser. The mode is not a choice: every coco
agent runs in Paseo's auto mode, and a brief saying not to touch code is what
keeps one read-only.

- Starting an agent (a new-agent tab, the Ask page and panels, Dispatch, a
  thread's first message): the pick goes with the start. Unpicked, Ask and
  general agents run on `models.default`; a persona review, review threads and
  the review plan on `models.fast`. The last pick per kind (ask, thread,
  dispatch-`<entry>`) is remembered in this browser.
- A live agent (agent tabs, an open Ask conversation): the pickers show its
  current model and thinking, and a new pick switches the agent in place from
  your next message (Paseo's set-model and set-thinking calls); a parked or
  closed Ask conversation takes it to the next agent it starts. A live agent
  never switches provider.
- Picks are checked against `GET /api/models` (Paseo's list, cached 10 min,
  retried sooner after a failure): an unknown model or a thinking level the
  model lacks is refused before anything starts. Routes take `provider`
  (`<provider>/<model id>`) and `thinking`: `POST /api/ask`,
  `POST /api/ask/<id>/messages`, `POST /api/agent-chat/<agent>/messages`,
  `POST /api/works/<slug>/dispatch`; threads take `model` and `thinking`.
- The Ask agent's system prompt tells it to hand focused subtasks (a
  single-file read, a search, a per-file review) to subagents on the fast
  model.

## Subagents (what an agent starts itself)

An agent can start its own subagents (Claude's `Agent` or `Task` tool, in the
background or not). coco shows them from Paseo's provider subagents, read-only:

- **Pill bar** above the composer of every agent tab (`ag-`, `ask-`, review
  and stack runs): a pill per running subagent (spinner, description, time
  so far); finished ones fold into **N done**. A pill opens the subagent's tab.
  On the Ask page and the repo and Inbox panels, where there are no tabs, it
  opens the transcript in a dialog.
- **Subagent tab** `sub-<parent agent>~<subagent>`: its transcript, live while
  it runs, under its status, time, Paseo's model line and a button back to
  the agent that started it; the inspector shows that agent. No composer: to
  steer it, message the parent.
- **Transcript**: an `Agent`/`Task` call is a compact row (description, type,
  background or foreground, live status, **Open**), its prompt behind
  **brief**, a foreground result behind **result**; the "Async agent
  launched…" note is hidden.
- **Sidebar**: an agent with running subagents shows **⑂ n**, and they are
  listed under it while they run.

Routes: `GET /api/agent-chat/<agent>/subagents` → `{ subagents }`;
`GET /api/agent-chat/<agent>/subagents/<id>/events` replays its timeline as
activity events then follows it (SSE). Page topics `subagents:<agent>` and
`subagent:<agent>:<id>` carry the same, pushed by Paseo's
`agent.provider_subagents.update` feed (polled every 5 s without it). Each
work agent carries `subagents: { running, total }`.

## Attachments (images and files to an agent)

Every agent composer (agent tabs, Ask conversations, new-agent tabs, the
repo and Inbox panels, agent threads) takes images and files: paste a screenshot, drop
files on the composer, or pick them with the paperclip. Each uploads at once
(`POST /api/uploads?name=…`, raw body, `Content-Type` the file's) to
`data/uploads/<id>/<name>` and shows as a removable chip; images png, jpeg,
gif or webp up to 5 MB, other files up to 20 MB, 8 per message, refusals
inline. The message carries the upload ids: images reach Paseo as `images`
(base64), other files as `uploaded_file` attachments the agent reads by path,
on a follow-up or the message that starts an agent. Paseo's timeline keeps
only the text, so the transcript shows the files from coco's own record: an
Ask conversation's log, or `data/uploads/sent/<agent>.jsonl` for any other
agent, paired by message id or text. `GET /api/uploads/<id>` serves a file
back. At boot and daily, uploads older than 24 h that neither record names
(dropped from the composer, never sent) are deleted; sent ones stay.

## Team pack (share with teammates)

The **Team pack** card on the Dashboard zips what a teammate needs to work
the same way, and merges such a zip back in. Packs are personal files: never
commit them.

**Export** lists what can travel and lets you tick it:

- Personas: every file in `personasDir`, grouped by login (persona,
  `<login>.json`, companions); other files (README, …) as one group.
- Skills: those named with `skillPrefix`, `methodSkill`, the targets of
  `skillOverrides`, the skills in `gateSkills`, and the `/skill` commands of `rituals` that exist in
  `skillsDir`. Symlinks, `node_modules`, `.git`, `dist`, `data`, `*.bak`, the
  cocopilot app folder and `personasDir` are left out of a skill folder.
- Team config: the raw JSON of your config file minus personal keys
  (`owner`, `dataDir`, `briefsDir`, `skillsDir`, `personasDir`, `baseUrl`,
  `importRoots`, `repo.path`).
- Feature-flag provider: the `featureFlags.provider` module.

The zip holds `coco-pack.json` (manifest: `format: 1`, `createdAt`, `by`, the
contents), `personas/`, `skills/<name>/`, `providers/<file>` and
`config.json`, whose `featureFlags.provider` points at `providers/<file>`.

**Import** uploads a zip and shows a preview before touching anything: each
persona and skill file as new, changed or same, the provider, and the config
keys added, changed, and the personal keys kept as yours. Entries with an
absolute path, a `..` segment or a symlink are refused. Packs carry skills and
code that agents and coco run: import only from people you trust.

**Apply** backs up every file it overwrites into
`data/pack-backups/<timestamp>/` (same layout), then copies personas into
`personasDir`, skills into `<skillsDir>/<name>/` (adds and overwrites, never
deletes), the provider into `data/providers/`, and merges the team config into
your config file (or creates `<app>/coco.config.json`). **Discard** drops the
staged pack (`data/pack-staging/<id>/`). Restart coco to load the new config.

Routes: `GET /api/pack/contents`, `POST /api/pack/export` (JSON selection →
zip), `POST /api/pack/import` (raw zip, 200 MB max → preview),
`POST /api/pack/import/<id>/apply`, `DELETE /api/pack/import/<id>`.

## Tests

```bash
node --test server/*.test.ts
(cd dev-servers && npm test)   # the dev-servers plugin, Node 22+
```

## Design notes

Theme: `system` (default, follows `prefers-color-scheme`), `light` or `dark`, stored in `localStorage` `cc.theme` and applied as `data-theme` on `<html>` before first paint; switch it in the Beta panel (Cmd/Ctrl+.) or with Cmd/Ctrl+Shift+L.
Colours go through the `--dp-*` CSS variables set on `.dp` in `src/preview/preview.css` (dark values under `html[data-theme="dark"] .dp`); everything renders inside a `.dp`, portals (PR and code peeks, the diagram viewer) and toasts included through a `.dp.dp-float` wrapper; `src/styles.css` only keeps element defaults on those tokens. Monaco (`cocopilot-dark`) and mermaid follow via `src/theme.ts`.

## Pages

- Projects: Paseo projects → workspaces → agents, with the attached work.
- Work: the workbench is the only UI (`src/preview/`, on the tab engine of
  `src/workbench/`; `#/design-preview/<slug>` links redirect to
  `#/work/<slug>`). Every surface is a tab. Tab ids (also the hash):
  `plan` (overview), `stack`, `findings`, `waiting`, `pr-<n>` (PR details),
  `review-<n>` (review hub), `diff-<n>~<path>` (a changed file of PR n),
  `file-<n>~<path>` (any file at the PR head), `artifacts`,
  `artifact-<name>`, `agent-<runId>` (a review run), `stack-<runId>` (a
  stack fix), `brief-<n>` (the PR's brief and agent), `ask` (new agent),
  `decisions`, `rules`, `timeline`, `notes`. Tabs live in editor groups
  laid out like VS Code: a tree of horizontal and vertical splits, any
  depth, a 6 px handle on every split. One tab id exists once across all
  groups, and opening an open tab focuses it. A group that loses its last
  tab disappears; the last group keeps `plan`.
  - Tabs: click activates, double click pins, middle click or × closes. A
    preview tab (italic, opened by "details ▸" or an artifact's name or View) is replaced by the
    next preview in its group until pinned. The focused group's active tab is
    underlined in the accent colour; "⫿ split" moves the active tab to a new group
    on the right (Alt-click: below); "⤢" maximizes the focused group ("↙ exit"
    chip or `Escape` leaves).
  - Drag a tab to reorder it in its strip or drop it on another strip; drop
    it on a group's body to move it there (center) or to split that group on
    that side (left, right, top, bottom quarter, highlighted while dragging).
  - Keyboard: `Cmd/Ctrl+P` quick open (the PR's changed files first, then
    every file of the head tree; the PR is the focused tab's, else the first
    open PR of the work), `Cmd/Ctrl+W` close the active tab of the focused
    group, `Cmd/Ctrl+\` move it to the next group (split right when there is
    one group), `Cmd/Ctrl+1` … `9` focus a group in reading order, `Escape`
    leaves maximize. In a diff: `c` comments the selected lines. Browsers
    keep some of these for themselves (Cmd+W and Cmd+1…9 close or switch the
    browser tab; Cmd+P may open the print dialog outside an app window).
  - Hash: `#/work/<slug>/<tabId>[/max]` is the focused group's active tab,
    with the tab id URL-encoded (`#/work/<slug>/diff-101~src%2Fbilling%2F…`).
    Opening a tab pushes a history entry, switching tabs replaces it; a link
    to a tab that is not in the layout opens it (pinned) in the focused
    group. `#/work/<slug>` restores the saved layout. The layout tree (splits,
    sizes, groups, focus, max) is saved per work in `localStorage`
    `cc.wb.<slug>`; the older two-group format is migrated on load.
  - Inspector (right panel, `Cmd/Ctrl+I` or × hides it): it follows the
    focused group's active tab, its bar naming what it shows. `review-<n>`:
    a one-line PR header (#n, state and CI chips, the current milestone or
    "all clear", Details opens `pr-<n>`) over the review plan and activity feed,
    and the Review tab drops its own activity pane so the diff takes the
    width; a location in the feed opens that Review tab at the line.
    `pr-<n>` (the details already fill the tab): the same plan and feed, the
    one thing the tab lacks. Agent tabs (`ag-…`, `ask-…`): status, model,
    usage, the PR it works on, its open questions with a jump to the oldest,
    Open in Paseo. `diff-`, `file-`, `findings-<n>`, `brief-<n>` and
    `ask-new-<n>`: that PR. Findings and Decisions: the PR of the selected
    item. Anything else, or a whole-work item: the PR selected in the Stack.
    Hidden, or with details as tabs (narrow window, "PR details: Tab"), the
    Review tab shows its activity pane again.
  - Notes: title (100 characters), description and notes in markdown
    (Write or Preview; double-click a preview to edit), and the stack order
    as PR numbers in merge order, planned rows kept after them. Each section
    has its own Save and Revert.
  - Artifacts: by name or newest, a filter; a name or View opens the
    artifact in a preview tab, Open serves the raw file in a new browser
    tab; a folder without `index.html` lists its files. "Import from disk…"
    copies a file or folder under `importRoots`, optionally tied to a PR
    head and a kit kind.
  - Legacy links `#/work/<slug>/plan/<pane>` still work: plan on the left,
    the pane on the right, then the hash is rewritten to the new format.
  - Phone (≤ 900 px): one group; the tabs of every group are appended to
    the strip, which scrolls horizontally; no handles, no split button.
    Monaco never loads: a diff tab renders `LiteDiff`, the server's unified
    diff in plain HTML (head side only), with the same comment cards.
- Dashboard: personas (stale flag at 60 days, calibrations), skills, agents,
  rituals, feedback, backlog, changelog.
- Persona: JSON overview with per-section feedback, rendered file, editor on
  every related file, feedback log; a button per configured ritual that
  takes a persona login.
- Skill: rendered SKILL.md or companion file, editor.
- Agents: live list with log on tap; workspaces.
- Rituals: one form per entry of `rituals` in the config.

## Personas

A persona is a markdown file per reviewer in `personasDir`: `<login>.md`,
plus an optional `<login>.json` overview and companion `<login>-<suffix>.md`
files (suffixes and ignored names in `personaFiles`).
cocopilot reads the `# Name — \`login\`` title, a `Mined YYYY-MM-DD` date
(stale after 60 days), the `## Surfaces` YAML block (path globs used to
suggest owners for a PR's files), and counts the items under `## What they
check` and `## Calibration`. A file containing "message-writer" is a writer
persona (your own voice), not a reviewer. See
[examples/personas/alice.md](examples/personas/alice.md).

## Notion sync (one way, on click)

A work can own one Notion page: `work.notion = { pageId, url, syncedAt,
syncedHash }`. The hero's Notion line links an existing page (paste URL) or
creates a sub-page under one of the work's Notion links. Each sync replaces the
whole page body with `server/notion.ts` `renderWorkMarkdown`: title,
description (summary, Surface | Before | After table, mermaid code block),
progress + stack table (PR, title, state, reviewers), links, notes, artifact
names. Timeline and developer details stay out. Humans write in child pages or
comments; the top callout says so.

Out of sync = hash of the current render differs from `syncedHash` (orange
chip). On an existing page the click runs a read-only **preview** first: coco
fetches the page, compares it with the new render and lists every change with
a severity (high: a rule, decision, Before/After row or whole section changes
or disappears, or human text on the page would be erased; medium: PR,
reviewer set, open question or link; low: progress, state, wording), plus the
paragraphs that would be erased. The preview card offers Apply (confirms when
any change is high), Refresh, Discard. Apply still checks `last_edited_time`.
Transport: a Paseo agent (`coco · Notion sync: …`, archived once it
answers) with the claude.ai Notion connector
(needed for this feature only) (`notion-fetch`, `notion-update-page`, `notion-create-pages`), one run per
click, about $0.5 to $1; runs logged in `data/works/<slug>/notion-runs.jsonl`,
the rendered markdown in `notion-sync.md`. Nothing syncs on its own.
