---
name: coco-pr-body
description: "Write or refresh a PR body from inside a cocopilot PR agent: the repo's title and body format, a diagram from the kit diagram skill, kit files handed to cocopilot, then the body applied with gh pr edit. Use for the body kit of a PR."
argument-hint: "<PR number>"
allowed-tools: Bash, Read, Grep, Glob, Write, Skill
---

# coco-pr-body

Draft the body of one PR, with its diagram, and apply it. You run inside a
cocopilot PR agent: the brief above your task holds the product effect,
the body rules and the kit lines. Nobody answers a question mid-run, so
never ask for a confirmation.

## 1. Read before writing

- The brief: product effect, body rules, the kit lines (which skill draws
  the diagram), the constraints.
- The diff against the PR base:
  `gh pr view <n> --json baseRefName,headRefName,title,body`, then
  `git diff <base>...HEAD`. Every claim in the body comes from it.
- The repo's PR format: a PR template under `.github/`, a PR skill in the
  repo's skills folder (`.claude/skills`, `.agents/skills`), `AGENTS.md`.
  Take its title and section format only; skip its push, create and
  confirmation steps.

## 2. Diagram

Invoke the diagram skill the brief's kit line names (`coco-diagram` when
none) with the Skill tool, and follow it end to end. Never draw Mermaid
from memory: its init line and `new` / `same` / `rm` classes are what make
the PR body read as one picture.

The brief's body rules win where they are stricter (plain product words, no
legend, Before left and After right).

## 3. Body

Keep the existing body's sections the brief does not ask to change. Replace
an existing `## How it works` rather than adding a second one. Respect the
brief's length and required lines (a TL;DR, a Notion link on top).

Write the body to `/tmp/pr-<n>/body.md` and each diagram to
`/tmp/pr-<n>/diagram.md`.

## 4. Hand over and apply

1. `cocopilot.import_artifact` with `{ path, pr, kind: "body" }`, then
   `{ path, pr, kind: "diagram" }`.
2. `gh pr edit <n> --body-file /tmp/pr-<n>/body.md`, plus `--title` when
   the brief or the diff calls for a new title.

Never push, undraft, comment or review.

## 5. Report

The artifact paths, what changed in the body, and each deviation from the
brief with its reason.

## Request

$ARGUMENTS
