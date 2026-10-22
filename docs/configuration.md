# Configuration

cocopilot reads its defaults from `server/config.mjs`, then overlays the JSON
file at `$COCO_CONFIG`, or `coco.config.json` at the app root (gitignored).
Start from the example:

```bash
cp coco.config.example.json coco.config.json
```

Keep only the keys you need: every key has a default, and objects merge key
by key with the defaults. Arrays replace the default array as a whole.

Environment overrides:

| Variable | Overrides |
| --- | --- |
| `COCO_CONFIG` | Path of the config file. |
| `COCO_REPO` | `repo.path`. |
| `COCO_DATA` | `dataDir`. |
| `COCO_URL` | Read by the bundled skills (`skills/`) to reach the server; not by the server. |

Paths starting with `~` resolve to your home directory.

The server port and bind address are command-line arguments, not config:
`node server/index.mjs [port=8777] [bind=127.0.0.1]`.

## Keys

### Owner

| Key | Default | Meaning |
| --- | --- | --- |
| `owner.name` | `"the user"` | How prompts and briefs name the person driving the work. |
| `owner.login` | `"me"` | Author id of your own local review comments, and "me" in the findings board. Changing it later detaches comments written under the old login. |

### Repository

| Key | Default | Meaning |
| --- | --- | --- |
| `repo.path` | `""` | Absolute path of the git checkout the works live in. Required: without it the dashboard stays empty. |
| `repo.github` | detected | `owner/name` slug on GitHub, used for every `gh` call and PR link. Detected with `gh repo view` in `repo.path` when empty. |
| `repo.defaultBranch` | detected | Branch PRs merge into (`main`, `master`). Detected from `origin/HEAD`, else `main`. |
| `repo.tsconfig` | `"tsconfig.json"` | Repo-relative tsconfig whose `paths` the code navigation uses (go to definition, references). |
| `repo.rules` | `["AGENTS.md", "CLAUDE.md"]` | Repo-relative files or folders agents must read first; listed in every brief and review prompt. |
| `repo.reviewsDir` | `".claude/reviews"` | Repo-relative folder where review pages (markdown) are written; read by the findings board. |
| `repo.commitConvention` | `""` | One line describing the commit message format, quoted in briefs. Empty: no convention named. |

### Server and storage

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `"http://127.0.0.1:8777"` | URL agents use to call cocopilot back (briefs, skills). Match the port you start the server on. |
| `dataDir` | `<app>/data` | Where works, comments, findings, threads and caches are stored. Back it up; it is the only state. |
| `briefsDir` | `<tmp>/cocopilot-handoffs` | Scratch folder for ritual briefs handed to agents. |
| `skillsDir` | `"~/.claude/skills"` | Claude Code skills folder, listed and editable from the Dashboard. |
| `skillPrefix` | `""` | Name prefix of your team's own skills (e.g. `"coco-"`): those are listed first and shown on the Dashboard. Empty: no skill is singled out. |
| `methodSkill` | `""` | Name of the skill that describes how you run a work (e.g. `"coco-work"`). Ask runs can read its files by bare name (`SKILL.md`, …) through the MCP `read_skill` tool. |
| `methodNotes` | `""` | A file of `methodSkill` holding your preferences for scaffolds, stacks and diagrams (e.g. `"preferences.md"`). Ask and Inbox runs read it first when set. |
| `personasDir` | `<dataDir>/personas` | Reviewer persona files (`<login>.md`, optional `<login>.json`). Format: [examples/personas/alice.md](examples/personas/alice.md). |
| `personaFiles` | `{ "ignore": ["README", "CHANGELOG"], "companionSuffixes": [] }` | Files in `personasDir` that are not personas: `ignore` lists base names, `companionSuffixes` marks `<login>-<suffix>.md` as extra files of that persona (listed with it, not as a persona). |
| `kitBody` | `{ "maxChars": 0, "mustMatch": "" }` | When the "kit: body" gate counts as done from GitHub: a PR body at most `maxChars` long (0 = any) matching the `mustMatch` regex (case-insensitive, empty = any). |

