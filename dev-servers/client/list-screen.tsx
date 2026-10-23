import { openExternalUrl, type PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { lostFor, lostText, orphanLost, summarize } from "../shared/view-model.ts";
import { useBoard } from "./board.ts";
import { ActionButton, button } from "./parts.tsx";
import { ServerCard } from "./server-card.tsx";
import { cardStyles } from "./style.ts";

const open = (url: string) => void openExternalUrl(url);

export function ServersScreen({ theme, layout }: PluginScreenProps) {
  const styles = useMemo(() => cardStyles({ theme, layout }), [theme, layout]);
  const query = useBoard(5_000);
  const board = query.data;
  const orphans = board ? orphanLost(board) : [];

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>{summarize(board)}</Text>
      {query.isPending && <Text style={styles.detail}>Reading the servers…</Text>}
      {query.isError && (
        <View style={styles.card}>
          <Text style={styles.danger}>The plugin did not answer: {query.error.message}</Text>
          <View style={styles.actions}>
            <ActionButton action={button("Retry")} onPress={() => void query.refetch()} styles={styles} />
          </View>
        </View>
      )}
      {board?.error && (
        <View style={styles.card}>
          <Text style={styles.danger}>{board.error}</Text>
          <Text style={styles.detail}>Check the config file in Settings → Plugins → coco dev servers.</Text>
        </View>
      )}
      {board && !board.error && !board.servers.length && (
        <View style={styles.card}>
          <Text style={styles.title}>No dev server yet</Text>
          <Text style={styles.detail}>Agents start one with dev_server_start, or start one from a workspace's Dev server panel.</Text>
        </View>
      )}
      {board?.servers.map((server) => (
        <ServerCard key={server.id} server={server} lost={lostFor(board, server.id)} theme={theme} styles={styles} open={open} openExternal={open} />
      ))}
      {orphans.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.title}>Servers gone since</Text>
          {orphans.map((notice) => (
            <Text key={notice.id} style={styles.warning}>
              {notice.worktree}: {lostText(notice)}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
