# Configuration

cocopilot reads its defaults from `server/config.ts`, then overlays the JSON
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

A [team pack](guide.md#team-pack-share-with-teammates) import merges a
teammate's config into this file: their values fill in and override team
keys, while your personal keys (`owner`, `dataDir`, `briefsDir`, `skillsDir`,
`personasDir`, `baseUrl`, `importRoots`, `repo.path`) always stay yours.

The server port and bind address are command-line arguments, not config:
`node server/index.ts [port=8777] [bind=127.0.0.1]`.

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
| `cloneDir` | the folder holding the default repo's clone | Where "New repo" looks for a clone of a GitHub slug (by its `origin` remote), and clones it with `gh repo clone` when none matches. The new repo is appended to `repos` in this file. |
| `cocoWork` | the work whose `repo` is `cocopilot` | Slug of the work that owns cocopilot itself. `flag_coco_issue` files the changes users ask of coco as findings on its first row. |

### Server and storage

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `"http://127.0.0.1:8777"` | URL agents use to call cocopilot back (briefs, skills). Match the port you start the server on, and keep it on loopback: anything else needs a paired device (see Phone). |
| `hosts` | `[]` | Extra Host names a reverse proxy serves cocopilot under, e.g. `["coco.local", "coco.tail1234.ts.net"]`. The server refuses any request whose Host is not `127.0.0.1`/`localhost` on its port or the vite port, the `baseUrl` host, or one of these; a write from a browser must also come from one of them (http or https Origin). A request through any of these hosts, or carrying a proxy header (`X-Forwarded-For`…), also needs a paired device (see Phone). |
| `screenshot` | `{ "chrome": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "hosts": [] }` | The headless Chrome behind `/api/screenshot` and the agents' `screenshot` tool (guide: Screenshots). `chrome`: its binary; a missing one fails the capture with that path. `hosts`: host names it may open beyond coco and loopback, e.g. `["dev.example.com"]`. |
| `browserHost` | `"auto"` | `"auto"`: while the Paseo desktop app is closed, coco hosts the agents' `browser_*` tools in that same headless Chrome, and steps down once the app is back (guide: Browser host). `"off"`: never. |
| `dataDir` | `~/.cocopilot/data` (`<app>/data` when that folder exists, for older installs) | Where works, comments, findings, threads and caches are stored. Back it up; it is the only state. Keep it outside the checkout: `git clean -x` there would delete it. |
| `briefsDir` | `<tmp>/cocopilot-handoffs` | Scratch folder for ritual briefs handed to agents. |
| `skillsDir` | `"~/.claude/skills"` | Claude Code skills folder, listed and editable from the Dashboard. |
| `skillPrefix` | `""` | Name prefix of your team's own skills (e.g. `"coco-"`): those are listed first and shown on the Dashboard. Empty: no skill is singled out. |
| `methodSkill` | `""` | Name of the skill that describes how you run a work (e.g. `"coco-work"`). Ask runs can read its files by bare name (`SKILL.md`, …) through the MCP `read_skill` tool. |
| `skillOverrides` | `{}` | Shipped skill → your skill that replaces it, e.g. `{ "coco-diagram": "my-diagram" }`. Gates run yours, setup checks yours is installed and never installs, compares or overwrites the shipped one. Map a name to itself (`{ "coco-findings": "coco-findings" }`) to keep your edited copy of a shipped skill. `methodSkill` already replaces `coco-work`. |
| `methodNotes` | `""` | A file of `methodSkill` holding your preferences for scaffolds, stacks and diagrams (e.g. `"preferences.md"`). Ask and Inbox runs read it first when set. |
| `personasDir` | `<dataDir>/personas` | Reviewer persona files (`<login>.md`, optional `<login>.json`). Format: [examples/personas/alice.md](examples/personas/alice.md). |
| `personaFiles` | `{ "ignore": ["README", "CHANGELOG"], "companionSuffixes": [] }` | Files in `personasDir` that are not personas: `ignore` lists base names, `companionSuffixes` marks `<login>-<suffix>.md` as extra files of that persona (listed with it, not as a persona). |
| `kitBody` | `{ "maxChars": 0, "mustMatch": "" }` | When the "kit: body" gate counts as done from GitHub: a PR body at most `maxChars` long (0 = any) matching the `mustMatch` regex (case-insensitive, empty = any). |

### Agents

| Key | Default | Meaning |
| --- | --- | --- |
| `models.default` | `"claude/claude-opus-5-5"` | Paseo provider/model for review plans, PR agents, gates and deep thread work. |
| `models.fast` | `"claude/claude-sonnet-5-5"` | Paseo provider/model for small scoped thread agents. |
| `models.judge` | `models.fast` | Paseo provider/model for small no-tool decisions (today: which follow-ups become brief lessons). A failed or unparseable answer falls back to `models.fast`. Each answer is logged to `data/judge-log.jsonl`, so a smaller or local model (e.g. Ollama through Paseo's `opencode` or `pi` provider) can be tried here first. |
| `models.judgeShadow` | none | A model that answers each judge prompt too, in the background: its answer is logged, never acted on. The repo page's Lessons section shows how often it makes the main judge's call, next to the share of the judge's lessons you did not drop, so you can tell when it is good enough to become `models.judge`. A Claude model here doubles the judge's calls. |
| `importRoots` | `["/tmp", "/private/tmp", "~/.paseo/worktrees"]` | Folders files may be imported from as work artifacts. Add your repo or another scratch folder if agents write kit files there. |
| `agentWorktree` | `null` | How coco readies the worktree of a code-writing agent and checks its commits; per repo too (`repos[].settings`). See [Agent worktrees](#agent-worktrees). |
| `preflight` | `null` | Checks shown on a kit-video dispatch and injected in its brief; per repo too. See [Preflight](#preflight). |
| `land` | `"pr"` | How a planned row ships; per repo too. `"pr"`: a row is a PR, done when GitHub merges it. `"main"`: a row may also land straight on the local default branch with no PR, marked by its agent (`mark_row_landed`), by you (**Mark landed**) or seen in git, and its work auto-archives once every row landed or merged. The cocopilot repo coco adds on its own uses `"main"`. |
| `rituals` | `[]` | Buttons on the Rituals page, each starting a Paseo agent in your repo. Item: `{ "kind", "label", "prompt", "hint"?, "fields"? }`. `prompt` may hold `{login}`, `{pr}`, `{paths}`, `{text}` placeholders, which become form fields unless `fields` lists them. |

### Checklist and kit

| Key | Default | Meaning |
| --- | --- | --- |
| `kitKinds` | `["body", "diagram", "video"]` | Kit pieces a PR is expected to ship with (PR body, diagram, demo video), tracked fresh or stale per head. Add your own kinds, e.g. `"docs"` for a companion docs PR. |
| `gateSkills` | every key `[]` | Skills started in the PR agent, by key: `self-review` and `review-pr` (the self-reviewed milestone and the Review code chevron), `history` (Tidy history on the commits badge), `kit-<kind>` (redo a stale kit piece). Each one is also an Agent menu entry. The first `kit-diagram` skill is also named to Ask runs. |

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

## Agent worktrees

`agentWorktree` tells coco how to ready the worktree of an agent that writes
code and which checks to run on its commits (behavior: docs/guide.md, "Agent
worktrees"). Commands are argv arrays run without a shell; wrap one in
`["bash", "-c", "…"]` when it needs one (e.g. to pick a Node version).

```json
"agentWorktree": {
  "mainCheckout": "~/code/widgets",
  "deps": [
    { "path": "node_modules", "lockfile": "package-lock.json", "install": ["npm", "ci"] },
    { "path": "web/node_modules", "lockfile": "web/package-lock.json", "install": ["npm", "ci"] }
  ],
  "checks": [
    { "id": "lint", "label": "Lint", "command": ["npx", "eslint", "{files}"], "fix": ["npx", "eslint", "--fix", "{files}"], "files": "\\.(ts|tsx)$" },
    { "id": "types", "label": "Type check", "command": ["npm", "run", "typecheck"], "files": "\\.(ts|tsx)$", "timeoutSeconds": 900 },
    { "id": "tests", "label": "Tests next to the change", "cwd": "web", "command": ["npx", "vitest", "run", "{tests}"], "files": "\\.(ts|tsx)$" }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `mainCheckout` | Where linked folders point. Default: the repo's `path`. |
| `deps[].path` | A dependency folder, relative to the worktree. |
| `deps[].lockfile` | Its lockfile: while it matches the main checkout's, the folder is a link; when it differs, the worktree gets its own copy. |
| `deps[].install` | Run in the folder's parent after cloning the main checkout's folder, for an own copy. |
| `deps[].optional` | A main checkout without this folder is no setup failure; the folder stays absent until its lockfile differs. |
| `checks[].needs` | Worktree paths the check cannot run without: while one is missing, the check is unavailable and skipped. |
| `checks[].command` | `{files}`: the changed files matching `files`; `{tests}`: the test files next to them (`x.test.ts` beside `x.ts`), both relative to `cwd`. A check with `files` set and no matching change is skipped. |
| `checks[].fix` | The command the brief gives to fix what the check reports. |
| `checks[].cwd` | Folder the check runs in, relative to the worktree. Default: the worktree root. |
| `checks[].timeoutSeconds` | Default 600. |
| `spares` | How many spare worktrees coco keeps ready for this repo's code agents (docs/guide.md, "Spare worktrees"). Default 0: each agent waits for its own `git worktree add`. Each spare costs a checkout of disk, so a top-level `spares` serves the default repo only; another repo sets its own in `repos[].settings`. |
| `warm` | Steps run in each spare once its deps are ready, e.g. `[{ "label": "Type check cache", "command": ["npm", "run", "typecheck"] }]` so the agent's first typecheck is incremental. `cwd` relative to the worktree, `timeoutSeconds` default 900. A claim cuts a step in flight short; a failed step keeps the spare. |

## Preflight

`preflight` (also per repo, `repos[].settings`) configures the checks run before a
kit-video dispatch (behavior: docs/guide.md, "Preflight"). Worktree deps and the dev server are always
checked. Default `null`: no extra check. The example is illustrative: use the MCP URL, settings
file and key names your app really uses. The key's value is never read or shown, only whether it exists.

```json
"preflight": {
  "mcp": [{ "name": "app-dev MCP", "url": "http://localhost:8000/mcp", "fix": "start the local app" }],
  "settingsFile": "app/settings-local.json",
  "llmKey": { "env": ["ANTHROPIC_API_KEY"], "paths": ["anthropic.apiKey"], "fix": "set the key on the local server" },
  "probes": [{ "name": "Campaign has leads", "command": ["mongosh", "--quiet", "--eval", "if (!db.leads.countDocuments()) quit(1)"], "timeoutSeconds": 10, "fix": "seed leads in SETUP" }]
}
```

| Key | Meaning |
| --- | --- |
| `mcp[]` | `{ name, url, fix? }`: an `http(s)` URL (any answer counts) or `tcp://host:port`, 2.5 s timeout. |
| `settingsFile` | Worktree-relative file that must exist (and holds the `paths`). |
| `llmKey` | Passes when one `env` var is non-empty in the server env, or one dotted `paths` entry of `settingsFile` holds a value. |
| `probes[]` | `{ name, command, cwd?, timeoutSeconds?, fix? }`: argv run without a shell in the worktree, ok on exit 0. Default none; run only when listed. |

## Dev servers

The `devServers` key configures the dev-servers Paseo plugin
([dev-servers/OVERVIEW.md](../dev-servers/OVERVIEW.md)): one app dev server
per worktree, on a stable port, shared by agents and stack rows. The plugin
reads this key straight from the file set in its settings
(`~/cocopilot/coco.config.json` by default): neither `$COCO_CONFIG` nor
coco's defaults apply to it, so point it at the file coco reads. coco reads
`devServers.api.bind` and `devServers.api.port` to reach the plugin: leave
the plugin's API port setting empty, or set it to the same port. Changes
apply when the plugin reloads (saving its settings reloads it).

```json
{
  "devServers": {
    "cap": 3,
    "idleStopMinutes": 30,
    "leaseTtlMinutes": 240,
    "api": { "bind": "127.0.0.1", "port": 8779 },
    "coco": { "url": "http://127.0.0.1:8777", "timeoutMs": 1500 },
    "projects": [{
      "id": "widgets",
      "match": { "remote": "acme/widgets" },
      "mainCheckout": "~/code/widgets",
      "appDir": "app",
      "command": ["npm", "run", "dev", "--", "--port", "{port}", "--inspect={port+1229}"],
      "env": { "LOG_DIR": "{logDir}", "JOBS": "{services}" },
      "ports": { "range": [8100, 8990], "step": 10, "reserve": ["{port}", "{port+1}", "{port+1229}"], "exclude": [8000, 8001] },
      "settings": { "file": "app/settings.local.json", "overlay": { "logDir": "{logDir}" } },
      "provider": "~/.cocopilot/widgets-dev-server.mjs",
      "login": { "timeoutSeconds": 60 },
      "warm": {
        "symlink": ["app/node_modules"],
        "clone": ["app/.cache"],
        "copyIfMissing": ["app/.env.local"],
        "prebuild": true
      },
      "readiness": { "http": { "path": "/health", "bodyIncludes": "ok" }, "timeoutMinutes": 15 },
      "logPatterns": { "progress": "^building (.*)", "ready": "listening on", "crash": "server crashed", "rebuild": "change detected" },
      "stop": { "graceSeconds": 10, "sweepCwdUnder": ["app/.cache/server"] },
      "adopt": { "cwdPattern": "/app$", "probe": { "path": "/health", "bodyIncludes": "ok" } },
      "optIns": { "services": { "path": "jobs" }, "dedicatedDb": { "args": ["--db", "memory"] } }
    }]
  }
}
```

Templates, allowed in `command`, `env`, `settings.overlay`, `urlTemplate`
and `optIns.dedicatedDb`: `{port}`, `{port+N}`, `{logDir}` (the server's
log folder in `stateDir`), `{worktree}` and `{services}` (the opt-in
services, comma-joined; an array when it is the whole value). Any other
placeholder fails the config.

| Key | Default | Meaning |
| --- | --- | --- |
| `api.bind`, `api.port` | `"127.0.0.1"`, `8779` | HTTP API and MCP endpoint. Loopback only. Saved into every agent's MCP config, so keep it stable. |
| `stateDir` | `"~/.cocopilot/dev-servers"` | State, port registry, leases, kept settings, logs. |
| `cap` | `3` | Servers running at once, prebuilds and servers started by hand included. |
| `idleStopMinutes` | `30` | A server nobody holds stops after this, unless pinned. |
| `leaseTtlMinutes` | `240` | A hold unused for this long is dropped. |
| `worktreeRoots` | `["~/.paseo/worktrees"]` | Where stack tops are looked for, besides `mainCheckout`. |
| `injectMcp` | `"matching-projects"` | Which new agents get the MCP tools: `matching-projects`, `all`, `off`. |
| `coco.url`, `coco.timeoutMs` | `"http://127.0.0.1:8777"`, `1500` | coco, asked which stack a branch belongs to when two stacks build on it. `null` turns it off. |
| `projects` | `[]` | One entry per repository, below. |

Project keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `id` | required | Letters, digits, `.`, `_`, `-`. |
| `match` | required | `{ remote: "owner/name" }` (any git remote) and/or `{ paths: [...] }`. |
| `mainCheckout` | `""` | Source of `warm` paths; also a stack-top candidate. |
| `appDir` | `"."` | Folder the command runs in, relative to the worktree. |
| `command`, `env` | required, `{}` | argv (no shell) and extra environment. |
| `ports.range`, `ports.step` | `[8100, 8990]`, `10` | Base ports handed out per worktree. |
| `ports.reserve` | `["{port}"]` | Every port a server uses, as offsets of the base (`{port+1229}` for a debugger); all are checked free and kept apart from other worktrees. Must include `{port}`. |
| `ports.exclude` | `[]` | Ports never handed out (your own servers). |
| `settings.file`, `settings.overlay` | none, `{}` | JSON file written before each start: your own content, then the overlay, then the provider's `settingsOverlay(ctx)`. |
| `provider` | none | ES module exporting `settingsOverlay(ctx)` and/or `login(ctx)`. |
| `login.timeoutSeconds` | `60` | Time `login(ctx)` gets. |
| `warm.symlink`, `warm.clone`, `warm.copyIfMissing` | `[]` | Paths filled from `mainCheckout` before a first start: linked, cloned copy-on-write, copied. |
| `warm.prebuild` | `false` | Prebuild every new Paseo workspace of the project, one at a time. |
| `readiness.http` | `{ "path": "/" }` | Probe; `bodyIncludes` must appear in the body. |
| `readiness.timeoutMinutes` | `15` | A build not ready by then counts as crashed. |
| `readiness.command` | none | Accepted, not used yet. |
| `logPatterns` | none | Regexes on the run log: `progress` (first group shown), `ready` (probe only after it), `crash`, `rebuild` (back to building). |
| `stop.graceSeconds` | `10` | SIGTERM to the process group, then SIGKILL. |
| `stop.sweepCwdUnder` | `[]` | Leftover processes running under these folders are killed at stop. |
| `adopt` | off | `{ cwdPattern?, probe }`: take in servers started by hand, read-only. |
| `optIns.services` | off | `{ path }`. Present: agents may ask for background services by name, with a reason; the names reach the server through `{services}` and `ctx.services`. `path` is required but not read yet. |
| `optIns.dedicatedDb` | off | `{ args, env }` added to the start when an agent asks for a database of its own, with a reason. |
| `urlTemplate` | `"http://localhost:{port}"` | URL handed to agents and opened by the UI. |

A provider module, minimal shape:

```js
// ~/.cocopilot/widgets-dev-server.mjs
export function settingsOverlay({ services }) {
  return { jobs: { enabled: services } };
}

export async function login({ url, path, user }) {
  const token = await mintDevToken(user ?? 'demo');
  return {
    url: new URL(path, url).href,
    seed: { storage: 'localStorage', origin: new URL(url).origin, entries: { 'widgets.token': token } },
  };
}
```

`mintDevToken` stands for however your app issues a dev session.
`settingsOverlay(ctx)` gets `{ project, worktree, appDir, file, port,
logDir, services, dedicatedDb, base }` and returns an object merged over
your content and `settings.overlay`. `login(ctx)` gets `{ id, project,
worktree, appDir, port, url, logDir, user?, path }` and returns `{ url,
seed?, expiresAt?, user? }`; the seed's origin must be the origin of `url`.

## Phone

coco has no login: on the Mac, a request is let in when it comes from
loopback with a `127.0.0.1`/`localhost` Host and no proxy header. Anything
else, a phone through `tailscale serve` above all, needs a paired device:
every path (pages, assets, API, event stream, artifacts) answers 401 to an
unpaired one, but `/pair`.

1. Expose coco on your tailnet: `tailscale serve --bg --https=443 http://127.0.0.1:8777`.
   Any reverse proxy works the same way (Caddy, caddy-tailscale…).
2. Add the name it serves under to `hosts` in coco.config.json, e.g.
   `"hosts": ["mac.tail1234.ts.net"]`, and restart coco.
3. On the Mac, open Settings > Devices and click Pair a phone. Scan the QR
   with the phone (its camera, or the coco app), or open the link it shows.
   A code pairs one device and lasts five minutes; the device keeps a cookie
   for a year. Ten wrong codes in a minute lock pairing for that minute.
4. For the Android app: build it once with `npm run apk` in `mobile/`
   (see [mobile/README.md](../mobile/README.md)), tick "then download the
   Android app" before scanning with the phone's camera, install the APK,
   then pair the app with a new code.

Settings > Devices lists the paired devices with when each was last seen;
Revoke cuts one off at once, its open event stream included. Devices are
paired and revoked from the Mac only. Tokens are stored as their sha256 in
`<dataDir>/devices.json`.

## MCP config

coco starts every agent through the Paseo daemon with the `@getpaseo/client`
SDK. It reaches the daemon at `PASEO_URL` when set, otherwise at the
endpoint `paseo status` reports (`ws://127.0.0.1:6767/ws` by default), with
`PASEO_PASSWORD` when the daemon asks for one. Ask runs and review plans get
the cocopilot MCP server (`server/mcp.ts`, its tools preapproved) in their
session config; nothing to configure. To mount the server in another
client, copy `server/mcp-config.example.json` and set the absolute path of
`server/mcp.ts`.

Every agent coco starts gets the `coco · ` title prefix, the providers of
`models` (`fast` for Notion syncs, `default` for the rest) and runs in a
workspace that already exists: the one on the work's stack worktree (the
row's, else the top-most open row's) for anything about a work, the repo's
otherwise. A workspace is created only when none is open on that directory,
and the run says so. Ask, Notion and review-plan agents are archived once
they end, failures included. A Paseo plugin that checks the provider
against the directory (an account guard, for example) applies to them like
to any agent: when it refuses, the run fails with its message.
