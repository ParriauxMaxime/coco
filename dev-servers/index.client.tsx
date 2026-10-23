import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DevServersSettings } from "./client/settings.tsx";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({ id: "dev-servers", title: "Dev servers", icon: "Server", Component: DevServersSettings });
}
