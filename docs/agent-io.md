# Agent I/O: one way to show things and ask things

Every coco agent talks to the user through one channel: **cards** it posts with
the `cocopilot` MCP tools, drawn by one renderer in every agent view.

## Decisions

1. **Non-blocking asks.** `ask` returns at once with the card id. The agent ends
   its turn or keeps working. The answer reaches it as a new user message
   (steered into the running turn when it is mid-turn). Same path for every
   agent kind; survives finished turns and coco restarts.
2. **MCP for every coco agent.** The `cocopilot` MCP server is mounted on every
   agent coco starts (Ask, review plan, review, fix, stack fix, dispatch,
   gates, threads), its tools preapproved. HTTP write routes stay for humans,
   scripts and non-coco sessions.
3. **One ask path.** Proposal cards (`propose_*`), thread reply `choices` and
   Paseo `AskUserQuestion` all fold into cards. `AskUserQuestion` is disabled
   for coco agents.
4. **Shapes:** single or multi choice, row-select table, short form,
   confirm/approve, plus `post` (show only, no answer).
5. **Input** (paste/drop images and files in the composer, via Paseo
   `images`/`attachments`) is the next slice, not this one.
6. **Subagents come from Paseo.** What an agent starts itself (Claude's
   `Agent`/`Task` tool) is shown from Paseo's provider subagents (list, status,
   timeline), read-only; coco keeps no record of its own (guide: Subagents).

## Slices

1. Cards end to end: store, routes, MCP `ask` + `post_blocks`, answer delivery,
   MCP on every agent, `AskUserQuestion` off, renderer in every agent view.
2. Fold the old paths: `propose_*` become `confirm` cards whose approval runs
   the side effect; thread `choices` become `choice` cards; MCP
   `upsert_finding`, `upsert_decision`, `attach_media` replace curl in skills.
   - [x] Part A: `propose_work_scaffold`, `propose_paseo_agent`, `dispatch`
     and `propose_repo` post `confirm` cards carrying an `action` (below)
     that coco builds and runs on approval, the outcome on the card and in
     the answer; `propose_rules` is a Keep / Drop rows card writing the kept
     rules; `propose_review_plan` stays the plan run's result. The old
     `Proposals` cards, their `/api/ask/<id>/apply|start-agent|dispatch|add-repo`
     routes and the captured `submitted` calls go; the Ask stream carries
     the conversation's cards.
   - [x] Part B: thread agents ask with `ask` and the thread's key instead
     of the reply `choices`; the old click semantics are option `effect`s
     (below); answers go through the thread; the thread view draws its
     cards and its composer takes attachments. The reply JSON keeps
     `blocks` and `finding`: it is the turn's answer, tied to the message it
     answers and read at turn end, so moving it to `post_blocks` would lose
     that pairing for no gain. Replies stored with `choices` show them
     read-only.
   - [x] Part C: MCP work writes (`upsert_finding`, `upsert_decision`,
     `attach_media`, `import_artifact`, `set_next`, below), skills and briefs
     lead with them and keep curl for sessions without the MCP; uploads never
     sent are swept after 24 h.
3. [x] Multimodal input in the composer: paste, drop or pick images and
   files; `POST /api/uploads`, ids on the message, Paseo `images` and
   `uploaded_file` attachments, files shown on the user message.

## Card

