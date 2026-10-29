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

### Restarts and rebuilds under an open page

The status bar shows the commit the server runs (`coco <sha>`, `*` when the
checkout was dirty at boot) and, once the checkout moved past it, "N commits
behind · Restart" (`POST /api/server/restart`: the client builds into
`dist.next` while the running server keeps serving, its chunks join `dist`
beside the old ones, then `index.html` is renamed over the old one, so `dist`
never misses a file; then only this build's chunks and the replaced build's
(open pages still load them; listed in `dist/.assets`) are kept; the old
server stops and the same argv starts; a `package-lock.json` newer than the
last install runs `npm install` first; a failed install or build leaves the old
server running; log in `<dataDir>/server-restart.log`). A server that finds its port
taken exits quietly.

- While the server is away (a restart, a crash) the status bar reads
  "Reconnecting…" and error toasts stay quiet; the page reconnects by itself.
- The served `index.html` carries its build (`<meta name="coco-build">`, a hash
  of `dist/index.html`, also `build` in `GET /api/server`). When the page sees
  another build (on reconnect, on focus, on the minute poll of `/api/server`)
  or a lazy chunk of its old build is gone (`vite:preloadError`, "Failed to
  fetch dynamically imported module"; a missing `/assets/` file answers 404),
  it reloads once the server answers, keeping its hash and layout.
- It never reloads while something is unsent or unsaved: a composer with text
  or files, a card whose choice, fields or Other text you changed, the New
  work and New agent forms, unsaved notes, a decision rationale, the rules,
  handoff and feedback boxes, a file editor with changes, or an in-app dialog
  open (each registers through `useUnsaved` in `src/updates.ts`); saved text
  in a box does not count. The status bar then shows "coco updated · Reload"
  and the reload happens once nothing is left. A second automatic
  reload within 20 s waits for the click instead.
- Composers (agent and Ask chats, threads, findings, commit review, dispatch)
  keep their unsent text per tab in sessionStorage (`coco.draft.<key>`), so a
  reload loses no words. A thread message (or a comment's first agent
  message) that the server refuses or never gets goes back into its box with
  its files, before anything typed since, and an error toast says so even
  while the server is away.
- Questions and confirmations open an in-app dialog (`src/components/Dialogs.tsx`:
  `ask`, `confirmDialog`, `choose`), never `window.prompt` / `confirm`, which
  the desktop app does not show.
- Every `git status` coco runs for polling passes `--no-optional-locks`, so it
  never takes the index lock from an agent committing in the same worktree.

### Paseo health

The status bar's **Paseo** item is the daemon as coco's bridge sees it
(`server/paseo-health.ts`): a green dot while connected, amber and spinning
while reconnecting, red once down for 30 s or unreachable at boot (coco tries
again every 15 s), amber "Paseo · OpenCode is out" when a provider of
`models.*` in the config is not ready. Its popover shows the daemon version,
why it is not connected (the SDK's last error, the next retry), and each
provider with its status; one out says why (its own error, else its
diagnostic: "codex not found on PATH", the status line), the whole
diagnostic on hover.

- **Refresh providers** asks the daemon to look at its providers again
  (`refreshProvidersSnapshot`, what to try when one stays unavailable).
- **Restart Paseo daemon**, after an in-app confirm, runs
  `paseo daemon restart --json --timeout 120` (the worker restarts under its
  supervisor; `PASEO_AGENT_*` / `PASEO_WORKSPACE_ID` stripped from its env).
  The item reads "Restarting Paseo…", then reconnecting, then connected; a
  failure shows in the popover.
- Routes: `GET /api/paseo/health`, `POST /api/paseo/restart`,
  `POST /api/paseo/providers/refresh`, SSE topic `paseo` on each change.
  Providers are read on connect, on Paseo's provider updates and at most once
  a minute on a read.
- coco's bridge reconnects by itself (backoff capped at 10 s) and the SDK
  re-attaches every subscription: agent timelines, the live agent list
  (permissions, jobs, agent rows reload from its fresh snapshot) and subagent
  events. A turn coco waits on keeps waiting across the restart until its
  deadline, and the tool calls it settled while the daemon was away (a
  proposal among them) are read back from its timeline. An open agent tab
  notes "Paseo reconnected: reopen this tab to see what the agent did
  meanwhile".

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

### Spun-off works

When an agent of one work proposes a new work (`propose_work_scaffold`) and
you press Create work, the new work keeps `parent: <slug>` (the work the
agent's card was posted in, else its Ask conversation's work), lands in the
parent's repo, and the parent's timeline gets "spun off work <title>"
linking to it. The parent's Overview lists its spun-off works (title, stack
state or archived, and each one's What's next summary, read live: a child's
new title, state or `next` reloads the parent's page; nothing is copied into
the parent's own `next`). The child's Overview header reads "from <parent>".
In the sidebar a live child sits indented under its parent when both are in
the same repo. Works created before this are linked once at boot from their
"created from agent <id>" timeline line, when that agent's cards name a work
(`server/lineage.ts`; idempotent). Updating an existing work links nothing.

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
an editor in three resizable panes. Left: the changed files in coco's
plan order (or as a tree), category chips, ticks and comment counts, the
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
Opening the Review tab of an open stack row starts it on its own when there is
no plan for the current head (none yet, or the head moved): `POST
…/review-plan { auto: true }`, which the server runs only for a row of the
work's stack, with no run in flight, and at most once per head. A head whose
run failed, or that already had a run, waits for "Plan this review" or
"Re-plan".
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
`data/works/<slug>/reviews/pr-<n>-plan.json`. When the head moves, each file
the plan does not know goes, tagged `new`, into the first step holding its old
path (a rename), then its folder, then its feature; "Not in the plan" keeps
only what no step can take. The "head moved · N new · re-plan" chip and
"Re-plan" redo the plan in full. "💬 ask or re-plan"
opens the plan's thread (`p.<row key>`): **Start agent** asks a scoped agent
about the plan (read-only, through git at the plan's head), **↻ Re-plan with
this** re-runs the plan with the text as guidance (`POST
…/review-plan { guidance }`).

Once a plan exists the Review tab opens in plan mode; the Plan / Tree
toggle (kept per PR) reorders the list and the cards together. Before any
plan, files show as a tree with the category chips. In plan mode the list is
grouped by step, then Skim: each file shows its folder (longer where two
files share a name), each step its why, reviewed count and watch point
count. A click on a step folds it in the list and the cards (kept per PR);
ticking a step's last file Reviewed folds it too, on that tick only (unfold
it again and it stays open); `j`/`k` skip folded steps and a jump into one unfolds it. The cards sit under
a header per step. The focus note of a file and its watch points (lines,
severity, a click jumps to the line) show under its card header, folded
cards included. Watch points also appear as dashed "coco suggests" zones in
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
checkbox and its number, severity, the claim across the list's width (two
lines, then an ellipsis), and under it file:line, reviewer, age. Tick rows,
or type "pick 1-3, 5, 7" above the list, for a bulk Accept or Dismiss…; the
header checkbox ticks every row shown. `J` and `K` move, `X` ticks, `A`
accepts, `D` dismisses. Accept turns a finding into an open local comment at
the head (a finding without a file is only marked accepted; an open comment is
marked accepted); Dismiss asks a one-line reason (declines a comment,
dismisses a watch point, otherwise a `## Review remarks` line). The toast
offers Undo. The selected finding opens on the right: chips, title, PR,
file:line (opens the diff), body, Accept / Dismiss… / Reopen / Open on
GitHub, then its agent thread (cards, composer; "Accept with this note" and
"Dismiss with this reason" use the typed text).

Accept starts the fix: each accepted finding with a comment goes to its
thread's agent with "Accepted: fix this finding" and your note (`POST
…/findings` with `note`, `model`, `attachments`), in the background. Findings
on one file of a PR share an agent; "Accept together" in the bulk bar (two or
more ticked) gives the PR's ticked findings one new agent (`together: true`).
The agent works in its own worktree off the row's branch, asks with cards
when the fix is not obvious, and suggests a commit you Approve (cherry-picked
onto the row's branch, the finding then resolved). A finding without a file
or line has no comment and gets no agent (the toast says how many). An
accepted row shows where its agent stands: working, asks you, commit ready.
A new finding with a file shows the composer with "Accept & fix": the same
accept, with your text as note. Before Accept, the thread of a finding is
discussion only ("Ask agent"): its agent is told every turn to answer and
change no code until you accept; asking it for the fix (a card option that
changes the code, "fix it") is accepting, and the agent accepts the finding
itself. An open suggested commit stays as a chip above the thread's composer
(Review commit, then Approve), and an agent tab's Transcript says how many
wait, linking to its Thread. While the group's agent is alive and has
seen the thread ("agent live"), a message goes out as a new turn only (the
message, what changed since its last answer, the reply path), not the whole
brief again. Dismiss or Reopen releases the finding's thread from its group
and prunes the group's agent, worktree and branch once no item is left; it
keeps them while the agent is answering or a suggested commit is not
applied. "prune agent" in a thread does the same by hand.

A stack fix (one agent bottom-up over the rows, `POST …/stack-fix`) still
runs from the stack: `select: "accepted"` limits it to the open comments
whose finding is accepted in `findings.json`, `select` also takes `{ "<row
key>": [comment ids] }`, and no `select` keeps every open comment; the last
run sits in the Findings header as "Stack fix <status>". The brief adds each
comment's triage: the board note, your thread messages and the agent's last
reply; the agent follows the outcome agreed there and declines anything
needing a GitHub write, with the drafted text in its note. Sent findings
show `sent` until the run settles. An agent running in a row's worktree
refuses the run, except the one that asked for it (`requestedBy`).

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
`data/works/<slug>/findings-cache/<pr|stack>.json`. A plain GET answers
with the saved board at once; older than 15 s (always with `?stale=1`) it
carries `stale: true` and a refresh starts behind it, and the SSE topic
`findings:<slug>` tells the page when that refresh landed a different board.
`?fresh=1` waits for a new collect. Refreshes share one run, the stack PRs'
GitHub remarks are read four at a time, and a decision taken during a run
keeps its stale result out of the caches.

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

### Brief lessons

A dispatched agent's brief is written by a fast-model run from the template
facts and the repo's lessons (`server/brief-writer.ts`). Lessons come from
your follow-ups to dispatched agents: once such a run is archived, or idle
for an hour (checked every 10 minutes), the judge (`models.judge`) keeps the
follow-ups that supplied context its brief lacked (a fact, where something
lives, a convention), not steering or new requests. They are stored per repo
in `data/repos/<id>/brief-lessons.json` and listed on the repo page
(`#/repo/<id>/lessons` scrolls to them), where Drop removes one. A work's
Overview shows the count under Facts (Lessons N, linking there), and ⌘K has
"Lessons · <repo>" for each repo, the open work's first.

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
  push fails. A branch that diverged from GitHub gets **Rebase on GitHub**:
  an agent in the PR's workspace rebases the local commits onto GitHub's
  head and resolves the conflicts, or reports that a rewritten local history
  needs a force push; coco never force-pushes.
- A stale kit piece (body, diagram, video, by the freshness rules above)
  starts that kit gate's skill, for example `/coco-pr-body` for the body.
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

## Jobs

Every background action the owner starts is a job (`server/jobs.ts`):
`{ work, pr, action, label, kind: agent | command | sync | setup, state:
running | needs-you | done | failed | lost, agentId, output, error }`. The
request registers it and answers at once with `{ job }`; the work goes on in
the background. A live job refuses its duplicate (same work, PR and action)
with 409 and the running job.

- An agent job (a dispatch, a gate skill run) needs you while its agent waits
  on a permission and is done once the agent's first turn ends.
- A thread message is its own agent job (a thread takes a second message while
  its agent still works), so it is never refused as a duplicate.
- A review plan and a Notion sync or preview end with their own outcome, not
  at their agent's first idle turn: a plan with no proposal, an error or a
  page edited in Notion fails the job. Their agent is linked for the chip.
- A command job (push, fix base, mark ready, restack, split, dev server start
  or stop, coco's checks on an agent's commits) keeps the command's output
  tail; a failed command fails the job with it. A failed check run still ends
  its job done: its result is in the checks card.
- A sync job (a GitHub refresh, a findings collect asked fresh) and a setup job
  (a worktree's dependency install, a repo add) are waited on by their caller:
  while the same one runs, a second request runs untracked rather than refused.
- The last 50 jobs of each work are kept in `<dataDir>/jobs/<work>.json`. After
  a restart, a command, a review plan or a Notion sync that was running is
  lost; an agent job keeps following its agent; a spare worktree or an agent
  worktree's install starts over on boot under a new job, its cut one dropped
  from the list.

Each action button stands for its job: a running chip with the elapsed time
that opens the agent, then a ✓ for a minute, or a failure with Retry and
dismiss. The status bar shows "n jobs running" (and failures) with the list,
the PR's milestone pill, its Stack row and its sidebar row spin while a job
runs on it, and the work sidebar's Overview group lists running or failed
commands under Jobs. An agent job whose agent does not exist yet (worktree,
brief and dependencies come first) shows in its PR's or the work's Agents
list with its elapsed time, until the agent it starts takes its place. Each job's end is
toasted once. Routes: `GET /api/jobs?work=<slug>`, `POST
/api/jobs/<id>/dismiss`, topic `jobs` (optional work).

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
  `Cc-Comment: <comment id>`; it shows in the thread with Verify, Approve and
  Dismiss. Approve
  cherry-picks it onto the PR branch, in the PR worktree (a temporary one
  when the branch is not checked out). While that worktree has tracked
  changes or an agent mid-turn, the approval is `queued` and lands when an
  agent turn ends or the feed polls. A commit that no longer applies turns
  `conflict` and goes back to the group agent with a rebase request. An
  applied commit turns the comment `fixed`. For a card the agent writes the
  fields to change as JSON; Approve writes them to the card (status, choice,
  rationale and decidedAt stay yours).
- Which commit is whose. coco reads the group branch for the commits made
  since it last looked (none of the PR branch's, local or `origin/`; merges
  skipped): when the agent's Bash runs `git commit`, at the end of each reply
  and turn, and when the thread is opened. A `Cc-Comment: <id>` line counts
  anywhere in the message, in any case, quoted or listed (git itself only
  reads trailers in the last paragraph; coco does not rely on that). A
  commit without one goes to the only item the agent worked on in that turn
  (the message that started it and those that steered it), else to the item
  it answered last. It lands in the turn that made it: on that turn's reply,
  or as a bare suggestion at the end while the agent still works, which the
  reply then fills, so it reads before the turn's `ask` card. Once seen it
  reads "commit seen · checks running" until coco's checks finish. A commit
  no item takes (its `Cc-Comment` names no item of the group) stays on the
  group: each thread of the group shows "commit abc1234 not linked to a
  comment" with **Link to…** (an item of the group, which gets it as its
  suggestion, or "Drop it"). A commit its thread could not record goes
  there too, and a group with such a commit is not closed when its last
  item settles (closing deletes the branch). The agent's brief says each
  commit shows by itself, so it never re-commits to make Approve appear.
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
- Talking before the agent is ready. A first message opens the thread at
  once, and the box stays usable while coco finds the group, takes a spare
  worktree or creates one (about 15 s) and starts the Paseo agent: the steps
  show live as a list (done ones ticked with their time, the current one
  counting). The first message reads "sending · starts the agent", any
  message written meanwhile "queued · reaches the agent once it is ready";
  they reach the agent in the order written once it exists (the first as
  its brief, the next ones steering that turn). The server keeps the posted
  messages not stored yet (`inbound` on the thread payload and an `inbound`
  event on its stream; the steps as `starting.steps` and `step` events), so
  another tab or a reload shows them too. While coco installs the worktree's
  own dependencies the header shows "installing deps"; the agent reads and
  changes the code meanwhile and hears when its checks work. An Ask chat
  does the same: its new agent's steps ("Opening the worktree of #12",
  "Starting the agent") show in the chat, and a message written meanwhile is
  marked queued and goes to the agent right after the first, in order.
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
  `GET …/groups` (a code group carries its `unlinked` commits), `POST
  …/groups/<id>/link` (`{ commit, key | null }`: the commit becomes that
  item's suggestion, or is dropped), `POST …/groups/<id>/close` (archives the
  group's Paseo workspace, agent and worktree, and deletes its branch). A code
  group's commit bookkeeping (head last read, PR branch, items of the current
  turn, unlinked commits) is in `groups/<id>.commits.json`.

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
  change reinstalls and an install cut short is retried. An `optional`
  folder the main checkout lacks is installed the same way (no clone), so
  the checks that need it run and spares come with it.
- No first prompt hold: a code group's first prompt goes out while the
  worktree still installs its own copy (`hold.ms` in `createThreads`, 0 by
  default). The prompt says the dependencies are still installing: the agent
  reads and changes code meanwhile and runs no check or install of its own,
  and it gets "checks are available now: <commands>" when they work. Until
  the message is stored, the thread header shows what it waits on (finding
  the agent, taking a spare worktree or creating one, starting the agent)
  with the seconds spent, streamed as `step` events and returned as
  `starting` by `GET /threads/<key>`. Check commands are to be run from the worktree root as written
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

### Spare worktrees

`git worktree add` takes seconds on a big repo (~15 s on a 30k-file one), a
branch switch in an existing worktree a fraction of one. With
`agentWorktree.spares` set, coco keeps that many worktrees per repo ready in
`data/spares/<repo>/<id>` (`server/spares.ts`, listed in `data/spares.json`):
detached at `origin/<default branch>`, deps readied like any agent worktree,
then the `warm` steps run (a type check, so the agent's first one is
incremental). A review-comment code group takes one (`checkout -B
cocopilot/<group> <PR head>`), adopts it as a Paseo workspace and starts its
agent at once; the pool refills in the background, one spare at a time, shown
in Jobs. A spare still warming can be taken: its step is cut short. No spare
ready: the group makes its own worktree as before. Closing such a group
removes its worktree (Paseo only removes the ones it made). A group closes when
its last finding is settled with nothing open; every 10 minutes coco also
closes the code groups whose findings are all fixed, declined or outdated and
whose agent has been gone or idle for an hour, keeping their branch
(`threads.sweepGroups`). A thread holds one open commit: a new one supersedes
the open one, and carries the changes of the commit it builds on, so Approve
picks both. On restart,
spares cut short or beyond the wanted count are removed, then the pool fills.

### Changes (a workspace's git panel)

What the Paseo app's checkout panel shows, for any agent's workspace: the
**Changes** toggle next to Thread / Transcript in an agent tab (`ag-<id>`) and
on an agent's page (`#/agents/<id>`), and a **Changes** section in the PR
inspector for a row with a local worktree (branch, counts, **Open changes**
opens the panel as a `git-<workspace>` tab). `server/workspace-git.ts`,
`src/preview/GitPanel.tsx`.

- Top bar: the branch, ↑/↓ against its upstream ("not pushed" without one)
  and against its base, the PR on the branch; Pull (fast-forward), Push (sets
  the upstream when there is none), Create PR (title, description, Draft on
  by default; a branch with no upstream is pushed first), Stash (new files
  included) and Pop stash, which takes the newest stash made on this branch,
  never `stash@{0}` blindly (the stack is shared by every worktree), applies
  it by its sha and then drops that entry wherever it now sits.
- Side: the uncommitted files (staged or not, new ones included) with
  their counts; a click shows the file's diff (Monaco, side by side or
  inline) in the main column, a tick picks it. The commit box commits the
  picked files only (`git add` + `git commit -- <files>`), or everything
  when none is picked. Discard (one file's trash icon, or the picked ones)
  asks first, then restores them to the last commit and deletes new files.
- Unpushed commits: a click opens the commit (`gitcommit-<workspace>~<sha>`
  tab, file by file; inline on an agent's page).
- Live: the panel follows topic `workspace-git:<id>`; while someone watches,
  the server polls the worktree every 3 s (status, HEAD, stashes, changed
  files' mtimes) and sends `changed`, after which the panel reads again.
- Every write is your click: no MCP tool reaches these routes, so no agent
  pushes or opens a PR through them. Writes to one worktree run one at a
  time, and a path is always a file name, never a glob (`*` is a file
  called `*`).
- Paseo's checkout API (`client.checkout`: status, diff, commits, PR status,
  commit all, pull, push, PR, discard, stash) answers while the daemon is
  connected; git in the workspace does the rest and stands in when Paseo is
  down or errs (reads with `--no-optional-locks`). Git always handles a
  commit of picked files, a draft PR (`gh pr create --draft`), the stash
  list, Pop stash, and the commits list when Paseo's 10-commit page may hide more.
- Routes: `GET /api/workspaces/<id>/git/status|diff|diff/file?path=|commits|pr|commit/<sha>/refs|file|diff`,
  `POST …/git/commit {message, paths?}|pull|push|pr {title, body, draft}|discard {paths}|stash {action: save|pop}`.
  `<id>` is a Paseo workspace id, or `p.<base64url of the path>` for a
  worktree of a configured repo that no workspace holds; anything else is
  refused, as are paths outside the worktree.

### Files (a workspace's file explorer)

What the Paseo app's file explorer shows, for any agent's workspace: the
**Files** toggle next to Transcript / Changes in an agent tab (`ag-<id>`) and
on an agent's page (`#/agents/<id>`). `server/workspace-files.ts`,
`src/preview/FilesPanel.tsx`.

- Side: the workspace's tree, a folder read when you first open it (open
  folders and the picked file are kept per workspace). `.git` and
  `node_modules` are hidden until the eye button shows them; the filter box
  narrows the folders read so far; changed files carry their git letter
  (A / M / D / R, from the Changes panel's diff) and a folder holding one a
  dot. The tree reads again when the workspace's git moves.
- Main column: the picked file in Monaco, language from its extension,
  read-only. **Edit** makes it editable; **Save** (or ⌘S) writes it over
  the version you read, **Revert** drops your edits. An image shows inline,
  a binary file or one over 2 MB shows a note instead.
- Live: the open file follows topic `workspace-file:<id>:<path>` (Paseo's
  file subscription, else a 1 s stat poll). Unedited, it reloads in place
  when it changes on disk; edited, a banner says so with **Reload** (drops
  your edits) or **Overwrite with mine**. A save over a file changed since
  you read it is refused the same way (409), never written blindly.
- ⌘P in the Files view you clicked last goes to a file of that workspace
  (`git ls-files`, tracked and untracked; a walk past `.git` and
  `node_modules` outside git), ahead of the work's PR quick open.
- In a work, the ↗ button (or a double click in the tree) opens the file
  as its own tab, `wsfile-<workspace>~<path>`, with the same Edit / Save.
- Paths: relative only, no `..`, and the real path (symlinks followed) must
  stay inside the workspace, checked by coco before Paseo or the file system
  is asked; nothing is written inside `.git`. Paseo's file API
  (`listDirectory`, `readFile`, `writeFile`, `subscribeFile`) answers while
  the daemon is connected, the file system otherwise.
- Routes: `GET /api/workspaces/<id>/files/list|read|stat?path=`,
  `GET …/files/tree`, `POST …/files/write {path, content, expectedModifiedAt, expectedRevision?}`
  (409 `{conflict, modifiedAt}` when the disk moved on). Writes are your
  click only: no MCP tool reaches these routes.

### Terminal (a workspace's terminals and scripts)

What the Paseo app's terminal panel shows, for any agent's workspace: the
**Terminal** toggle after Changes and Files in an agent tab and on an agent's page,
and **Terminals** in ⌘K inside a work, which opens the work's Plan
workspace's terminals as a `term-<workspace>` tab (the Plan workspace is made
on first use, as a read-only dispatch makes it). `server/workspace-terminals.ts`,
`src/preview/TerminalPanel.tsx`, `src/preview/Xterm.tsx`.

- Sub-tabs: the workspace's Paseo terminals, each named by the title its
  shell set (a dot while busy), kept live from Paseo (`observeTerminals`).
  **New terminal** opens a shell in the workspace's directory; **Kill** asks
  first, then kills the shown one.
- The shown terminal is xterm.js, loaded on demand in its own chunk: it opens
  on the terminal's screen and scrollback as Paseo keeps them, then follows
  its output; keys go back in order (what is typed during a request goes in
  the next one), and its size follows the panel (Paseo resizes the shell, so
  the Paseo app sees the same size).
- Scripts (side): the workspace's Paseo scripts with their status (green
  running, amber unhealthy, hollow stopped, exit code on hover), a link to the
  port while running, **Start** / **Stop**, and the terminal icon opening the
  script's output as one more sub-tab (closing it leaves the script running).
  A `p.<path>` worktree has no scripts, and Paseo opens no new terminal there.
