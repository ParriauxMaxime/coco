import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { currentRun, linkAgent, resolveWorkspace, sendBrief, settleTurn, unlinkAgent } from "./server/cocopilot";
import { runFromLabels } from "./shared/labels";
import { REVIEW_RUN_KIND, addBriefRpc, connectionSettings, homeRpc, resolveRpc, type ReviewRun, type RunView } from "./shared/contracts";

// cocopilot settles a run whose agent stopped without a result file 15s after launch; ask again once past that.
const RESETTLE_MS = 20_000;

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(connectionSettings);
  const baseUrl = async () => {
    const current = await settings.read();
    return current.status === "ready" ? current.values.baseUrl : connectionSettings.schema.parse({}).baseUrl;
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();

  server.handle(homeRpc, async () => ({ url: await baseUrl() }));
  server.handle(resolveRpc, async (input) => resolveWorkspace(await baseUrl(), input));
  server.handle(addBriefRpc, async (input, { paseo }) => sendBrief(await baseUrl(), paseo, input));

  // One row per run, on the run's agent and on the agent that requested it; re-appending the same id updates both.
  const publish = async (paseo: PluginHookContext["paseo"], agent: PluginHookAgent, run: RunView) => {
    const data: ReviewRun = { kind: run.kind, title: run.title, number: run.pr, runId: run.runId, status: run.status, comments: run.comments, url: run.url };
    const item = { type: "plugin" as const, id: `cocopilot-run-${run.runId}`, kind: REVIEW_RUN_KIND, version: 1, data };
    const targets = [agent.id, agent.parentAgentId].filter((id): id is string => !!id);
    await Promise.all(targets.map((id) => paseo.agents.ref(id).timeline.append(item)));
  };

  const settle = async (agent: PluginHookAgent, paseo: PluginHookContext["paseo"], signal?: AbortSignal) => {
    const runs = await settleTurn(await baseUrl(), agent, signal);
    for (const run of runs) await publish(paseo, agent, run);
    return runs;
  };

  // Agents started by hand carry no cocopilot source label; cocopilot links those sitting in a PR row workspace.
  server.on("agent.created", async ({ agent }, { paseo, signal }) => {
    try {
      const labels = (await paseo.agents.ref(agent.id).refresh())?.agent.labels ?? {};
      if (!labels.source) await linkAgent(await baseUrl(), agent, signal);
    } catch (error) {
      console.error(`cocopilot link failed for ${agent.id}:`, error instanceof Error ? error.message : error);
    }
  });

  server.on("agent.archived", async ({ agent }, { signal }) => {
    try {
      await unlinkAgent(await baseUrl(), agent.id, signal);
    } catch (error) {
      console.error(`cocopilot unlink failed for ${agent.id}:`, error instanceof Error ? error.message : error);
    }
  });

  server.on("agent.turn_started", async ({ agent }, { paseo, signal }) => {
    try {
      const labeled = runFromLabels((await paseo.agents.ref(agent.id).refresh())?.agent.labels ?? {});
      if (!labeled) return;
      const run = await currentRun(await baseUrl(), labeled, signal);
      if (run.status === "running") await publish(paseo, agent, run);
    } catch (error) {
      console.error(`cocopilot turn start sync failed for ${agent.id}:`, error instanceof Error ? error.message : error);
    }
  });

  server.on("agent.turn_ended", async ({ agent }, { paseo, signal }) => {
    try {
      const runs = await settle(agent, paseo, signal);
      if (!runs.some((run) => run.status === "running")) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        settle(agent, paseo).catch((error) => console.error(`cocopilot resettle failed for ${agent.id}:`, error instanceof Error ? error.message : error));
      }, RESETTLE_MS);
      timers.add(timer);
    } catch (error) {
      console.error(`cocopilot turn sync failed for ${agent.id}:`, error instanceof Error ? error.message : error);
    }
  });

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
