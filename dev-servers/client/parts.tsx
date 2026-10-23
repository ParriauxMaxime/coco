import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { logsRpc } from "../shared/contracts.ts";
import type { ServerState } from "../shared/states.ts";
import { stateLabel, stateTone, type Action, type LoginSteps } from "../shared/view-model.ts";
import { QUERY_ROOT, unwrap } from "./board.ts";
import { toneColor, type CardStyles } from "./style.ts";

type Variant = "primary" | "secondary" | "danger";

export function ActionButton({
  action,
  onPress,
  styles,
  variant = "secondary",
}: {
  action: Action;
  onPress: () => void;
  styles: CardStyles;
  variant?: Variant;
}) {
  if (!action.visible) return null;
  const [box, text] = {
    primary: [styles.button, styles.buttonText] as const,
    secondary: [styles.secondaryButton, styles.secondaryButtonText] as const,
    danger: [styles.dangerButton, styles.dangerButtonText] as const,
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={action.hint ? `${action.label}: ${action.hint}` : action.label}
      accessibilityState={{ disabled: !action.enabled }}
      disabled={!action.enabled}
      onPress={onPress}
      style={[box, !action.enabled && styles.disabled]}
    >
      <Text style={text}>{action.label}</Text>
    </Pressable>
  );
}

export const button = (label: string, enabled = true): Action => ({ visible: true, enabled, label });

export function StateBadge({ state, theme, styles }: { state: ServerState; theme: PluginTheme; styles: CardStyles }) {
  const color = toneColor(theme, stateTone(state));
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{stateLabel(state)}</Text>
    </View>
  );
}

export function Confirm({
  text,
  label,
  onConfirm,
  onCancel,
  styles,
}: {
  text: string;
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
  styles: CardStyles;
}) {
  return (
    <View style={styles.confirm}>
      <Text style={styles.body}>{text}</Text>
      <View style={styles.actions}>
        <ActionButton action={button(label)} onPress={onConfirm} styles={styles} variant="danger" />
        <ActionButton action={button("Cancel")} onPress={onCancel} styles={styles} />
      </View>
    </View>
  );
}

export function LogTail({ id, styles }: { id: string; styles: CardStyles }) {
  const logs = useRpc(logsRpc);
  const query = useQuery({ queryKey: [QUERY_ROOT, "logs", id], queryFn: async () => unwrap(await logs({ id, lines: 60 })), refetchInterval: 3_000 });
  if (query.isPending) return <Text style={styles.detail}>Reading the log…</Text>;
  if (query.isError) return <Text style={styles.danger}>{query.error.message}</Text>;
  const { lines, file, truncated } = query.data;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.detail}>
        Last {lines.length} lines of {file}
        {truncated ? " (older lines cut)" : ""}
      </Text>
      <ScrollView style={styles.log} nestedScrollEnabled>
        <Text selectable style={styles.logText}>
          {lines.length ? lines.join("\n") : "(empty)"}
        </Text>
      </ScrollView>
    </View>
  );
}

export function LoginCard({ steps, open, onClose, styles }: { steps: LoginSteps; open: (url: string) => void; onClose: () => void; styles: CardStyles }) {
  const toast = useToast();
  const copy = (text: string) =>
    copyText(text).then(
      () => toast.show("Copied", { variant: "success" }),
      (error: unknown) => toast.error(`Copy failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  return (
    <View style={styles.confirm}>
      {steps.kind === "direct" ? (
        <>
          <Text style={styles.body}>This link opens the server logged in.</Text>
          <View style={styles.actions}>
            <ActionButton action={button("Open logged in")} onPress={() => open(steps.url)} styles={styles} variant="primary" />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.body}>1. Open the server in your browser.</Text>
          <View style={styles.actions}>
            <ActionButton action={button(`Open ${steps.open}`)} onPress={() => open(steps.open)} styles={styles} variant="primary" />
          </View>
          <Text style={styles.body}>2. Paste this in that tab's developer console. It stores the session, then opens {steps.then}.</Text>
          <Text selectable style={[styles.log, styles.logText]}>
            {steps.snippet}
          </Text>
          <View style={styles.actions}>
            <ActionButton action={button("Copy")} onPress={() => void copy(steps.snippet)} styles={styles} />
          </View>
        </>
      )}
      <Text style={styles.detail}>{steps.next}</Text>
      <View style={styles.actions}>
        <ActionButton action={button("Done")} onPress={onClose} styles={styles} />
      </View>
    </View>
  );
}