```ts
type CardKind = 'post' | 'choice' | 'rows' | 'form' | 'confirm';
type CardOption = { key: string; label: string; details?: string; consequence?: string /* ≤ 200, one line: what happens, the risk */; recommended?: boolean; confidence?: number; effect?: CardEffect };
type CardEffect = { type: 'take_decision'; option: string } | { type: 'dismiss_finding' };  // thread cards, single choice only
type CardField = { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'select' | 'toggle'; options?: string[]; default?: string | number | boolean; required?: boolean; placeholder?: string };
type CardRow = { key: string; cells: Cell[]; recommended?: string | boolean };

type Card = {
  id: string;
  agentId: string;
  work: string | null;            // work slug from the agent's labels
  pr: string | null;              // stack row key from the agent's labels
  kind: CardKind;
  title: string;                  // short plain text, ≤ 120
  question?: string;              // ≤ 500, inline markup
  blocks?: Block[];               // context: the typed blocks of server/blocks.ts
  // choice
  options?: CardOption[];         // 2-8
  multi?: boolean;
  // rows
  columns?: string[];             // 1-8
  rows?: CardRow[];               // 1-40
  select?: 'many' | 'one';        // tick rows (default many)
  rowOptions?: CardOption[];      // instead of ticks: one pick per row (decision-style), 2-4
  // form
  fields?: CardField[];           // 1-8; a confirm card may carry 0-8, sent with the approval
  // confirm
  confirmLabel?: string;          // default "Approve"
  rejectLabel?: string;           // default "Reject"
  other?: boolean;                // free-text "Other…" box, default true for choice/rows/confirm, false for form; stored resolved
  action?: CardAction;            // a proposal card: what answering it runs
  thread?: string;                // the thread key it asks in (a thread agent's card)
  status: 'open' | 'answered' | 'cancelled';   // post cards are 'answered' at birth
  createdAt: string;
  answer?: CardAnswer;
  result?: CardResult;            // what the action or the picked option's effect did, before delivery
  delivery?: { at: string; ok: boolean; error?: string; skipped?: boolean };  // skipped: nobody waits (a one-shot run)
  archived?: string;              // when it closed (status 'cancelled') because its agent was archived
};

type CardAnswer = {
  at: string;
  picked?: string[];                       // choice: option keys
  rows?: string[];                         // rows with select: ticked row keys
  rowPicks?: Record<string, string>;       // rows with rowOptions: row key -> option key
  values?: Record<string, string | number | boolean>;  // form, or confirm fields on approval
  approved?: boolean;                      // confirm
  other?: string;                          // free text, alone or alongside
};

type CardAction = { type: 'work_scaffold' | 'stack_edit' | 'paseo_agent' | 'dispatch' | 'repo' | 'rules'; input: object };  // input as checked by coco
type CardResult = { at: string; ok: boolean; detail: string; link?: string };  // link: #/work/<slug>, #/work/<slug>/ag-<agent>, #/repo/<id>, #/work/<slug>/rules
```

### Proposal cards

A card posted with an `action` is built by coco, not by the agent: the action
checks its input (a refusal names the field), then makes the card that shows
it. On answer, a `confirm` card runs its action only when approved, a `rules`
card when a row is picked; the outcome becomes `result` (a throw is
`ok: false` with the error) and is part of the answer the agent gets.

| `action.type` (tool) | Card | Approve runs |
| --- | --- | --- |
| `work_scaffold` (`propose_work_scaffold`) | confirm "Create work: …" or "Update work: …" for an existing slug; summary as question; blocks: slug, tier, Paseo project and personas, an "already exists" callout, tables for the planned stack, surfaces, open questions and flags, notes as code, next steps; a `replaceStack` toggle when the work already has a stack | writes the work like the old Apply, scope repo taken from the Ask conversation; link to the work |
| `stack_edit` (`propose_stack_edit`) | confirm "Edit stack: <work> (N changes)"; why; the stack after the ops (row, title, reviewers, Notion page, added/updated/moved/kept), removed rows as a callout; a `syncNotion` toggle when the work has a linked page; no ops + `syncNotion` is a "Sync Notion: <work>" card | applies `ops` (`add` after a row or `start`, `update` fields or move, `remove`) to the current stack, untouched fields kept; then the work's Notion sync when ticked (one work page, never a page per row); link to the work |
| `split` (`propose_split`) | confirm "Split #N into K: <work>"; why; table of the K rows in order (PR or planned branch, title, GitHub base, files, Notion page), a note for the row after the split, callouts for an original no part reuses and for planned rows; toggles `notionRows` (linked work only) and `bodies`, both default on | one step each, reported in the result: `stack` (the original row replaced in place by the parts, every other row and field kept, the first part takes the original's Notion page, all inherit its reviewers; skipped as "already split" on a retry), `base #N` per part PR (`gh pr edit N --repo <github> --base <prev part branch>`, the first on the row below or the default branch, the row after the split on the last part; skipped when already right), `notion` (the work's sync also creates child pages for the new rows and links them), `body #N` (a `dispatch` card of the kit-body gate per part PR, none started). `ok: false` if any step failed; approve a new `propose_split` with the same parts to redo what failed; link to the work |
| `pr_reply` (`propose_pr_reply`) | confirm "Reply to <author> on #<pr>" (or "Comment on #<pr>" without `replyTo`); why; the comment answered as a callout; the draft in an editable `body` textarea; a `resolve` toggle for a review thread; **Post reply** / **Drop**; refused when `replyTo` is not a comment of that PR | posts the edited text with gh as a reply in the thread (else a PR conversation comment), then resolves the thread when ticked; link to the posted comment |
| `paseo_agent` (`propose_paseo_agent`) | confirm "Start agent: …"; why; model, thinking, workspace and work line; the brief as code (cut at 4000, the agent gets all of it) | starts the agent, logs it on the work's timeline; link to its `ag-` tab |
| `dispatch` (`dispatch`) | confirm "Dispatch <entry> on <PR>"; refused without a work (the conversation's, `workSlug`, or the agent's label) | the catalog dispatch; link to the started agent |
| `repo` (`propose_repo`) | confirm "Add repo <source>"; what adding does | adds the repo (clone, config, Paseo project, setup run); link to its page |
| `rules` (`propose_rules`) | rows, one per candidate, `rowOptions` Keep (recommended) / Drop, target scope taken from the Propose rules run; an empty list is a `post` card "No new rule" | writes the kept rules as `kept` |

