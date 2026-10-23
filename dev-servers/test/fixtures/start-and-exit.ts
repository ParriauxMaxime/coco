// Plays a plugin worker that starts a server and dies right after, as a reload does.
import { parseConfig } from "../../server/config.ts";
import { openStateStore } from "../../server/store.ts";
import { createSupervisor } from "../../server/supervisor.ts";

const { stateDir, worktree, port, project } = JSON.parse(process.argv[2]);
const [widgets] = parseConfig({ projects: [project] }).projects;
const store = openStateStore(stateDir);
await store.load();
const supervisor = createSupervisor({ store, stateDir, project: () => widgets });
const record = await supervisor.start({ project: widgets, worktree, port, reserved: [port] });
supervisor.close();
process.stdout.write(JSON.stringify(record));
process.exit(0);
