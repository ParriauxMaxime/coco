Runs the app dev servers of the worktrees your agents work in: one server per worktree, on a port that stays the same across restarts, shared by every agent, stack row and person that needs it. Agents ask for a server through MCP tools instead of starting their own; ports, builds, process cleanup, background services and logins are the plugin's job.

## Setup

`npm ci` in `<cocopilot>/dev-servers`, then `paseo plugin install <cocopilot>/dev-servers` (Node 22.6+). Settings → Plugins → coco dev servers sets the config file whose `devServers` key the plugin reads (`~/cocopilot/coco.config.json` by default) and an API port, and shows whether the config loaded, its projects, state directory and API address. Leave the API port empty: coco reaches the plugin on `devServers.api.port`, so a different port here cuts coco off. Every key of `devServers` is in cocopilot's `docs/configuration.md`. State lives in `~/.cocopilot/dev-servers` (`stateDir`): `state.json`, the port registry, leases, kept settings and `logs/<server>/run.log`.

Agents created before the install have no tools: they use the HTTP API.

## States

| State | Shown as | Meaning |
| --- | --- | --- |
| `prewarming` | prebuilding | A prebuild builds it with every opt-in off; stops once ready |
| `building` | building | Started, not serving yet; `progress` from the log |
| `ready` | ready | Serving and held by someone |
| `idle` | idle | Serving, held by nobody; stops at `idleStopAt` unless pinned or started again |
| `crashed` | crashed | The log matched `logPatterns.crash` or the process exited; `lastError` says why. A dev tool that rebuilds on the next file change turns it back to `building` |
| `stopping`, `stopped` | stopping, stopped | Being stopped, or stopped (also after a machine restart) |
| `external` | started by hand | Adopted, read-only (see Cap) |

## Placement

A start picks the worktree to serve from, then starts that worktree's server or reuses it. The reply's `placement` is `{ mode, servedFrom, because[], ambiguous? }`, with `mode` one of `own`, `stack-top`, `stack-running`, `dedicated`, `external`. `because` always says why, one reason per line.