- Every action is your click: no MCP tool reaches these routes.
- Live: topic `workspace-terminals:<id>` sends `terminals` on every change and
  `scripts` when their status moves (polled every 4 s while watched); topic
  `terminal:<id>:<terminalId>` sends `reset` (the screen so far) then
  `output`, base64, and `exit` once Paseo stops streaming it. Both ride the
  page's one event stream: there is no WebSocket upgrade on coco's server.
- Routes: `GET /api/workspaces/<id>/terminals|scripts`,
  `POST …/terminals {name?, rows?, cols?}`, `POST …/terminals/<tid>/input {data}|resize {rows, cols}|kill`,
  `POST …/scripts/<name>/start|stop`, `POST /api/works/<slug>/plan-workspace`.
  A terminal id must be one of the workspace's terminals or a script's
  output, a script name one the workspace lists; input is capped at 64 KB a
  request. With Paseo disconnected the routes answer 503.
- Guard: besides the Host check of every route, these routes and
  `/api/events` (which carries a terminal's output) refuse a foreign
  `Origin` on reads too, not only on writes.

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

`#/waiting` (sidebar, count badge) lists everything that stops until you answer, grouped by work then PR: open cards (a choice's options and a confirm's Approve / Reject as buttons), Paseo permissions of coco's agents (a tool to allow, a plan, a question; answered in place), suggestions with an open Approve (a ready commit names its subject), Ask chats and cc-group threads whose agent ended its turn with the last word, and **done** agents: any other agent coco started or links (a dispatch, a New agent, a setup, a ritual, a hand-off's successor, an agent linked to a PR row) that is idle in Paseo with the last word in its timeline, opened in its work's tab (`#/work/<slug>/ag-<id>`) or its own page (`#/agents/<id>`), with **Archive** next to Dismiss (archived through coco, so its cards are kept as when coco archives an agent itself). Each row shows the agent's last message, a one-line reply box that goes to the agent, and Dismiss. Tick rows for **Dismiss selected** or **Send 'go' to selected**; a row without that action is skipped. Dismissing a chat, thread or done agent only hides it until the agent speaks again (`data/waiting-acks.json`); having that chat, thread or agent tab or page on screen does the same, since you read its last word (a tab kept in the background, a hidden pane or a hidden browser tab does not count until it shows), and a last word left two days unanswered drops out on its own (cards and permissions stay until answered); dismissing a card or an Approve is the usual dismiss. Nothing acts without a click.

