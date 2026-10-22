# cocopilot

A local workbench to ship large features and PR stacks with Claude Code
agents, run through [Paseo](https://paseo.sh). You plan the stack, agents
build each PR in its own worktree, and cocopilot keeps what the agents
forget: the plan, the decisions, the review comments, the findings, and
what is left before each PR can merge.

[![cocopilot in one minute: plan, review, findings, gates](docs/media/overview.jpg)](docs/media/overview.mp4)

*One minute on a demo stack: plan and a decision, code review, findings
board, checklist gates ([mp4](docs/media/overview.mp4) ·
[webm](docs/media/overview.webm)).*

## What it does

- **Stack plan.** One page per work (a feature shipped as one PR or a
  stack): title, before/after table, PRs in merge order with their state,
  CI and reviewers, the next action, decision cards you answer with a click.
- **Code review.** An editor-like review per PR: changed files in a
  suggested reading order, Monaco diffs, go to definition and find
  references on the PR head (TypeScript language service), local comments
  anchored to lines that follow the code as the head moves.
- **Findings board.** Every remark on a PR in one list: persona reviews,
  agent reviews, your comments, GitHub reviewers, bots and failed CI.
  Grouped by spot, sorted worst first; accept, dismiss with a reason, or
  dispatch to an agent.
- **Agent threads.** Discuss a comment, a finding or a decision with a small
  scoped agent. It answers inline and suggests a commit; you approve, and
  cocopilot cherry-picks it onto the PR branch.
- **Checklist gates.** Each PR carries its gates, from self review to
  merged: skills to start in the PR agent, commands to copy, ticks derived
  from GitHub and git.
- **Stack keeper.** When a parent PR merges, a dry run shows the exact
  rebases for every child; apply them locally in one click.
- **Briefs and handoffs.** Render a full task brief for a PR agent from the
  work, start the agent, or hand the PR over to a fresh one.

Nothing in cocopilot pushes, posts or sends. Agents commit locally; you
push.

| | |
| --- | --- |
| ![Stack plan](docs/media/plan.png) | ![Code review](docs/media/review.png) |
| ![Findings board](docs/media/findings.png) | ![Agent thread](docs/media/thread.png) |

## Requirements

- Node 20 or later, and `git`.
- [GitHub CLI](https://cli.github.com) (`gh`), authenticated on the
  repository you work in.
- [Paseo](https://paseo.sh) with the Claude Code provider: cocopilot starts
  and reads agents through the `paseo` CLI.
- Optional: the claude.ai Notion and Slack connectors in Claude Code, for
  the Inbox (turn a Notion page or Slack thread into a work) and the Notion
  sync.

## Get started

```bash
git clone <this repo> cocopilot && cd cocopilot
npm ci
cp coco.config.example.json coco.config.json
```

Edit `coco.config.json`: set `repo.path` to your local checkout, `owner`
to your name and GitHub login, and delete the keys you do not need (each
has a default, see [docs/configuration.md](docs/configuration.md)).

Point the MCP config at this folder:

```bash
cp server/mcp-config.example.json server/mcp-config.json
# set "args" to the absolute path of server/mcp.mjs
```

Start it:

```bash
npm start
```

Open <http://127.0.0.1:8777>.

Install the Paseo plugin, so Paseo shows each workspace's work and tells
cocopilot when an agent's turn ends:

```bash
(cd paseo-plugin && npm ci)
paseo plugin install "$PWD/paseo-plugin"
```

Its URL defaults to `http://127.0.0.1:8777`; change it in Paseo under
Settings → Plugins → cocopilot.

Install the skills, so agents can report to cocopilot:

```bash
mkdir -p ~/.claude/skills
cp -R skills/coco-findings skills/coco-work ~/.claude/skills/
```

- `coco-findings`: post review findings to the Findings board.
- `coco-work`: work inside a cocopilot work (find the row, read the
  brief, report decisions and findings, never push).

Both read `COCO_URL` when cocopilot runs elsewhere than
`http://127.0.0.1:8777`.

Reviewer personas are optional: drop `<login>.md` files in `personasDir`
(`data/personas` by default), in the format of
[docs/examples/personas/alice.md](docs/examples/personas/alice.md).

## Security

cocopilot has no authentication. It reads your repository, runs `git` and
`gh` with your credentials, and starts agents in auto mode. It binds
`127.0.0.1` by default: keep it that way, and never expose it on a network
you do not fully trust. To use it from another device, tunnel the port
(SSH, Tailscale) rather than binding `0.0.0.0`.

## Development

```bash
npm run serve   # API server on 127.0.0.1:8777
npm run dev     # Vite on 127.0.0.1:8778, proxies /api
node --test server/*.test.mjs
```

## Documentation

- [docs/guide.md](docs/guide.md): every surface, what it reads and writes,
  and the HTTP routes agents call.
- [docs/configuration.md](docs/configuration.md): every config key.
- [paseo-plugin/OVERVIEW.md](paseo-plugin/OVERVIEW.md): the Paseo plugin.

## License

[MIT](LICENSE)
