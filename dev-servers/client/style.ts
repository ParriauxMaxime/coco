import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import type { Tone } from "../shared/states.ts";

const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" });

export const toneColor = (theme: PluginTheme, tone: Tone) =>
  ({
    success: theme.colors.statusSuccess,
    warning: theme.colors.statusWarning,
    danger: theme.colors.statusDanger,
    muted: theme.colors.foregroundMuted,
    accent: theme.colors.accent,
  })[tone];

export const cardStyles = ({ theme, layout }: Pick<PluginHostProps, "theme" | "layout">) => ({
  screen: { padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0, flexGrow: 1 },
  heading: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "600" as const },
  card: {
    padding: layout.compact ? 12 : 14,
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  row: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 8 },
  title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const, flexShrink: 1 },
  detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
  body: { color: theme.colors.foreground, fontSize: 13 },
  danger: { color: theme.colors.statusDanger, fontSize: 13 },
  warning: { color: theme.colors.statusWarning, fontSize: 13 },
  badge: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1 },
  badgeText: { fontSize: 12, fontWeight: "600" as const },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
  button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.accent },
  buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
  secondaryButton: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.surface2 },
  secondaryButtonText: { color: theme.colors.foreground, fontSize: 13 },
  dangerButton: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.statusDanger },
  dangerButtonText: { color: theme.colors.accentForeground, fontSize: 13 },
  disabled: { opacity: 0.5 },
  confirm: { gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.statusWarning, backgroundColor: theme.colors.surface2 },
  log: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxHeight: layout.compact ? 220 : 320,
  },
  logText: { color: theme.colors.foreground, fontSize: 11, fontFamily: MONOSPACE },
});

export type CardStyles = ReturnType<typeof cardStyles>;
