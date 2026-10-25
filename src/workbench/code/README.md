# workbench/code (PR review: diff, comments, agent handoff, navigation)

Wired into the workbench (tabs `diff-`, `file-`, `review-`, `agent-`). Files:

- `code-api.ts`: fetch wrappers for `/api/code/pr/<n>/*`, `isDesktop()`, and `loadMonaco()` (the only lazy entry to Monaco).
- `monaco.ts` (+ `monaco-features.ts`): the only modules importing `monaco-editor`; exports `{ monaco, languageFor }`, theme `cocopilot`, no TS/JSON worker.
- `editor-shared.ts`: model refcount (`cc:/<side>/<path>` uris), gutter drag / `c` / hover "+" comment UX, `useCommentLayer` (decorations + view zones -> portal targets).
- `DiffView.tsx` / `CodeView.tsx`: desktop editors; pass `renderZone={(comment) => <CommentZone .../>}` to render cards into the zones.
- `LiteDiff.tsx`: phone fallback on `codeApi.diff(n, path).unified`; same comment shape, `side: 'head'` only.
- `CommentZone.tsx`, `FileList.tsx`, `QuickOpen.tsx` (+ `useQuickOpenShortcut`): plain React, no Monaco import.
- `code.css`: import via the components themselves; uses variables from `src/styles.css`.
- `smoke.tsx`: `<CodeSmoke />` mounts DiffView with two strings, one fake comment, draft creation by gutter click.
- Gate on `isDesktop()` to pick DiffView/CodeView vs LiteDiff; Monaco chunks load only when a desktop view mounts.
- `ids.ts`: tab ids `diff-<n>~<path>`, `file-<n>~<path>`, `review-<n>`, `agent-<runId>` helpers.
- `use-comments.ts`: one zustand entry per `slug:n` (refs, comments, drafts, runs), re-anchors when head or merge-base moved, polls 30 s while a tab of the PR is mounted.
- `lang-providers.ts`: definition / references / hover for `cc:/head/*` models over `/api/code/pr/<n>/*`, editor opener -> tabs; `node_modules` targets peek only.
- `ReviewSidebar.tsx` (tree, comments, runs) and `ReviewFileCard.tsx` (one hunk-view diff card per file at its full height, mounted only near the viewport and kept at its measured height when unmounted): the pieces of the `review-<n>` tab.
- Tabs live in `../tabs/Code.tsx` (diff + file), `Review.tsx`, `AgentRun.tsx`.