One definition, every count. This list is the only source of "waiting on you": the sidebar badge, the status bar's "N waiting on you" (in a work, that work's items; its popover answers permissions in place and opens the rest), the dock and menu bar badge of the desktop app, the Dashboard and Agents page tiles, a work's Overview block, Waiting tab and tree counts (per PR), the Stack's agents column, and an agent's "waiting on you" state (its dot, tab icon, header and inspector) all read it. Each item names its agent and work. One thing counts once: a question an agent asks through Paseo (AskUserQuestion, or its `ask` call held for approval) while it has a card open is the card; an agent held on a permission or a card is not also listed as waiting for your word on its last turn; a thread with an open card is the card; an Ask or thread agent is never also a done agent.

On the Agents page (`#/agents`) the Waiting on you tile is that count, the section under it shows the first items, and each agent row with items carries "N waiting on you": a click opens `#/agents/<id>/waiting`, the agent's page scrolled to its first open card or permission.

`server/waiting.ts`: `GET /api/waiting`, `GET /api/works/<slug>/waiting` (`{ items, count, byAgent, byWork }`; items `{ id, kind: card | permission | approve | thread | ask | agent, agentId, work, pr, key, title, excerpt, at, link, actions[] }`; an action is the endpoint a button calls; `byAgent` and `byWork` count the items per Paseo agent id and per work), `POST /api/waiting/ack { ids }`, `POST /api/agent-chat/<id>/archive`, and the SSE topic `waiting` (recomputed on card, thread, Ask and permission changes and when a tracked agent starts or ends a turn, cached like `swr.ts`). Done agents come from `server/finished-agents.ts`: Paseo's live agent list (kept by `permissions.ts`), the last message read from the tail of the agent's timeline and fetched again only once the agent was updated, at most 40 agents updated in the last two days. A done one-job agent (labels `kind` review-plan, dispatch, gate, review or stack-fix; idle, no open card or permission, not an Ask chat nor a hand-off's successor: `autoArchivable` there) carries `autoArchive: true` in its work's agent list and `GET /api/agent-chat/<id>`; its chat shows "Archiving in 30 s", counted only while that card is on screen, with Cancel, then calls `POST /api/agent-chat/<id>/archive`. `POST /api/agent-chat/<id>/unarchive` brings an archived agent back (the daemon's `refreshAgent`, the Paseo app's Unarchive), behind the Restore button of an archived agent's header.

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
with `git show`/`git ls-tree`, with the `paths` of `repo.tsconfig`. It uses
the repo's own `node_modules/typescript`, else coco's, so a clone without
`npm install` still navigates. One service lives at a time, for the last head used; it starts on the first
open of a file (about 7 s of indexing, RSS 2.6 to 3 GB), is replaced when
another head is asked for, and is killed after 15 minutes idle. A crash puts
that sha on a 60 s cooldown.

The `nav` chip in a code tab shows `indexing…`, `nav ready`, `nav idle` or
`nav error` (hover for the reason, files named from the repo root). While the service is not ready, or when
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
- Planned rows: each work read asks GitHub (cached 60 s, one query per repo)
  for an open or merged PR on each planned branch. A row whose branch got one
  (its agent opened it) takes that number, logged on the timeline. What was
  kept under `b:<branch>` moves to the number: comments, review plan and
  runs, threads and groups, briefs, kit pieces, jobs, linked agents, Ask
  conversations and cards. Agent labels and open tabs still naming
  `b:<branch>` resolve to the number. A `propose_stack_edit` that gives a
  planned row its PR moves the same way.
- Landed rows, in a repo whose `land` setting is `"main"` (the cocopilot
  repo; others ship rows as PRs): a planned row shipped straight to the
  default branch, with no PR, reads **landed** (merged colors) everywhere a row's state shows, and
  gets no PR nudges. Its agent says so with the MCP `mark_row_landed` right
  after it fast-forwards the branch, you with **Mark landed** in the PR
  details (at the default branch's tip), and each work read sees it on its
  own (cached 60 s): a planned branch, other than the default one, that moved
  since it was created and whose tip sits on the default branch. **Undo**
  keeps it planned for good (`stack[i].landed: null`). `POST
  /api/works/<slug>/landed { row: <order|branch>, sha?, by, clear? }`.
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
  topic's replay (a chat replays its timeline as one `history` event, cards
  come on subscribe). An idle or archived agent's replay is kept in
  `data/chat-snapshots/<agent>.json` with its last timeline cursor, written
  when a coco agent ends a turn or on its first open: the tab shows it at
  once, and when Paseo's `updatedAt` moved, reads only the entries after the
  cursor and sends `history` again (the whole timeline when Paseo rebuilt it).
  Archiving or deleting a work drops its agents' snapshots, as does opening an
  agent Paseo no longer knows.
  The
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

A choice card can draw its options: each option may carry a Mermaid
`diagram`, and the card one of today. Options with diagrams sit side by side
(up to three columns, stacked in a narrow pane), each with a small preview a
click opens full screen (zoom, pan); today's diagram sits above them.
**Compare** opens today and every option's diagram full screen, side by side
at full size, each headed by its option and consequence (a click on the
header picks it; Esc closes). Agents are told
to draw the options of an architecture or flow choice (12 nodes at most, the
same layout across options), not every choice. The Waiting page and the
waiting popover show such a card's "N diagrams" chip, not the diagrams.

You can also just write to the agent: every agent view has a composer (agent
tabs, `#/agents/<agentId>` for agents outside a work, Ask, threads). A message
sent there (or a Waiting-page reply to an Ask chat) closes the agent's open
cards as **answered in chat**: they stop waiting on you and leave the
waiting counts, nothing extra is delivered (your message is the answer; coco
agents are told so in their system prompt). A message in a thread closes only
that thread's cards; a message to a group agent's transcript leaves its
thread cards open. The composer notes "A message answers its open cards"
while some are open. **Dismiss** is not a silent stop: the agent is told
"The user dismissed this card without choosing. Continue with your
recommendation if it is safe; otherwise stop and say what is left."

An agent archived outside coco (by hand in Paseo) takes no message, so its
plain open questions close as **agent archived** (nothing delivered) and
leave the waiting counts: when Paseo reports it archived or closed, when it
drops from the live agent list and is found gone, and in a sweep of every
open card's agent at boot and every 10 minutes (an unreachable daemon leaves
them open). A hand-off closes the old agent's plain questions the same way
once it is archived. Other cards stay open: a proposal (coco applies it, not
the agent), a thread's card (answered through its thread), and every card
of an agent coco archived itself (an Ask conversation parked or closed,
whose answer revives it; a one-shot run such as a rules proposal; a gate
run).

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
`upsert_finding`, `upsert_decision`, `attach_media`, `import_artifact`,
`mark_row_landed` and `set_next`, each defaulting to the agent's work and row; the HTTP routes stay
for you, scripts and sessions without the MCP.

