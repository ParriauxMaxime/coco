Runs the app dev servers of the worktrees your agents work in: one server per worktree, on a port that stays the same across restarts, so agents ask for a server instead of each starting their own.

The plugin reads the `devServers` key of a JSON config file. Settings → Plugins → coco dev servers sets that file (`~/cocopilot/coco.config.json` by default) and the API port, and shows whether the config loaded and which projects it lists. Each project says how to recognize its repository, which command starts its dev server, and which port range to use.

Ports come from the project's range, one step at a time. A worktree keeps its port until its directory is removed. Excluded ports and ports another process listens on are skipped, and every port a server reserves, such as a debugger port at a fixed offset, stays apart from the ports of other worktrees. State lives in `~/.cocopilot/dev-servers` by default.

Each server runs in its own process group, detached from Paseo, with its output appended to `logs/<server>/run.log` in the state directory, so it keeps running when the plugin reloads or the daemon restarts. On its next start the plugin finds its servers again from the recorded pid, start time and directory; a pid that now belongs to another process is never touched. The plugin follows each server through building, ready and crashed from its log and an HTTP check, and a stop ends the whole process group, then any leftover process still running in the directories the project lists.

A JSON API on `127.0.0.1` (port 8779 by default) starts, lists, stops and tails the servers: `POST /api/servers/start` with `{ "cwd": "<worktree path>" }`, `GET /api/servers`, `GET /api/servers/<id>`, `POST /api/servers/<id>/stop`, `GET /api/servers/<id>/logs?lines=100&grep=error`. POST bodies must be `application/json`, and requests from a non-loopback Host or Origin are refused, so web pages cannot drive it. Errors come back as `{ "error": { "code", "message" } }`.

Work in progress: each worktree is served by its own server; MCP tools, stack sharing, capacity limits and screens come next.
