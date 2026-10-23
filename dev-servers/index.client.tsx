import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, SCREEN_ID } from "./client/board.ts";
import { DevServersFooter } from "./client/footer.tsx";
import { ServersScreen } from "./client/list-screen.tsx";
import { DevServerPanel } from "./client/panel.tsx";
import { contributePills } from "./client/pills.ts";
import { DevServersSettings } from "./client/settings.tsx";
import { DevServerRow } from "./client/timeline-row.tsx";
import { TIMELINE_KIND, timelineRowSchema } from "./shared/contracts.ts";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSettingsScreen({ id: "dev-servers", title: "Dev servers", icon: "Server", Component: DevServersSettings }),
    client.addScreen({ id: SCREEN_ID, title: "Dev servers", Component: ServersScreen }),
    client.addSidebarFooterItem({ id: SCREEN_ID, title: "Dev servers", Component: DevServersFooter }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Dev server", icon: "Server", context: "workspace", Component: DevServerPanel }),
    client.addTimelineRenderer({ kind: TIMELINE_KIND, version: 1, schema: timelineRowSchema, Component: DevServerRow }),
    client.addCommandCenterItem({
      id: "open-servers",
      title: "Dev servers: show every server",
      icon: "Server",
      keywords: ["dev server", "port", "build"],
      context: "global",
      onSelect: ({ openScreen }) => openScreen({ screenId: SCREEN_ID }),
    }),
    client.addCommandCenterItem({
      id: "open-panel",
      title: "Dev server: this workspace",
      icon: "Server",
      keywords: ["dev server", "start", "logs"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(PANEL_ID),
    }),
    contributePills(client),
  ];
  return async () => {
    for (const remove of removers) await remove();
  };
}
