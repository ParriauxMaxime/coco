import { openExternalUrl, type PluginClientContext } from "@getpaseo/plugin/client";
import { contributeButtons } from "./client/buttons";
import { CocopilotPanel } from "./client/panel";
import { ReviewRunRow } from "./client/review-run-row";
import { ConnectionSettings } from "./client/settings";
import { REVIEW_RUN_KIND, homeRpc, resolveRpc, reviewRunSchema } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "work", title: "cocopilot", icon: "Compass", context: "workspace", Component: CocopilotPanel });
  client.addSettingsScreen({ id: "connection", title: "cocopilot", icon: "Compass", Component: ConnectionSettings });
  client.addTimelineRenderer({ kind: REVIEW_RUN_KIND, version: 1, schema: reviewRunSchema, Component: ReviewRunRow });

  client.addCommandCenterItem({
    id: "open-panel",
    title: "cocopilot: show this workspace's work",
    icon: "Compass",
    keywords: ["review", "pr", "work"],
    context: "workspace",
    onSelect: ({ openPanel }) => openPanel("work"),
  });
  client.addCommandCenterItem({
    id: "open-review",
    title: "cocopilot: open this PR's review",
    icon: "ScanSearch",
    keywords: ["review", "comments"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      const { home, links } = await rpc(resolveRpc, { cwd: workspace.directory, projectId: workspace.projectId, workspaceId: workspace.id });
      await openExternalUrl(links?.review ?? links?.plan ?? home);
    },
  });
  client.addCommandCenterItem({
    id: "open-home",
    title: "cocopilot: open",
    icon: "Compass",
    context: "global",
    async onSelect({ rpc }) {
      await openExternalUrl((await rpc(homeRpc, {})).url);
    },
  });

  return contributeButtons(client);
}