When you ask any coco agent for a change to coco itself ("read local head, not
origin"), it calls `flag_coco_issue` instead of saying another session owns it:
a finding with no file or line lands on the cocopilot work's first row (the work
whose repo is `cocopilot`, or `cocoWork` in the config) with your words, the
agent and work that raised it, and the agent answers with its link
(`#/work/<slug>/findings-<row>/f-<id>`, opening the Findings tab on it). The same
title updates the finding. Nothing is dispatched until you accept it: then its
fix agent starts in the cocopilot repo like any accepted finding; stack fix
runs skip these findings.

### Screenshots (agents see coco)

Agents check a UI change themselves instead of asking you to reload: the
`screenshot` MCP tool renders a page in a headless Chrome and hands the agent
the PNG plus the page's console errors (every agent's system line says to use
it before reporting a UI change). It takes a coco hash path
(`#/work/<slug>/review`) or a full URL on `127.0.0.1`/`localhost` (a dev
server, or an agent's own server copy on another port, the way to see a
worktree's build), a viewport (default 1600×1000), `waitMs`, a `selector` to
wait for and crop to, `eval` JS run first (click a tab) and `colorScheme`
light or dark. Other hosts are refused unless listed in `screenshot.hosts`.
The same capture is `GET /api/screenshot?url=%23%2Fagents&w=1200&h=800`
(image/png, `X-Console-Errors` the error count; `&json=1` for
`{ png: base64, errors, … }`), handy from a script or the browser; `selector`
and `eval` go only by `POST /api/screenshot` with a JSON body (the tool's
way), and a request another site's page sends (`Sec-Fetch-Site` other than
same-origin or none) is refused, so no web page can run JS on coco. coco keeps
one Chrome for all captures (a fresh tab each), started on the first one and
closed after 5 idle minutes or when the server stops; set `screenshot.chrome`
when Chrome is not at the macOS default path.