### Thread cards

A thread agent (decision, plan or finding thread, `server/threads.ts`) asks
with `ask` and `thread: "<key>"`, the key its prompt names (a card without
one goes to the one thread waiting on the agent, if exactly one). coco
refuses a key that is not a thread of the posting agent's group. The card
shows in the thread, and its answer or dismissal goes through the thread
(`dispatch` with the delivery text, the message tagged `card: <id>`), so the
log records it and the agent's next reply; it only reaches the agent that
asked, `delivery.ok: false` once that agent is gone, never a new one.

A choice option may carry an `effect`, checked against the thread's subject
when posted (a refusal names `options[i].effect`):

| `effect.type` | Allowed on | Picking it |
| --- | --- | --- |
| `take_decision` | a decision thread, `option` a key of that decision (one without rows) | takes the decision on that option, rationale `Picked <label>[: <details>]` |
| `dismiss_finding` | a finding (comment) thread | dismisses the finding, reason `Picked <label>[: <details>]`, so the option's details carry the why later agents read |

Effects need a single choice card. On answer the effect runs, leaves a
system note in the thread (tagged with the card) and its outcome as
`result`; when it succeeds and the answer carries no `other` text, nothing
is sent: `delivery: { ok: true, skipped: true }`. Otherwise the answer goes
to the agent as usual, with `Done:` or `Failed:`.

Conversations saved before cards keep `proposal`, `agentProposal`,
`dispatchProposal`, `repoProposal` in their JSON: read as `proposed: { kind,
title }` for the lists, and the transcript shows the old tool call
read-only.

Validation lives on the server (`server/cards.ts`), reusing `server/blocks.ts`
for `blocks` and cells. A `choice` answer needs ≥ 1 pick or `other` (one pick
at most unless `multi`); `one` row select needs exactly one row (or `other`
alone); `rowOptions` needs ≥ 1 row pick or `other`; required fields need a
value (on a `confirm`, only to approve); `confirm` needs `approved` or `other`. Option, row and field keys are
short ids (`[\w.:~-]{1,60}`), unique per card. A `post` card needs `blocks`.
Cards are stored one JSON file each under `<dataDir>/cards/`.

## Routes

- `POST /api/cards` body `Card` minus `id/status/createdAt/answer/delivery`,
  `agentId` required → `Card`. Used by the MCP server. With `action: { type,
  input }` the rest of the body is ignored: coco builds the card.
- `GET /api/agent-chat/<agentId>/cards` → `Card[]` oldest first.
- `GET /api/cards/<id>` → `Card`.
- `POST /api/cards/<id>/answer` body `CardAnswer` minus `at` → `Card`. Stores the
  answer, then delivers it.
- `POST /api/cards/<id>/cancel` → `Card` (user dismisses an open ask; the agent
  is told it was dismissed and to go on with its recommendation if safe, see
  Delivery).
