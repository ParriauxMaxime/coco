# Set up cocopilot (for the agent)

You are a coding agent installing or updating cocopilot for the user. Do
every step you can on your own; ask the user only for what you cannot
detect. Never push, never post, never bind the server to anything but
`127.0.0.1`.

Report at the end: fresh install or update, what you installed or changed,
the config you wrote or left alone, and anything left for the user.

## Prerequisites

Check each one and stop with a clear message on the first one missing:

```bash
node --version         # 20 or later
git --version
gh auth status         # logged in
paseo --version        # https://paseo.sh
```

`gh auth login` and the Paseo install are interactive: tell the user the
command, do not run it.

## Find an existing install

Look for one before cloning anything. `$APP` is the first checkout found:

1. The current directory, when it has `server/index.ts` and
   `paseo-plugin/`.
2. A running server: `curl -s http://127.0.0.1:8777/api/setup` answers with
   `guide`, the path of this file inside `$APP`.
3. The Paseo plugin: `paseo plugin ls --json`, the `path` of id
   `cocopilot` is `$APP/paseo-plugin` (resolve symlinks).
4. `~/cocopilot`.

Found: this is an **update**. Everything the user owns stays: the config
file, `dataDir` (works, comments, findings), personas, and any skill or
plugin they edited. Not found: this is a **fresh install**.

## Steps

1. **Code.**
   - Fresh install:

     ```bash
     git clone https://github.com/ParriauxMaxime/coco.git ~/cocopilot
     cd ~/cocopilot && npm ci
     ```

   - Update: `git -C "$APP" status --porcelain` must be empty; when it is
     not, show the changes and ask before going on. Then:

     ```bash
     git -C "$APP" pull --ff-only && (cd "$APP" && npm ci)
     ```

     A refused fast-forward means local commits: stop and ask.

2. **Skills.** First read `skillOverrides` and `methodSkill` in the config.
   A shipped skill named in `skillOverrides` (or `coco-work` when
   `methodSkill` is set) is replaced by the user's own: never install, diff
   or overwrite it; only check that the replacement exists. For every other
   `$APP/skills/<name>`:
   - missing in `~/.claude/skills/`: copy it;
   - identical: nothing to do;
   - different: show `diff -r` and ask. Older copy: replace it. The user's
     own edits they want to keep: add `"<name>": "<name>"` to
     `skillOverrides` in the config instead. Never overwrite without a yes.

3. **Paseo plugins.** Two plugins, each handled the same way from
   `paseo plugin ls --json`:

   | Id | Folder |
   | --- | --- |
   | `cocopilot` | `$APP/paseo-plugin` |
   | `coco-dev-servers` | `$APP/dev-servers` (needs Node 22.6+) |

   - absent:

     ```bash
     (cd "$APP/<folder>" && npm ci) && paseo plugin install "$APP/<folder>"
     ```

   - installed from `$APP/<folder>`: run `npm ci` there, then
     `paseo plugin reload <id>`; `paseo plugin enable <id>` when it is
     disabled;
   - installed from another path: ask before `paseo plugin remove <id>` and
     installing from `$APP`.

   If Paseo answers that plugins are disabled, ask the user before enabling
   them.

   `coco-dev-servers` reads the `devServers` key of
   `~/cocopilot/coco.config.json`. When `$APP` is elsewhere, tell the user
   to set Settings → Plugins → coco dev servers → config file to
   `$APP/coco.config.json`, and to leave its API port empty. It runs no
   server until `devServers.projects` lists one
   ([configuration.md](configuration.md#dev-servers)). Agents created
   before the install have no `dev_server_*` tools; they can call the HTTP
   API on `127.0.0.1:8779`, and new agents get the tools.

4. **Config.** When `$APP/coco.config.json` exists, never rewrite it; only
   add the `skillOverrides` entries the user agreed to in step 2. On an
   update, compare its top-level keys with `coco.config.example.json` and
   list the new ones with their line in `docs/configuration.md`; the
   defaults already apply, so adding them is the user's call.

   Fresh install: ask the user which repository they work in, then detect
   the rest:

   | Key | Source |
   | --- | --- |
   | `owner.login` | `gh api user -q .login` |
   | `owner.name` | `gh api user -q .name`, first name |
   | `repo.path` | the user's answer, absolute |
   | `repo.github` | `gh repo view --json nameWithOwner -q .nameWithOwner` in the repo |
   | `repo.defaultBranch` | `git symbolic-ref --short refs/remotes/origin/HEAD`, without `origin/` |
   | `repo.tsconfig` | `tsconfig.json` at the repo root, if any |
   | `repo.rules` | the files among `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and rule folders (`docs/rules/`, `.agents/rules/`) that exist |
   | `repo.commitConvention` | from the repo rules or the last 20 commit subjects; empty when unclear |
   | `importRoots` | `["/tmp", "/private/tmp", "~/.paseo/worktrees", <repo.path>]` |

   Write only those keys to `$APP/coco.config.json`; everything else keeps
   its default. `coco.config.example.json` shows the other keys and
   `docs/configuration.md` explains each: mention gates, personas and
   rituals to the user, do not fill them in.

5. **Personas (optional, fresh install).** Ask whether the user wants
   reviewer personas now. If yes, point to
   `docs/examples/personas/alice.md` and the `personasDir` key; do not
   write personas for them.

6. **Start.** If a cocopilot server already runs on port 8777
   (`curl -s http://127.0.0.1:8777/api/setup`), tell the user to restart it
   (`npm start` in `$APP`, which also rebuilds the UI): an update or a new
   config only applies after a restart. Never kill it yourself. Otherwise
   start it in the background:

   ```bash
   cd "$APP" && npm start
   ```

7. **Check.** `curl -s http://127.0.0.1:8777/api/setup` lists every step
   with `done`. Every step but `work`, `personas` and `skills-current` must
   be done; fix what is not, or explain why you cannot. `skills-current`
   open means a skill the user chose to keep: say which.

Then tell the user to open <http://127.0.0.1:8777>: the Dashboard
checklist shows what is left, the first work included.