### Browser host (agents' browser tools without the Paseo app)

Paseo gives agents `browser_*` tools (new tab, navigate, snapshot, click, fill,
type, keypress, screenshot, evaluate, logs…), run by a browser host: normally
the Paseo desktop app, so with the app closed they fail with "no browser
automation host". With `browserHost: "auto"` (the default) coco checks every
15 s: while no Paseo app process runs, it registers itself as the host on its
own daemon connection and runs every command in a headless Chrome of its own
(not the screenshot one), one tab per `browser_new_tab`, kept per workspace (an
agent sees only its workspace's tabs; a request with no workspace reaches
none) in one browser context per workspace (cookies and storage apart, dropped
with the workspace's last tab), refs `@e1…` from the latest snapshot. Only
http(s) pages open (no `file://`, `chrome://`), never coco itself: every
request that Chrome makes to coco's hosts (127.0.0.1, localhost, [::1], 0.0.0.0
on coco's port, 8777 and 8778; `baseUrl` and `hosts` on any port) fails,
redirects, frames, popups and workers included, and coco's API refuses a
request carrying the `CocoAgentBrowser` User-Agent its tabs send. `upload` takes
files inside the agent's workspace only (symlinks followed). Dialogs are
accepted and reported with the command. The daemon sends a new tab to the most recently registered host, so
coco never registers while the app runs: once the app is back coco keeps
serving its open tabs, then steps down when they are closed. Tabs untouched
for 30 min close. One coco server hosts at a time (a pid lock in the temp
directory). `GET /api/browser` tells whether coco hosts and why, with its tabs.
An agent tab shows a Browser view next to Transcript while that agent has a tab
in coco: what the tab shows, captured again every 3 s, read-only.
`browserHost: "off"` never hosts.

## Model, thinking and mode (composer)

Every agent composer shows, next to the paperclip, the model (Sonnet 5.5),
the thinking level (High, or the model's default) and an **auto** chip.
Each opens a small menu: the models Paseo lists, grouped by provider under
Paseo's name for it — first the providers your `models.default` and
`models.fast` use (`default` and `fast` tagged), then every other provider
Paseo has ready (another Claude login such as **Claude (Perso)** right after
Claude, then OpenCode…; a provider not ready or listing no model is left out)
— and the thinking levels of the picked model. The model menu lists the newest release
of each family (Opus, Sonnet, Fable, Haiku…), plus the defaults and your
current pick even when older; **Show all models** at its foot adds the older
releases and the 1M-context variants, and is remembered in this browser. An
agent coco starts runs in Paseo's auto mode, and a brief saying not to touch
code is what keeps one read-only; the New agent launcher (below) picks
another mode at start, and a live agent's mode chip switches it (below).

- **Mode of a live agent** (agent tabs and pages, an open Ask conversation):
  the chip shows the agent's current mode as Paseo reports it, read again
  each time you open it, and is a menu of the modes the agent can take (the
  ones New agent offers for its provider: Plan, Always Ask, Accept File Edits,
  Auto, Bypass). A pick switches the agent at once, its turn in flight
  included (Paseo's set-mode call), not from your next message.
  `GET|POST /api/agent-chat/<agent>/mode` (`{ mode }`, one of the agent's).
- **Slash commands**: `/` at the start of a live agent's composer (agent tabs
  and pages, an open Ask conversation) opens the commands and skills the
  agent's session loaded, filtered as you type; ↑↓ pick, ↵ or Tab inserts
  `/<name> `, Esc closes. `GET /api/agent-chat/<agent>/commands`.
- **Prompt recall**: ↑ in an empty composer brings back the prompts you sent
  that agent, newest first (its latest 30, in full), ↓ goes back down to an
  empty box. Text you typed is never replaced: recall only acts on an empty
  box or on a recalled prompt left unchanged. `GET /api/agent-chat/<agent>/prompts`.
- **Rename**: click the title in a live agent's header (or focus it and press
  ↵), edit it in place, ↵ saves and Esc leaves it. The name goes to Paseo (an
  agent coco started keeps its `coco · ` prefix there), the lists and tabs
  follow, and an Ask conversation keeps it for its next agent.
  `POST /api/agent-chat/<agent>/rename` (`{ name }`, at most 80 characters).

- Starting an agent (a new-agent tab, the Ask page and panels, Dispatch, a
  thread's first message): the pick goes with the start. Unpicked, Ask and
  general agents run on `models.default`; a persona review, review threads and
  the review plan on `models.fast`. The last pick per kind (ask, thread,
  dispatch-`<entry>`) is remembered in this browser.
- A live agent (agent tabs, an open Ask conversation): the pickers show its
  current model and thinking, and a new pick switches the agent in place from
  your next message (Paseo's set-model and set-thinking calls); a parked or
  closed Ask conversation takes it to the next agent it starts. A live agent
  never switches provider: an agent tab's model menu offers only its own
  provider's models.
- Picks are checked against `GET /api/models` (Paseo's list, cached 10 min,
  retried sooner after a failure): an unknown model or a thinking level the
  model lacks is refused before anything starts. Routes take `provider`
  (`<provider>/<model id>`) and `thinking`: `POST /api/ask`,
  `POST /api/ask/<id>/messages`, `POST /api/agent-chat/<agent>/messages`,
  `POST /api/works/<slug>/dispatch`; threads take `model` and `thinking`.
- The Ask agent's system prompt tells it to hand focused subtasks (a
  single-file read, a search, a per-file review) to subagents on the fast
  model.

## New agent (a free agent, as in Paseo)

`#/agents/new` starts any agent the way Paseo's new-agent screen does, so a
free Claude Code session no longer needs the Paseo app: a composer (paste or
drop screenshots and files), the model and thinking pickers, and a mode menu
with the modes Paseo lists for the provider (Claude: Plan, Always Ask, Accept
File Edits, Auto, Bypass), starting on the provider's own default (Claude:
Auto; Bypass is never preselected). **Runs in** picks where:

- a repo's clone, on the branch it is on (coco's own workspace there);
- a fresh worktree of a repo on a new `agent/<words>-<id>` branch off its
  default branch (a spare worktree when one is ready);
- a work's Plan workspace: the first message carries the work's facts after
  your words, and the agent lists among the work's agents;
- one of the work's open PRs (**Workspace**): its own worktree, the PR's brief
  in the first message, linked to the row like an agent started there in
  Paseo (counted as briefed).

On coco's own checkout the composer gets a short note, in plain sight and
editable, on this repo's workflow: commit on main, restart coco with
`POST /api/server/restart`, check the UI with the cocopilot screenshot tool.
**Start** shows the agent at once as starting, then becomes its page
`#/agents/<agentId>`. The last place and mode per provider are remembered in
this browser (`cc.newagent`), the model like any other composer.

Open it from ⌘K **New agent…** (in a work: on its Plan), the work Overview's
**New agent** menu (**Ask coco** as before, or **Agent**), a repo page, the
Agents page, or **Start an agent on it** under a coco issue Ask coco flagged
(`flag_coco_issue`): the launcher opens on coco's checkout with the issue as
the task, and you still press Start.

Routes: `GET /api/new-agent[?work=<slug>]` lists the places (with that work's
open PRs); `POST /api/new-agent` takes `place` (`{kind: 'repo'|'fresh', repoId}`,
`{kind: 'work', slug}`, `{kind: 'row', slug, key}`), `prompt`, `attachments`,
`provider`, `thinking` and `mode`, refuses an unknown place, an empty message,
an unknown model or a mode Paseo does not list, and answers `{agentId,
workspaceId, cwd, title}`.

## Schedules (Paseo's recurring runs)

`#/schedules` (sidebar, activity bar, ⌘K **Schedules** and **New
schedule…**) manages the schedules the Paseo app lists: kept by Paseo's
daemon, they run with coco closed, each tick starting a new agent with the
prompt (or, for a schedule made from an agent, sending it to that agent). A
row shows the name, the cadence in words (`every day at 07:00
(Europe/Paris)`, `on weekdays at 09:30`, `every 15 minutes`, `once, on 21 Oct
at 20:10` for a one-run timer, else the cron itself), the next run or since
when it is paused, the provider and model, the Paseo project its folder
belongs to, a worktree chip when each run gets its own worktree, and the last
run's result with **Agent** (`#/agents/<id>`). A click on the row opens its
prompt and runs, newest first, each with its output, error, duration and
agent.

- **Pause** / **Resume**; **Run once** (after an in-app confirm) runs it now
  without touching its cadence; **Delete** (in-app confirm, danger) drops the
  schedule and its logs, never the agents its runs started.
- **New schedule** and the pencil (`#/schedules/new`, `#/schedules/<id>/edit`)
  share one form: name, prompt, cadence (**At a time**: a time on every day,
  weekdays, weekends or one week day; **Every** n minutes, hours or days;
  **Cron**: five fields, 0 is Sunday; a time zone for the first and last,
  the browser's by default), the agent's model, thinking and mode from the
  model picker (every Paseo provider, `claude-perso` included), the Paseo
  project or another folder it runs in, and a new worktree per run. A
  schedule made from an agent only changes its name, prompt and cadence.
  Nothing runs on create: the first run comes at the next tick.
- Rituals stay coco's own one-off launches. A ritual's **Schedule…** button
  (or **Start from a ritual** in the form) opens a new schedule with that
  ritual's prompt and title, `{briefsDir}`, `{owner}` and the fields filled
  on the Rituals page filled in; a placeholder left over is flagged, since a
  run fills nothing in.

Routes (server/schedules.ts, through the Paseo client): `GET /api/schedules`
(`schedules` with each one's last run, `projects`, `rituals`), `GET
/api/schedules/<id>/logs`, `POST /api/schedules`, `PUT /api/schedules/<id>`,
`POST /api/schedules/<id>/pause|resume|run-once`, `DELETE
/api/schedules/<id>`. A body is checked first: a prompt up to 50 000
characters, a one-line name, a cron Paseo parses with a time zone the system
knows, an interval from a minute to a year (sent as cron when it maps
exactly, as `paseo schedule --every` does), a `<provider>/<model>` the model
picker offers with its thinking level and mode, an existing absolute folder;
an unknown id is a 404, a refusal from Paseo a 409, Paseo away a 503.

## Hand off (a fresh agent takes over)

When an agent's context fills up, **Hand off** in its header (a work's `ag-`
tab or `#/agents/<agentId>`) passes its task to a new agent without the Paseo
app. The button is always there on a live agent, amber once its context ring
is amber (70%), red from 90%. Its dialog takes an optional note for the new
agent and the model, thinking and mode (the old agent's by default).

1. **Briefing**: coco sends the old agent a `[coco hand-off]` message asking
   for the paseo-handoff skill's briefing (Task, Context, Relevant files,
   Current state, What was tried, Decisions, Next steps, Open questions,
   Constraints) between `<handoff>` tags as its whole reply, your note
   included. If no such reply comes within 5 minutes (or the agent is
   archived), coco writes the briefing itself from the last 16 owner and
   agent messages of its transcript, so the hand-off still happens. The
   briefing is saved as `data/handoffs/<old agent>.md`.
2. **New agent**: starts in the same workspace and directory, with the same
   labels (work, PR, kind; an Ask conversation's agent becomes a plain agent
   of its work), linked to the same PR row when the old one was, with the
   briefing and your note as its first message.
3. **Done**: the old agent is archived once idle (forced after a minute), and
   the page moves to the new agent.

The dialog shows these steps while they run; it can be closed, and the header
then shows **Handing off…**. Afterwards the old agent's header links
**Handed off to <title>** and the new one's **from <title>**. One hand-off per
agent; a failed one (shown as **Hand-off failed**, its error on hover) can be
tried again. A coco restart during the briefing fails the hand-off; one
during the new agent's start looks that agent up in Paseo (its title and
labels, created since): found, the hand-off is done; none, failed; Paseo
unreachable, it stays starting and a retry is refused until Paseo answers,
so no second agent starts. Routes: `POST /api/agent-chat/<agentId>/handoff` (`note`,
`provider`, `thinking`, `mode`) starts it and answers at once;
`GET /api/agent-chat/<agentId>/handoff` → `{ to, from }`, kept in
`data/handoffs.json` (`server/handoff.ts`).

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

## Dictation (voice into any composer)

Every composer with a text box (agent tabs and pages, Ask, threads, New
agent) has a mic next to the paperclip. Click it, or press ⌥Space in the
box, and speak: the transcript so far shows live at the cursor, between the
text before and after it, the box read-only meanwhile. Click again, Esc or
⌥Space stops; holding ⌥Space past half a second talks until you release it.
The final text stays in the box for review: nothing is sent, and Send waits
until dictation stops.

It is Paseo's own speech to text, the one its app's mic uses (Paseo
settings, Dictation: `features.dictation` in `~/.paseo/config.json`, a local
Parakeet model by default). The page captures the mic as 16-bit mono PCM
(16 kHz, or the browser's rate, which the daemon resamples) and posts
quarter-second chunks; coco relays them on its daemon connection:
`GET /api/dictation` (`{ available, reason }` from the daemon's
`capabilities.voice.dictation`), `POST /api/dictation { id, rate }`,
`POST /api/dictation/<id>/audio { audio }` (base64, at most 136 KB, an even
byte count), `.../finish` → `{ text }`, `.../cancel`. The transcript so far
comes back on topic `dictation:<id>` (`partial`, then `final` or `failed`).
At most 4 run at once; one fed no audio for 30 s, or running 10 min, is
stopped.

When Paseo is away or its dictation is off, Chrome's own speech recognition
stands in (the mic's tooltip says so); the desktop app has no such fallback
(Electron lacks Google's speech keys), so the mic is disabled there with the
reason as its tooltip. A failure shows under the box, never silently. The
desktop app grants the microphone to coco's own origin only, audio only,
after macOS asks once (`NSMicrophoneUsageDescription` in the packaged app:
rebuild it with `npm run install-app` in `desktop/`). Reading replies aloud
is not offered: Paseo speaks only inside its voice mode, which drives an
agent turn by turn, not as a standalone text to speech.

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
    group. A link to another tab keeps a maximized group maximized; `/max`
    on the current tab's hash turns maximize on or off.
    `#/work/<slug>` restores the saved layout. The layout tree (splits,
    sizes, groups, focus, max) is saved per work in `localStorage`
    `cc.wb.<slug>`; the older two-group format is migrated on load.
  - Inspector (right panel, `Cmd/Ctrl+I` or × hides it): it follows the
    focused group's active tab, its bar naming what it shows. `review-<n>`:
    a one-line PR header (#n, state and CI chips, the current milestone or
    "all clear", Details opens `pr-<n>`) over the review plan and activity feed,
    and the Review tab drops its own activity pane so the diff takes the
    width. Remarks and watch points in this feed stay one-line cards (status,
    severity, file and lines, first line, the state of their agent); a click
    opens that Review tab at the line, where the remark and its thread live.
    `pr-<n>` (the details already fill the tab): the same plan and feed, the
    one thing the tab lacks. Agent tabs (`ag-…`, `ask-…`): status, model,
    usage, the PR it works on, its open questions with a jump to the oldest,
    Open in Paseo. `diff-`, `file-`, `findings-<n>`, `brief-<n>` and
    `ask-new-<n>`: that PR. Findings and Decisions: the PR of the selected
    item. Anything else, or a whole-work item: the PR selected in the Stack.
    Hidden, or with details as tabs (narrow window, "PR details: Tab"), the
    Review tab shows its activity pane again.
  - Sidebar: under an expanded work, an **Overview** group (its label opens
    `plan`, its caret folds it) holds Stack, Findings, Decisions, Timeline,
    Notes and Artifacts, the running or failed command jobs, and the agents
    tied to no PR. Below it, one row per open PR in stack order (caret, `#n`,
    title, current milestone chip, state dot, a spinner while a job or an
    agent works on it, the orange count of agents waiting on you); a click
    opens `pr-<n>`, the caret unfolds Review code (`review-<n>`), Findings
    (`findings-<n>`, open count) and the PR's agents; a planned row reviews
    its local branch (`review-b:<branch>`) the same way. Merged and planned PRs
    fold into two lines at the end ("2 merged", "25 planned"); a folded line
    or group keeps the spinner and waiting count of what it hides. Agents
    show status dots (blue working, orange waiting, green done, red failed,
    grey archived), archived ones behind a fold; a group's archive button
    archives its idle agents (two clicks), + or New agent opens `ask` or
    `ask-new-<n>`. The focused tab's PR unfolds by itself and folds back when
    the focus leaves it, unless toggled by hand; what is folded is kept per
    work in `localStorage` `cc.dp.tree.<slug>`. Off the work's page, PR rows
    come from its agents only.
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
- Agents: live list with log on tap and a **Chat** button per agent;
  workspaces.
- Agent (`#/agents/<agentId>`): any Paseo agent as a chat, one outside a
  work included (a ritual, a persona refresh, one started in Paseo): the
  agent tab's header (status, usage, context ring, Open in Paseo, **In its
  work** when it has a work label) over its transcript, permissions, cards
  and composer (attachments, model and thinking switch, Stop). Reached from
  Chat on the Agents page, the Dashboard's agent rows, a ritual's history
  row, a job of no work and the Waiting page link of a card whose agent has
  no work. `GET /api/agent-chat/<agentId>` gives its title, kind, work, PR,
  status, model, thinking, open cards and usage; the page polls it every 5 s.
- Rituals: one form per entry of `rituals` in the config; a launched one's
  history row has Chat; **Schedule…** turns the ritual into a Paseo schedule.
- Schedules (`#/schedules`): Paseo's recurring runs, see
  [Schedules](#schedules-paseos-recurring-runs).

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