### Agents

| Key | Default | Meaning |
| --- | --- | --- |
| `models.default` | `"claude/claude-opus-5-5"` | Paseo provider/model for review plans, PR agents, gates and deep thread work. |
| `models.fast` | `"claude/claude-sonnet-5-5"` | Paseo provider/model for small scoped thread agents. |
| `importRoots` | `["/tmp", "/private/tmp", "~/.paseo/worktrees"]` | Folders files may be imported from as work artifacts. Add your repo or another scratch folder if agents write kit files there. |
| `rituals` | `[]` | Buttons on the Rituals page, each starting a Paseo agent in your repo. Item: `{ "kind", "label", "prompt", "hint"?, "fields"? }`. `prompt` may hold `{login}`, `{pr}`, `{paths}`, `{text}` placeholders, which become form fields unless `fields` lists them. |

### Checklist and kit

| Key | Default | Meaning |
| --- | --- | --- |
| `kitKinds` | `["body", "diagram", "video"]` | Kit pieces a PR is expected to ship with (PR body, diagram, demo video), tracked fresh or stale per head. Add your own kinds, e.g. `"docs"` for a companion docs PR. |
| `gateSkills` | every gate `[]` | Skills each checklist gate starts in the PR agent, by gate id: `self-review`, `history`, `kit-body`, `kit-diagram`, `kit-video`, `review-pr`. An empty list leaves the gate as a manual tick. The first `kit-diagram` skill is also named to Ask runs. |

### Review

| Key | Default | Meaning |
| --- | --- | --- |
| `fileLayers` | `null` (built-in lists) | Overrides the file classifier of the review plan. Object with optional `layers`, `wiring` and `other` lists of `[regexSource, label]`; each given list replaces the built-in one. `layers` order is the reading order of core files (e.g. controller before service before domain). |
| `botGroups` | `{ "sentry": "sentry" }` | Reviewer groups for bot comments on the findings board: group name → case-insensitive pattern matched against the GitHub login. |
| `seedRules` | `[]` | Global rules written as kept to the rules ledger once, when `data/rules.json` does not exist yet; each `["rule text", "source"]`. Kept rules go into every brief and review plan. |
| `featureFlags` | `null` | Optional `{ "provider": "<path to an ES module>" }`. The module exports `createFeatureFlags({ config, REPO })` returning `{ forRow(work, n), known() }`, so cocopilot can say how to switch on each feature flag a work lists. Without it, briefs and PR cards show no feature flag line. |

## Feature flag provider

A provider keeps team-specific parsing out of this repo. A work lists the
flags a tester must switch on as `betaFlags: [{ code, why, prs? }]` (no
`prs`: every PR). `forRow(work, n)` returns the flags of stack row `n`, each
with what your repo says about it and an `enable` line; `known()` returns a
`Map` of every flag in the repo, by code. Minimal shape:

```js
// ~/.cocopilot/widgets-flags.mjs
import fs from 'node:fs';
import path from 'node:path';

export function createFeatureFlags({ REPO }) {
  const known = () => {
    const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'config/flags.json'), 'utf8'));
    return new Map(Object.entries(raw).map(([code, f]) => [code, { code, name: f.name, mode: f.mode }]));
  };
  const forRow = (work, n) =>
    (work.betaFlags || [])
      .filter((f) => !f.prs?.length || f.prs.map(String).includes(String(n)))
      .map((f) => ({ ...(known().get(f.code) || { code: f.code }), why: f.why || '', enable: `set ${f.code} to true in config/flags.json` }));
  return { forRow, known };
}
```

## MCP config

Ask runs and review plans start Claude Code with the cocopilot MCP server.
Copy `server/mcp-config.example.json` to `server/mcp-config.json`
(gitignored) and set the absolute path of `server/mcp.mjs`.
