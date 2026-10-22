---
name: coco-diagram
description: "Turn a branch diff into Mermaid diagrams for a PR body: before/after, data path, index plan, dependency delta. Use for the diagram kit of a PR, or when a reviewer needs to see which paths a branch adds."
argument-hint: "[base branch or PR number]"
allowed-tools: Bash, Read, Grep, Glob
---

# coco-diagram

Read a branch diff, pick the diagrams that carry information, render them
as Mermaid, and hand them to the user for the PR body. Never edit the PR
yourself.

A reviewer reads the PR body before the diff. Prose describes one path at a
time; a diagram shows which paths are new, which are untouched, and where
the old gap was. GitHub renders Mermaid in a PR body, so the picture travels
with the review.

## Scope

- Read-only: git, `gh` reads and the files of the repo.
- Draw what the diff shows. A relation not visible in the changed files, or
  in a file they import, stays out.

## 1. Resolve the range

```bash
BASE=${1:-$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')}
git diff "$BASE"...HEAD --stat
git diff "$BASE"...HEAD --name-only
```

Given a PR number, take the base from
`gh pr view <n> --json baseRefName,headRefName`.

## 2. Read before drawing

Read every changed file, plus the call sites the diff names. A diagram
claims a call path exists, so check each arrow against real code: an import
plus a call, a query, an HTTP request.

Name each node after the real symbol (`InvoicesService.export`), not "the
service".

## 3. Pick the diagrams

Draw a diagram when its trigger is in the diff, skip it otherwise: an empty
diagram costs the reader more than the section it fills.

| Diagram | Draw it when | Shows |
| --- | --- | --- |
| Before / After | The branch adds a path or closes a gap | Old path, the gap in red, the new path |
| Data path | A repository, table, collection or projection changed | Entry point → service → repository → storage |
| Index plan | Index definitions changed, or a new query landed | Which index serves which read |
| Dependency delta | A new cross-module or cross-layer import landed | The layering the branch introduces |

For a branch that only renames or reformats, say so and draw nothing.

## 4. House style

One legend line above the first diagram:

```text
Cylinder = storage · rectangle = code · diamond = a branch in the code.
Green = added by this PR, grey = untouched, red = the gap.
Dotted arrow = HTTP hop.
```

Every diagram opens with the same init and closes with the same `classDef`
set, so the PR body reads as one picture:

```text
%%{init: {'flowchart': {'curve': 'linear', 'rankSpacing': 45}}}%%
flowchart TB

classDef new fill:#d3f9d8,stroke:#2f9e44,stroke-width:2px,color:#1b4332
classDef same fill:#e9ecef,stroke:#868e96,color:#343a40
classDef rm fill:#ffd8d8,stroke:#e03131,stroke-width:2px,color:#6a1212
```

Shapes carry meaning: `[("table")]` for storage, `["code"]` for a function
or module, `{"choice?"}` for a branch.

Syntax that survives GitHub's renderer:

- Quote every label: `A["export (v2)"]`. Bare `(`, `)`, `:` and `,` end
  the parse.
- `<br/>` breaks a line; `<i>identifier</i>` marks code (backticks render
  literally inside a label).
- `-. HTTP .->` for a hop through an HTTP API, plain `-->` for a direct
  call.
- `A ~~~ B` orders subgraphs without drawing a link.
- Keep one diagram under ~15 nodes. Past that, split it by concern.

## 5. Template per diagram

**Before / After**: two blocks. `Before` ends on the gap in `rm`; `After`
shows the new path in `new` and leaves what it did not touch in `same`.

**Data path**: the vertical spine (entry point → validation → service →
repository → storage), with side reads branching off it.

**Index plan**: one `subgraph` per read, each query node pointing at the
index that serves it. Label an index-served read and a full scan or
in-memory sort differently; that contrast is the reason for this diagram.

**Dependency delta**: one node per module or layer, an arrow per import the
branch adds. Take the layers from the repo rules (`AGENTS.md`, `CLAUDE.md`,
architecture docs) and say plainly when an arrow points against them.

## 6. Verify

Render each block before handing it over. When `npx -y
@mermaid-js/mermaid-cli` is available, `mmdc -i diagram.mmd -o
/tmp/diagram.svg` fails loudly on a syntax error. Otherwise re-read each
label for an unquoted `(` or `:`.

Then check the substance: every node names a real symbol, every arrow is a
call you read, and the colors match the diff (green only on added code).

## 7. Deliver

Write the blocks, under a `## How it works` heading, to
`/tmp/pr-<n>-how-it-works.md` (`/tmp/<branch>-how-it-works.md` before the PR
exists), and print them in the reply. Then give the user the command that
puts the section in the PR body after `## Summary`, replacing an existing
`## How it works` rather than adding a second one:

```bash
gh pr view <n> --json body -q .body > /tmp/pr-<n>-body.md
# insert /tmp/pr-<n>-how-it-works.md, keeping every existing line
gh pr edit <n> --body-file /tmp/pr-<n>-body.md
```

The user runs it; you never edit, push or post. The kit gate in cocopilot
ticks once the PR body holds a Mermaid block.

## Request

$ARGUMENTS
