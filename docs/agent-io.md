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

## Slices

1. Cards end to end: store, routes, MCP `ask` + `post_blocks`, answer delivery,
   MCP on every agent, `AskUserQuestion` off, renderer in every agent view.
2. Fold the old paths: `propose_*` become `confirm` cards whose approval runs
   the side effect; thread `choices` become `choice` cards; MCP
   `upsert_finding`, `upsert_decision`, `attach_media` replace curl in skills.
3. [x] Multimodal input in the composer: paste, drop or pick images and
   files; `POST /api/uploads`, ids on the message, Paseo `images` and
   `uploaded_file` attachments, files shown on the user message.

## Card

```ts
type CardKind = 'post' | 'choice' | 'rows' | 'form' | 'confirm';
type CardOption = { key: string; label: string; details?: string; recommended?: boolean; confidence?: number };
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
  fields?: CardField[];           // 1-8
  // confirm
  confirmLabel?: string;          // default "Approve"
  rejectLabel?: string;           // default "Reject"
  other?: boolean;                // free-text "Other…" box, default true for choice/rows/confirm, false for form; stored resolved
  status: 'open' | 'answered' | 'cancelled';   // post cards are 'answered' at birth
  createdAt: string;
  answer?: CardAnswer;
  delivery?: { at: string; ok: boolean; error?: string };
};

type CardAnswer = {
  at: string;
  picked?: string[];                       // choice: option keys
  rows?: string[];                         // rows with select: ticked row keys
  rowPicks?: Record<string, string>;       // rows with rowOptions: row key -> option key
  values?: Record<string, string | number | boolean>;  // form
  approved?: boolean;                      // confirm
  other?: string;                          // free text, alone or alongside
};
```

Validation lives on the server (`server/cards.ts`), reusing `server/blocks.ts`
for `blocks` and cells. A `choice` answer needs ≥ 1 pick or `other` (one pick
at most unless `multi`); `one` row select needs exactly one row (or `other`
alone); `rowOptions` needs ≥ 1 row pick or `other`; required fields need a
value; `confirm` needs `approved` or `other`. Option, row and field keys are
short ids (`[\w.:~-]{1,60}`), unique per card. A `post` card needs `blocks`.
Cards are stored one JSON file each under `<dataDir>/cards/`.

## Routes

- `POST /api/cards` body `Card` minus `id/status/createdAt/answer/delivery`,
  `agentId` required → `Card`. Used by the MCP server.
- `GET /api/agent-chat/<agentId>/cards` → `Card[]` oldest first.
- `GET /api/cards/<id>` → `Card`.
- `POST /api/cards/<id>/answer` body `CardAnswer` minus `at` → `Card`. Stores the
  answer, then delivers it.
- `POST /api/cards/<id>/cancel` → `Card` (user dismisses an open ask; the agent
  is told it was dismissed).
- Chat SSE `/api/agent-chat/<agentId>/events` also emits
  `event: cards` with `data: Card[]` whenever a card of that agent changes.
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
<plain-text summary: picked labels, ticked rows, field values, approved/rejected, other text>
```

followed by the answer JSON in a fenced block. A dismissal sends
`[coco card <id> dismissed] <title>` and a line saying the user dismissed it.
Running agent: steer; idle: new turn; archived or unreachable: stored with
`delivery.ok: false` and shown on the card. An Ask coco agent gets it through
its conversation (so the turn is logged there; a gone agent is replaced like
on any follow-up); any other agent through the agent chat's send
(`activeTurnBehavior: 'steer'`).

## MCP tools

- `ask(card)`: kinds `choice | rows | form | confirm`; returns
  `{ id, status: 'open', note }`, the note saying the answer arrives as a new
  user message and the agent should not wait or poll.
- `post_blocks({ title, blocks })`: a `post` card.

The MCP server learns its agent from `PASEO_AGENT_ID` in its environment
(Paseo sets it on the Claude process, and Claude's stdio MCP children inherit
it) and posts to the running coco server at `baseUrl` from the config. A
refused card comes back as a tool error naming the bad field, so the agent can
fix it and retry. Every coco agent's system prompt carries one line
(`CARDS_LINE` in `server/paseo-agent.ts`): ask the user only through
`cocopilot.ask`; show rich results with `post_blocks`.

`AskUserQuestion` is off through Paseo's Claude provider options: the agent
config carries `options: { disallowedTools: ['AskUserQuestion'] }` (Paseo
hands it to the Claude Agent SDK). Paseo's `disabledTools` only covers
Paseo's own injected tools, so it does not apply. For other providers the
system prompt line is the only guard. An agent started with
`mcp: false` keeps neither the MCP nor the line, and keeps `AskUserQuestion`.
