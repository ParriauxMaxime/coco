import { openExternalUrl, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { describeRun, type ReviewRun } from "../shared/contracts";
import { cardStyles, describeComments } from "./style";

export function ReviewRunRow({ item, theme, layout }: PluginTimelineItemProps<ReviewRun>) {
  const styles = useMemo(() => cardStyles({ theme, layout }), [theme, layout]);
  const run = item.data;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>
        🦜 cocopilot {describeRun({ kind: run.kind, pr: run.number })} · {run.status}
      </Text>
      <Text style={styles.detail}>
        {run.title} · run {run.runId} · {describeComments(run.comments)}
      </Text>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={() => void openExternalUrl(run.url)} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Open in cocopilot</Text>
        </Pressable>
      </View>
    </View>
  );
}
