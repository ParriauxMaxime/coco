import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { configStatusRpc, pluginSettings } from "../shared/contracts.ts";

const CONFIG_STATUS_KEY = ["config-status"];

const parsePort = (text: string): number | null | undefined => {
  if (!text.trim()) return null;
  const port = Number(text.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
};

function ConfigStatus() {
  const configStatus = useRpc(configStatusRpc);
  const query = useQuery({ queryKey: CONFIG_STATUS_KEY, queryFn: () => configStatus({}), refetchInterval: 15_000 });
  if (query.isPending) return <SettingsRow label="Config" hint="Reading…" />;
  if (query.isError) return <SettingsRow label="Config" error={query.error.message} />;
  const { configPath, found, error, projects, stateDir, api } = query.data;
  if (error) return <SettingsRow label="Config" hint={configPath} error={error} />;
  const summary = found
    ? `${projects.length} project${projects.length === 1 ? "" : "s"}${projects.length ? `: ${projects.join(", ")}` : ""}`
    : "file not found, no project configured";
  return (
    <>
      <SettingsRow label="Config" hint={`${configPath}\n${summary}`} />
      <SettingsRow label="State" hint={stateDir ?? ""} />
      <SettingsRow label="API" hint={api ? `http://${api.bind}:${api.port}` : ""} />
    </>
  );
}

export function DevServersSettings() {
  const settings = useSettings(pluginSettings);
  const queryClient = useQueryClient();
  const configPath = useRef<SettingsInputHandle>(null);
  const apiPort = useRef<SettingsInputHandle>(null);
  const [portError, setPortError] = useState<string | null>(null);
  if (settings.status !== "ready") return null;

  const save = () => {
    const port = parsePort(apiPort.current?.getText() ?? "");
    if (port === undefined) return setPortError("A port number from 1 to 65535, or empty to use the config");
    setPortError(null);
    const values = { configPath: configPath.current?.getText().trim() || settings.values.configPath, apiPort: port };
    void settings.save(values, settings.revision).then((saved) => {
      if (saved) void queryClient.invalidateQueries({ queryKey: CONFIG_STATUS_KEY });
    });
  };

  return (
    <SettingsSection title="Dev servers">
      <SettingsCard>
        <SettingsInput
          ref={configPath}
          label="Config file"
          hint="JSON file whose devServers key lists the projects, ports and commands"
          initialValue={settings.values.configPath}
          onChangeText={() => {}}
        />
        <SettingsInput
          ref={apiPort}
          label="API port"
          hint="HTTP and MCP port on 127.0.0.1 by default; empty uses devServers.api.port"
          placeholder="from the config"
          error={portError}
          initialValue={settings.values.apiPort === null ? "" : String(settings.values.apiPort)}
          onChangeText={() => {}}
        />
        <SettingsAction label="Save" actionLabel={settings.saving ? "Saving…" : "Save"} error={settings.saveError} disabled={settings.saving} onPress={save} />
      </SettingsCard>
      <SettingsCard>
        <ConfigStatus />
      </SettingsCard>
    </SettingsSection>
  );
}
