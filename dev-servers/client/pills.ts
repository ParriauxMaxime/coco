import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { boardRpc, type Board } from "../shared/contracts.ts";
import { pillFor, serversOfAgent } from "../shared/view-model.ts";
import { PANEL_ID } from "./board.ts";

const POLL_MS = 10_000;

type AgentState = { workspaceId: string; pill: PluginButtonRegistration | null; label: string | null };

// A pill in the composer of each agent holding a dev server: its state and port; pressing it opens the workspace's Dev server panel.
export function contributePills(client: PluginClientContext) {
  const agents = new Map<string, AgentState>();
  const lifetime = new AbortController();
  let board: Board | null = null;

  const sync = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent || lifetime.signal.aborted) return;
    const pill = board ? pillFor(serversOfAgent(board, agentId)) : null;
    if (!pill) {
      agent.pill?.remove();
      agent.pill = null;
      agent.label = null;
      return;
    }
    const key = `${pill.label}|${pill.title}`;
    if (agent.pill && agent.label === key) return;
    const { workspaceId } = agent;
    const next: PluginButton = {
      title: pill.title,
      icon: "Server",
      label: pill.label,
      behavior: { kind: "action", onPress: () => client.openPanel(PANEL_ID, { workspaceId, agentId }) },
    };
    agent.label = key;
    if (agent.pill) agent.pill.update(next);
    else agent.pill = client.addComposerPill({ id: "dev-server", workspaceId, agentId, button: next });
  };

  const upsert = (agent: { id: string; workspaceId?: string | null }) => {
    if (!agent.workspaceId) return;
    const existing = agents.get(agent.id);
    if (existing && existing.workspaceId !== agent.workspaceId) remove(agent.id);
    if (!agents.has(agent.id)) agents.set(agent.id, { workspaceId: agent.workspaceId, pill: null, label: null });
    sync(agent.id);
  };

  function remove(agentId: string) {
    agents.get(agentId)?.pill?.remove();
    agents.delete(agentId);
  }

  const poll = async () => {
    if (lifetime.signal.aborted || !agents.size) return;
    try {
      board = await client.rpc(boardRpc, {});
    } catch (error) {
      if (!lifetime.signal.aborted) console.warn("dev servers: board poll failed", error);
      return;
    }
    for (const agentId of agents.keys()) sync(agentId);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set(entries.map(({ agent }) => agent.id));
          for (const id of [...agents.keys()]) if (!seen.has(id)) remove(id);
          for (const { agent } of entries) upsert(agent);
          void poll();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") upsert(update.agent);
          else remove(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("dev servers: agent observation failed", error);
    });

  const timer = setInterval(() => void poll(), POLL_MS);

  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const id of [...agents.keys()]) remove(id);
  };
}