| Rule, first match wins | Serves from |
| --- | --- |
| `dedicated`, `services` or `dedicatedDb` asked | the caller's worktree (`dedicated`) |
| The caller's worktree has uncommitted changes (gitignored files do not count) | its own |
| `serveFrom` names a worktree containing the caller's commit | that worktree; one that does not (restacked) gives the caller its own |
| The caller's own server already runs | its own |
| Its commit is already on `origin`'s default branch, or no worktree builds on it | its own |
| A running server in a clean worktree contains its commit | that server (`stack-running`, or `stack-top` when it is the top); nothing builds |
| One stack top (a worktree under `worktreeRoots` or `mainCheckout` whose commit contains the caller's, with nothing built on it) | that top (`stack-top`) |
| Several tops | the one coco ranks latest in the caller's work (`GET /api/paseo-link/stack?branch=` on `coco.url`); when coco cannot tell, its own, with `placement.ambiguous.options` to pass as `serveFrom` next time |

A top with uncommitted changes still serves; `because` lists its changed files. When the caller's worktree changes so that a server it holds would no longer serve it (new uncommitted changes, a restack), `dev_server_status` marks that server `stale` with `stale.because`.

## Leases, idle stop, pins

- A start takes a lease; stop, archiving the agent, the server stopping, or `leaseTtlMinutes` (240) without use releases it. Use is any agent tool call, a start, a pin, `GET /api/servers/<id>` or a log read; Paseo screen reads and `touch=false` log reads do not count.
- A server nobody holds turns `idle` and stops after `idleStopMinutes` (30) unless pinned. Deadlines are stored as timestamps and re-armed after a reload.
- Stop without `force` releases the caller's lease and stops only when nobody else holds it and it is not pinned; otherwise the reply says `kept: "leased" | "pinned" | "external"`. A forced stop (HTTP and Paseo only) stops it anyway, and its other holders get a lost notice.
- A pin keeps a server through idle and eviction. An agent can undo its own pin only; Paseo and HTTP callers can undo any.
- Each holder is `{ kind: "agent" | "coco" | "user", id, title? }`. An agent's id is its secret lease key, issued at creation and bound to the agent when its session opens.

Replies never carry a lease key. A server in a reply lists `leases: [{ id, kind, holderId, title, agentId, mine, since, lastUsedAt }]`, where `holderId` is `null` for agents (the id of a coco or user holder otherwise), `mine` is relative to the caller, and `pinnedBy` is a name, not a holder. `lease` in a start reply is `{ id }`, the lease's own id.

An agent whose server was stopped under it (eviction, forced stop, an external server gone) finds `lost: [{ id, worktree, why, at, message }]` in its next tool reply and a row in its timeline.

## Cap, eviction, servers started by hand

- At most `cap` (3) servers run: building, ready, idle, crashed with a live process, prebuilds while they build, and `external` ones.
- A start at the cap cancels a prebuild first, else stops the least recently used server that is neither pinned nor external and lists it under `evicted`. When every slot is pinned or external: `capacity_full` with the list.
- A project with `adopt` takes in dev servers started by hand: every 30 s and before each start, a listener whose directory is `<worktree>/<appDir>` of a project worktree (matching `adopt.cwdPattern` when set) and whose port answers `adopt.probe` shows as `external`. It counts toward the cap and serves its worktree (and the worktrees below it when clean); the plugin never stops, evicts, pins or reads it. Asking it for opt-ins gives `external_readonly`; asking for services while one runs warns that they may run twice. It leaves the list once it stops listening.

## Opt-ins

Background services (`services: [...]`) and a dedicated database (`dedicatedDb: true`) are off unless asked, with a `reason` (else `reason_required`), and always run in the caller's worktree. They reach the server through the `{services}` placeholder and `optIns.dedicatedDb.args` / `env`. A running server without them restarts with them when the caller is its only holder; otherwise `held_by_others` lists the holders.

## Prebuild and warm

- `warm` fills a fresh worktree from the same paths in `mainCheckout` before its first start: `symlink` (for example `node_modules`), `clone` (a build cache, copy-on-write: `cp -c` on APFS, `cp --reflink=auto` on Linux, a plain copy elsewhere), `copyIfMissing`. An existing path is never touched; a cache is not cloned while the main checkout's server builds.
- With `warm.prebuild`, every workspace Paseo creates for the project (not the main checkout) is queued: warmed, built as `prewarming` with every opt-in off, stopped once ready. One at a time, oldest first; the queue survives reloads.
- A prebuild counts toward the cap only while it builds and never evicts: at the cap it waits. A start at the cap cancels it (back to the end of the queue; dropped after three cancellations). A start for a queued worktree takes the job out; a start during its build takes it over without a restart.
- Archiving a workspace drops its queued prebuild and the leases of its agents. Its server stops unless pinned, external or held from another worktree; then its port, record and kept settings are forgotten.

## Settings overlay provider

`settings.file` (relative to the worktree, plain JSON) is written before each start as your own content, then the templated `settings.overlay`, then what `settingsOverlay(ctx)` of the project's `provider` module returns, merged key by key (`null` replaces). `ctx` is `{ project, worktree, appDir, file, port, logDir, services, dedicatedDb, base }`, `base` being your own content. Your content is kept in `stateDir/base/`; a stop writes it back, or removes the file if you had none. A hand edit to the generated file is backed up and folded into your content at the next start.

## Login provider

`login(ctx)` of the `provider` module opens a ready server logged in. `ctx` is `{ id, project, worktree, appDir, port, url, logDir, user?, path }`; it returns `{ url, seed?, expiresAt?, user? }`, where `seed` is `{ storage: "localStorage", origin, entries }` on the origin of `url` and `user` a string id or `{ id, ... }`. The reply adds `apply: { open, function, script, then }`: open `apply.open`, run `apply.function` there (it returns the origin), then go to `apply.then`; a browser tool with an init script can run `apply.script` instead. Errors: `not_ready` before the server serves, `login_unavailable` without a `login` export, `login_failed` when it throws, returns another shape or exceeds `login.timeoutSeconds` (60).

## MCP tools

Every agent Paseo creates in a configured project (any provider; `injectMcp: "all"` for every directory, `"off"` for none) gets a `dev-servers` MCP server at `/mcp` on the API port, loaded up front and preapproved.

| Tool | Input | Does |
| --- | --- | --- |
| `dev_server_start` | `cwd?`, `serveFrom?`, `dedicated?`, `services?`, `dedicatedDb?`, `reason?`, `pin?`, `waitSeconds?` (≤ 50) | Places, starts or reuses, takes a lease. `{ server, placement, lease, evicted?, next }` |
| `dev_server_status` | `id?`, `all?` | The servers you hold, else your worktree's; `all`: every server. Each with `next`, `stale` when it applies |
| `dev_server_stop` | `id?` | Releases your lease; stops when nobody else holds it and it is not pinned. No `force` |
| `dev_server_pin` | `id?`, `pinned` (true) | Pins, or undoes your own pin |
| `dev_server_logs` | `id?`, `lines` (100), `grep?`, `source` (`run`) | Log tail, `grep` a case-insensitive regex |
| `dev_server_login` | `server?`, `user?`, `path?` | See Login provider |

Without an id, a tool takes the one server you hold, else your worktree's; holding several needs the id. `next` always says what to do now. Errors come back as `{ error: { code, message, details? } }` with `isError`.

## HTTP API

`http://127.0.0.1:8779` (`devServers.api`). Loopback Host and Origin only, so a web page cannot drive it; POST bodies must be `application/json` (64 KB max). Errors: `{ error: { code, message, details? } }`.

| Route | Does |
| --- | --- |
| `GET /api/board` | `{ error, cap, servers, lost }`: every server and every lost notice, as the Paseo screens and coco show them |
| `GET /api/servers` | `{ servers }` |
| `GET /api/servers/<id>` | `{ server }`; counts as use |
| `POST /api/servers/start` | Start input with `cwd` required, plus `holder?` |
| `POST /api/servers/<id>/stop` | `{ force?, holder? }` |
| `POST /api/servers/<id>/pin` | `{ pinned?, holder? }` |
| `POST /api/servers/<id>/login` | `{ user?, path? }` |
| `GET /api/servers/<id>/logs` | `?lines=&grep=&source=`; `touch=false` reads without counting as use |
| `GET /api/placement` | `?cwd=&serveFrom=&dedicated=`: where a start would go; starts nothing |
| `GET /healthz` | `{ ok: true }` |

`holder` is `{ kind: "coco" | "user", id, title? }`, `{ kind: "user", id: "http" }` when absent; each distinct holder takes its own lease. coco holds one per stack row (`coco`, `<work>/<row>`).

| Code | Status | When |
| --- | --- | --- |
| `bad_request` | 400 | Invalid input, unknown opt-in, several held servers and no id |
| `not_found` | 404 | No such server or route |
| `not_a_project_worktree` | 422 | `cwd` is not in a git worktree of a configured project |
| `reason_required` | 422 | Opt-ins without `reason` |
| `capacity_full` | 409 | Every slot is pinned or external |
| `external_readonly` | 409 | Opt-ins, pin or forced stop on an external server |
| `held_by_others` | 409 | Opt-ins on a shared server; unpinning another holder's pin as an agent |
| `not_ready` | 409 | Login before the server serves |
| `port_unavailable` | 503 | No free port in the range |
| `start_failed` | 500 | The command, its directory or the settings file failed |
| `login_unavailable`, `login_failed` | 501, 502 | See Login provider |
| `forbidden_host`, `forbidden_origin`, `unsupported_media_type`, `payload_too_large`, `method_not_allowed` | 403, 403, 415, 413, 405 | Request guard |

## Paseo UI and RPCs

- Sidebar footer: slots taken and how many build or crashed (`Dev servers 2/3 · 1 building`); opens the Dev servers screen.
- Dev servers screen: a card per server (worktree, branch, port, url, state, holders, pin, opt-ins and reason, idle stop, lost notices) with Open, Open logged in (opens the server, then one snippet to paste in its developer console), Logs, Pin / Unpin, and Stop after a confirmation: a plain stop when only you hold it, a forced stop naming who loses it otherwise.
- Dev server workspace panel (also in ⌘K): which server serves this worktree and why, Start, Start dedicated, a stack-top picker when the plugin cannot tell, the card with its logs open.
- A composer pill per agent holding a server (state and port; opens the panel), and a timeline row when its build turns ready or its server is lost.
- A server started from Paseo is held by you (`user`, `paseo`) until you stop it. The screens poll every few seconds; their log reads do not count as use.

RPCs, on the same service as HTTP and MCP: `config.status` (the settings screen), `servers.board` (the `GET /api/board` shape), and `servers.placement`, `servers.start`, `servers.stop`, `servers.pin`, `servers.logs`, `servers.login`, which answer `{ ok: true, value }` or `{ ok: false, error }`.

## What survives what

| Event | Servers | API and MCP | On the next plugin start |
| --- | --- | --- | --- |
| Plugin reload | keep running (own process group, output to files) | down for seconds | re-adopted by pid, start time and directory; a reused pid is never touched; deadlines re-armed |
| Failed reload | keep running; idle stops paused | down until fixed | same, once fixed |
| Daemon restart, app quit | keep running (own session; verified on Paseo 0.12) | down | same |
| Machine restart | gone | n/a | marked `stopped` ("stopped by a machine restart"); ports and pins kept; nothing restarts |
| Plugin disabled or removed | keep running, unmanaged | down | n/a |

Stop servers before disabling or removing the plugin: Stop on each card, or `POST /api/servers/<id>/stop` with `force: true`. A "Stop all" action and a disable flow that asks for it are planned, not built yet.

## Known limits

- No "Stop all", and nothing offers to restart pinned servers after a machine restart.
- A crashed server's exit code is lost after a re-adopt; `lastError` comes from the log.
- `source: "app"` log reads find nothing: no config key sets an app log yet.
- Lease keys bind first in, first out per directory: two agents created in the same worktree at the same instant can swap keys (harmless, same worktree).
- The API lives in the plugin worker: every reload takes it down for a moment.
- Only loopback binds; macOS and Linux only (`ps`, `lsof`).