- Answered in chat: when the owner writes to the agent instead of answering
  (`POST /api/agent-chat/<agentId>/messages`, `POST /api/ask/<id>/messages`
  for every agent of the conversation, `POST /api/works/<slug>/threads/<key>`
  for that thread's cards only), its open cards outside threads (in a thread:
  that thread's) become `status: 'answered'` with `answer: { at, chat: true }`
  and `delivery.skipped`: nothing is sent, the message is the answer. They
  leave `openCards`, the thread's `asks` and the Waiting page. Card
  delivery itself (answers, dismissals) never closes other cards.
- `GET /api/agent-chat/<agentId>` → `{ agentId, title, kind, work, pr,
  status, updatedAt, provider, thinking, serverId, openCards, …usage }` for
  any Paseo agent (404 when Paseo no longer knows it): the `#/agents/<agentId>`
  page of an agent outside a work.
- `POST /api/cards/<id>/explain` → `Card` (the "Explain more" button of a
  choice card): sends the agent "[coco card <id> explain] … Explain the
  options in more detail before I pick"; the card stays open, `explained`
  records the send. On a choice card the `ask` tool takes `recommended` (the
  option key, marked and pre-picked) and each option an optional
  `consequence`; agents give one recommendation, and a consequence when the
  options differ in risk, so nobody types a question into "Other". Every
  agent ends a turn that leaves the next move to the user with such a card of
  next steps, never a plain answer.
- Chat topic `agent-chat:<agentId>` of the page stream (`/api/events`, see the
  guide; also the SSE route `/api/agent-chat/<agentId>/events`) also emits
  `event: cards` with `data: Card[]` whenever a card of that agent changes.
- Ask topic `ask:<id>` (route `/api/ask/<id>/events`) emits `event: cards`
  with every card of the conversation's agents (past ones included,
  `agentIds` on the conversation) after the log replay and on every change.
- `GET /api/works/<slug>/threads/<key>` carries the thread's `cards`; its
  SSE sends a `thread` ping when one changes, and the summaries count the
  open ones as `asks`.
- Work agents SSE marks an agent with an open card as waiting on you (same
  orange state as a pending permission): every `WorkAgent` carries
  `openCards: number`, and the list is resent when a card of a listed agent
  changes.
- `POST /api/cards` and `POST /api/cards/<id>/answer` answer `400 { error }`
  naming the bad field; answering or cancelling a card that is not open is
  `409`.

## Delivery

On answer, coco sends the agent one message:

```
[coco card <id> answered] <title>
<plain-text summary: picked labels, ticked rows, approved/rejected, field values, other text>
Done: <result detail>      (or Failed: …, proposal cards only)
```

followed by the answer JSON in a fenced block (with `result: { ok, detail,
link }` when the action ran). The answer to a card of a one-shot Ask run (the
rules run) is not delivered: `delivery.skipped`. A dismissal sends

```
[coco card <id> dismissed] <title>
The user dismissed this card without choosing. Continue with your recommendation if it is safe; otherwise stop and say what is left.
```

so a "next steps" card dismissed by mistake or by impatience does not leave
the work half done. The cards line of every coco agent's system prompt also
says that a plain message from the user while a card is open answers it.
Running agent: steer; idle: new turn; archived or unreachable: stored with
`delivery.ok: false` and shown on the card. An Ask coco agent gets it through
its conversation (so the turn is logged there; a gone agent is replaced like
on any follow-up); a card with a `thread` through that thread (above); any
other agent through the agent chat's send (`activeTurnBehavior: 'steer'`).
A picked option whose effect did the work is not delivered.

## MCP tools

- `ask(card)`: kinds `choice | rows | form | confirm`; returns
  `{ id, status: 'open', note }`, the note saying the answer arrives as a new
  user message and the agent should not wait or poll. `thread` and option
  `effect` for thread agents.
- `post_blocks({ title, blocks, thread? })`: a `post` card.
- `post_reply({ blocks, thread?, finding? })`: a thread agent's reply for its
  waiting thread (`POST /api/agent-chat/<agentId>/reply`). `blocks` go through
  the `post_blocks` validator; a refusal names the field (`blocks[1].rows`,
  `thread`). It writes the thread's `-reply.json` and reads it at once; the
  file stays the fallback. `thread` is needed only when several threads wait
  on the agent.
- `propose_work_scaffold`, `propose_paseo_agent`, `dispatch`, `propose_repo`,
  `propose_rules`: same names and inputs as before, now posting a proposal
  card (`action`) and returning `{ id, status: 'open', note }`.
- `propose_stack_edit({ work?, ops, syncNotion?, why? })`: same return; edits
  an existing work's stack without replacing it (`work_scaffold`'s replace
  keeps rows matched by PR or branch).
- `propose_split({ work?, pr, parts: [{ title, branch, files?, scope?, existingPr? }], why? })`:
  same return; call it once the branches and PRs of a split exist (parts
  without `existingPr` become planned `b:<branch>` rows). The git split stays
  the agent's; never the Update work replace.
- `propose_pr_reply({ pr?, replyTo?, body, resolve?, github?, why? })`: same
  return; every agent drafts a PR comment reply through it (Ask prompt, cards
  line, fix and review briefs) instead of refusing or handing back a command.
