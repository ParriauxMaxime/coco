import { openExternalUrl, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { TimelineRow } from "../shared/contracts.ts";
import { timelineText } from "../shared/view-model.ts";
import { ActionButton, button } from "./parts.tsx";
import { cardStyles, toneColor } from "./style.ts";

export function DevServerRow({ item, theme, layout }: PluginTimelineItemProps<TimelineRow>) {
  const styles = useMemo(() => cardStyles({ theme, layout }), [theme, layout]);
  const row = item.data;
  const { title, detail, tone } = timelineText(row);
  return (
    <View style={[styles.card, { borderLeftWidth: 3, borderLeftColor: toneColor(theme, tone) }]}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.detail} selectable>
        {detail}
      </Text>
      {row.event === "ready" && (
        <View style={styles.actions}>
          <ActionButton action={button("Open")} onPress={() => void openExternalUrl(row.url)} styles={styles} />
        </View>
      )}
    </View>
  );
}
