import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { connectionSettings } from "../shared/contracts";

export function ConnectionSettings() {
  const settings = useSettings(connectionSettings);
  const input = useRef<SettingsInputHandle>(null);
  if (settings.status !== "ready") return null;
  const save = () => void settings.save({ ...settings.values, baseUrl: input.current?.getText().trim() ?? settings.values.baseUrl }, settings.revision);
  return (
    <SettingsSection title="Connection">
      <SettingsCard>
        <SettingsInput
          ref={input}
          label="cocopilot URL"
          hint="Where the cocopilot server listens, seen from the daemon machine"
          error={settings.saveError ? String(settings.saveError) : undefined}
          initialValue={settings.values.baseUrl}
          onChangeText={() => {}}
        />
        <SettingsAction label="Save" actionLabel={settings.saving ? "Saving…" : "Save"} disabled={settings.saving} onPress={save} />
      </SettingsCard>
    </SettingsSection>
  );
}