- `get_work({ slug, sections? })`: a slim view by default (summary, stack rows
  with `number`, `branch`, `title`, `state`, `notionPage`, decisions in one
  line, clipped notes, the last note entries). `sections` (`notes`, `timeline`,
  `artifacts`, `decisions`, `full`) adds the rest. `get_pr_findings` returns
  every finding of the PR with its status, resolved and declined included.
- `own_deps({ paths? })`: a code-writing agent's worktree gets its own copy of
  the dependency folders that link to the main checkout
  (`POST /api/agent-worktree/own-deps` with the agent's cwd and id). Returns
  at once with `{ started, already, note }`; coco messages the agent once
  they are installed (docs/guide.md, "Agent worktrees").
- `screenshot({ url, width?, height?, waitMs?, selector?, eval?, colorScheme?, out? })`:
  the agent sees a page. `url` is a coco hash path (`#/work/<slug>/<tab>`,
  opened on the coco server) or a full http URL on loopback (any port, so a
  dev server or the agent's own server copy) or a `screenshot.hosts` name;
  anything else is refused. Calls `GET /api/screenshot?…&json=1` and returns
  an MCP `image` block (PNG) plus a text block `{ url, width, height, errors,
  evalResult?, saved? }`: `errors` are the page's console errors, uncaught
  exceptions and failed loads; `out` also writes the PNG to that absolute path
  (for `attach_media`).

Work writes mirror the HTTP routes. `work` and `pr` default to the calling
agent's labels (`GET /api/agent-chat/<agentId>/place`; its row only on its
own work); a refusal comes back as a tool error naming the field.

| Tool | Route |
| --- | --- |
| `upsert_finding` | `POST /api/works/<slug>/prs/<n>/comments`, or `PUT …/comments/<id>` for an id or the same author, path and title; `sha` defaults to the PR head (`GET /api/code/pr/<n>/refs?fresh=1`) |
| `flag_coco_issue` | `POST /api/works/<cocoWork>/prs/<first row>/comments` with `kind: "issue"` (no path, sha or lines; `title`, `severity`, `summary`, the user's words as a callout, `from` the agent id, work and PR, a source link to the agent's tab), or `PUT …/comments/<id>` for an issue of the same title; returns `{ id, created or updated, url }`, `url` the finding's deep link `#/work/<slug>/findings-<row>/f-<id>`. The work is `cocoWork`, else the one whose `repo` is `cocopilot` |
| `upsert_decision` | `PUT /api/works/<slug>/decisions/<id>`; no `status`, `choice`, `rationale` or `decidedAt` in its schema |
| `attach_media` | `POST /api/works/<slug>/media` with a file on disk; returns `src` and a `media` block |
| `import_artifact` | `POST /api/works/<slug>/artifacts` |
| `get_drift` | `GET /api/works/<slug>/drift`: `{ drift, next }` items with `kind`, `text` and the owner's action; read only |
| `consult_persona` | read only, no route and no model: `{ login?, question, path?, pr? }` returns a text pack of at most 6000 characters (`server/consult.ts`): the persona's review-style (else main file) and authoring-style rules by keyword overlap with question and path plus its top rules, its mined past comments on similar paths, and the instruction to answer as them in 3-6 lines then offer an `ask` card with their pick `recommended`. Without `login`: the reviewer mapped to `path`, else the PR row's or work's first persona |
| `set_next` | `PUT /api/works/<slug>` with `{ next }`, `clear` sends `null` |

The MCP server learns its agent from `PASEO_AGENT_ID` in its environment
(Paseo sets it on the Claude process, and Claude's stdio MCP children inherit
it) and posts to the running coco server at `baseUrl` from the config. A
refused card comes back as a tool error naming the bad field, so the agent can
fix it and retry. Every coco agent's system prompt carries one line
(`CARDS_LINE` in `server/paseo-agent.ts`): ask the user only through
`cocopilot.ask`; show rich results with `post_blocks`; edit code only with the
Edit or Write tools after a Read, never with sed, python or heredocs; check a
UI change with `screenshot` and look at it before reporting, never ask the
user to reload and check.

`AskUserQuestion` is off through Paseo's Claude provider options: the agent
config carries `options: { disallowedTools: ['AskUserQuestion'] }` (Paseo
hands it to the Claude Agent SDK). Paseo's `disabledTools` only covers
Paseo's own injected tools, so it does not apply. For other providers the
system prompt line is the only guard. An agent started with
`mcp: false` keeps neither the MCP nor the line, and keeps `AskUserQuestion`.
