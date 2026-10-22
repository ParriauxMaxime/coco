import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { CommentCounts } from "../shared/contracts";

const STATUS_ORDER = ["open", "sent", "fixed", "declined", "outdated"];

export const describeComments = ({ total, ...byStatus }: CommentCounts) =>
  total === 0
    ? "no comments"
    : STATUS_ORDER.filter((status) => byStatus[status])
        .map((status) => `${byStatus[status]} ${status}`)
        .join(" · ");

export const cardStyles = ({ theme, layout }: Pick<PluginHostProps, "theme" | "layout">) => ({
  card: {
    padding: layout.compact ? 12 : 14,
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
  detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
  danger: { color: theme.colors.statusDanger, fontSize: 13 },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
  button: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.accent },
  buttonText: { color: theme.colors.accentForeground, fontSize: 13 },
  secondaryButton: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: theme.colors.surface2 },
  secondaryButtonText: { color: theme.colors.foreground, fontSize: 13 },
});
