import { openExternalUrl, type PluginButton, type PluginButtonMenuEntry, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { addBriefRpc, describeRun, homeRpc, resolveRpc, runUrl } from "../shared/contracts";
import { runFromLabels } from "../shared/labels";
import { ParrotIcon } from "./parrot";
import { requestBrowserTab } from "./pending-browser";

type Link = RpcOutput<typeof resolveRpc>;
type WorkspaceState = { directory: string; projectId: string; link: Link | null; header: PluginButtonRegistration | null };
type AgentState = {
  workspaceId: string;
  labels: Readonly<Record<string, string>>;
  pill: PluginButtonRegistration | null;
  runPill: PluginButtonRegistration | null;
  briefPill: PluginButtonRegistration | null;
};

const TICK_MS = 15_000;
const LINKED_EVERY_N_TICKS = 4;
const UNLINKED_EVERY_N_TICKS = 20;

const isLinked = (link: Link | null): link is Link & { work: NonNullable<Link["work"]>; links: NonNullable<Link["links"]> } =>
  !!link?.work && !!link.links;
const runningRuns = (link: Link | null) => (link?.runs ?? []).filter((run) => run.status === "running");

function describe(link: Link) {
  const running = runningRuns(link)[0];
  if (running) return `${describeRun(running)} running`;
  if (!link.pr) return "cocopilot";
  const open = link.pr.comments.open ?? 0;
  return open ? `#${link.pr.number} · ${open} open` : `#${link.pr.number}`;
}

// Shows a cocopilot button in the header of each workspace linked to a work, a pill in each of its agents' composers,
// a run pill on each agent cocopilot launched, and an "add work brief" pill on agents started by hand in a PR row workspace.
export function contributeButtons(client: PluginClientContext) {
  const workspaces = new Map<string, WorkspaceState>();
  const agents = new Map<string, AgentState>();
  const lifetime = new AbortController();
  let tick = 0;
  let home: Promise<string> | null = null;
  const homeUrl = () => (home ??= client.rpc(homeRpc, {}).then(({ url }) => url));

  const openItems = (id: string, title: string, icon: string, url: string, workspaceId: string): PluginButtonMenuEntry[] => [
    { kind: "item", id: `${id}-browser`, title: `${title} · open in browser`, icon, behavior: { kind: "action", onPress: () => openExternalUrl(url) } },
    {
      kind: "item",
      id: `${id}-tab`,
      title: `${title} · open in Paseo tab`,
      icon: "PanelTop",
      behavior: {
        kind: "action",
        onPress: () => {
          requestBrowserTab({ workspaceId, url });
          client.openPanel("work", { workspaceId });
        },
      },
    },
  ];

  const button = (link: Link & { links: NonNullable<Link["links"]> }, workspaceId: string): PluginButton => {
    const runs: PluginButtonMenuEntry[] = runningRuns(link).flatMap((run) => [
      {
        kind: "item" as const,
        id: `run-${run.runId}-agent`,
        title: `${describeRun(run)} ${run.runId} running · show its agent`,
        icon: "Bot",
        behavior: { kind: "action" as const, onPress: () => client.openPanel("work", { workspaceId }) },
      },
      ...openItems(`run-${run.runId}`, `${describeRun(run)} ${run.runId}`, "Wrench", run.url, workspaceId),
    ]);
    const items = [
      ...runs,
      ...openItems("plan", "Plan", "Map", link.links.plan, workspaceId),
      ...(link.links.pr ? openItems("pr", `PR #${link.pr?.number} details`, "GitPullRequest", link.links.pr, workspaceId) : []),
    ];
    return { title: `cocopilot: ${link.work?.title}`, icon: ParrotIcon, label: describe(link), behavior: { kind: "menu", items } };
  };

  const syncRunPill = async (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent || lifetime.signal.aborted) return;
    const labeled = runFromLabels(agent.labels);
    if (!labeled) {
      agent.runPill?.remove();
      agent.runPill = null;
      return;
    }
    const url = runUrl(await homeUrl(), labeled);
    const current = agents.get(agentId);
    if (!current || current !== agent || lifetime.signal.aborted) return;
    const next: PluginButton = {
      title: `cocopilot ${describeRun(labeled)} ${labeled.runId} on ${labeled.slug} (${labeled.commentCount} comments)`,
      icon: ParrotIcon,
      label: `${describeRun(labeled)} · ${labeled.slug}`,
      behavior: { kind: "menu", items: openItems("run", `Run ${labeled.runId}`, "Wrench", url, agent.workspaceId) },
    };
    if (agent.runPill) agent.runPill.update(next);
    else agent.runPill = client.addComposerPill({ id: "cocopilot-run", workspaceId: agent.workspaceId, agentId, button: next });
  };

  const syncPill = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent || lifetime.signal.aborted) return;
    const link = workspaces.get(agent.workspaceId)?.link ?? null;
    if (!isLinked(link)) {
      agent.pill?.remove();
      agent.pill = null;
      return;
    }
    const next = button(link, agent.workspaceId);
    if (agent.pill) agent.pill.update(next);
    else agent.pill = client.addComposerPill({ id: "cocopilot", workspaceId: agent.workspaceId, agentId, button: next });
  };

  const syncBriefPill = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent || lifetime.signal.aborted) return;
    const state = workspaces.get(agent.workspaceId);
    const row = state?.link?.row ?? null;
    if (!state || !row || agent.labels.source) {
      agent.briefPill?.remove();
      agent.briefPill = null;
      return;
    }
    const { workspaceId } = agent;
    const send = async () => {
      await client.rpc(addBriefRpc, { agentId, workspaceId, cwd: state.directory });
      await resolve(workspaceId);
    };
    const next: PluginButton = row.briefed.includes(agentId)
      ? {
          title: `The work brief for ${row.label} was sent to this agent`,
          icon: "FileCheck",
          label: "work brief sent",
          behavior: { kind: "menu", items: [{ kind: "item", id: "brief-again", title: `Send the ${row.label} work brief again`, icon: "Send", behavior: { kind: "action", onPress: send } }] },
        }
      : { title: `Send the work brief for ${row.label} to this agent`, icon: "FileText", label: "add work brief", behavior: { kind: "action", onPress: send } };
    if (agent.briefPill) agent.briefPill.update(next);
    else agent.briefPill = client.addComposerPill({ id: "cocopilot-brief", workspaceId, agentId, button: next });
  };

  const syncWorkspace = (workspaceId: string) => {
    const state = workspaces.get(workspaceId);
    if (!state || lifetime.signal.aborted) return;
    if (!isLinked(state.link)) {
      state.header?.remove();
      state.header = null;
    } else {
      const next = button(state.link, workspaceId);
      if (state.header) state.header.update(next);
      else state.header = client.addHeaderButton({ id: "cocopilot", workspaceId, button: next });
    }
    for (const [agentId, agent] of agents) {
      if (agent.workspaceId !== workspaceId) continue;
      syncPill(agentId);
      syncBriefPill(agentId);
    }
  };

  const resolve = async (workspaceId: string) => {
    const state = workspaces.get(workspaceId);
    if (!state) return;
    const { directory, projectId } = state;
    try {
      const link = await client.rpc(resolveRpc, { cwd: directory, projectId, workspaceId });
      const current = workspaces.get(workspaceId);
      if (!current || current.directory !== directory) return;
      current.link = link;
      syncWorkspace(workspaceId);
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn(`cocopilot resolve failed for ${workspaceId}`, error);
    }
  };

  const upsertWorkspace = (workspace: { id: string; projectId: string; workspaceDirectory?: string; projectRootPath: string }) => {
    const directory = workspace.workspaceDirectory ?? workspace.projectRootPath;
    const existing = workspaces.get(workspace.id);
    if (existing?.directory === directory && existing.projectId === workspace.projectId) return;
    workspaces.set(workspace.id, { directory, projectId: workspace.projectId, link: existing?.link ?? null, header: existing?.header ?? null });
    void resolve(workspace.id);
  };

  const removeWorkspace = (workspaceId: string) => {
    workspaces.get(workspaceId)?.header?.remove();
    workspaces.delete(workspaceId);
  };

  const upsertAgent = (agent: { id: string; workspaceId?: string | null; labels?: Record<string, string> }) => {
    if (!agent.workspaceId) return;
    const labels = agent.labels ?? {};
    const existing = agents.get(agent.id);
    if (existing && existing.workspaceId !== agent.workspaceId) removeAgent(agent.id);
    const kept = agents.get(agent.id);
    const relabeled = !kept || JSON.stringify(runFromLabels(kept.labels)) !== JSON.stringify(runFromLabels(labels));
    const state = kept ?? { workspaceId: agent.workspaceId, labels, pill: null, runPill: null, briefPill: null };
    state.labels = labels;
    agents.set(agent.id, state);
    syncPill(agent.id);
    syncBriefPill(agent.id);
    if (relabeled) void syncRunPill(agent.id);
  };

  function removeAgent(agentId: string) {
    const agent = agents.get(agentId);
    agent?.pill?.remove();
    agent?.runPill?.remove();
    agent?.briefPill?.remove();
    agents.delete(agentId);
  }

  const fail = (what: string) => (error: unknown) => {
    if (!lifetime.signal.aborted) console.error(`cocopilot ${what} observation failed`, error);
  };

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      lifetime.signal.addEventListener("abort", () => void subscription.release());
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set(entries.map((workspace) => workspace.id));
          for (const id of workspaces.keys()) if (!seen.has(id)) removeWorkspace(id);
          for (const workspace of entries) upsertWorkspace(workspace);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsertWorkspace(update.workspace);
          else removeWorkspace(update.id);
        },
      });
      return undefined;
    })
    .catch(fail("workspace"));

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set(entries.map(({ agent }) => agent.id));
          for (const id of agents.keys()) if (!seen.has(id)) removeAgent(id);
          for (const { agent } of entries) upsertAgent(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsertAgent(update.agent);
          else removeAgent(update.agentId);
        },
      });
      return undefined;
    })
    .catch(fail("agent"));

  const timer = setInterval(() => {
    tick += 1;
    for (const [workspaceId, state] of workspaces) {
      const every = runningRuns(state.link).length ? 1 : isLinked(state.link) ? LINKED_EVERY_N_TICKS : UNLINKED_EVERY_N_TICKS;
      if (tick % every === 0) void resolve(workspaceId);
    }
  }, TICK_MS);

  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const id of [...workspaces.keys()]) removeWorkspace(id);
    for (const id of [...agents.keys()]) removeAgent(id);
  };
}
