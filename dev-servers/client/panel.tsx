import { openExternalUrl, useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { placementRpc, startRpc } from "../shared/contracts.ts";
import { baseName, lostFor, panelActions, placementText } from "../shared/view-model.ts";
import { QUERY_ROOT, useBoard, useServerAction } from "./board.ts";
import { ActionButton, button } from "./parts.tsx";
import { ServerCard } from "./server-card.tsx";
import { cardStyles } from "./style.ts";

type Started = { next: string; evicted?: { worktree: string; why: string }[] };

const openExternal = (url: string) => void openExternalUrl(url);

export function DevServerPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const styles = useMemo(() => cardStyles({ theme, layout }), [theme, layout]);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const placementOf = useRpc(placementRpc);
  const placement = useQuery({
    queryKey: [QUERY_ROOT, "placement", directory],
    queryFn: () => placementOf({ cwd: directory! }),
    enabled: Boolean(directory),
    refetchInterval: 15_000,
  });
  const boardQuery = useBoard(5_000);
  const start = useServerAction(useRpc(startRpc));
  const [started, setStarted] = useState<Started | null>(null);

  const board = boardQuery.data;
  const answer = placement.data;
  const place = answer?.ok ? answer.value.placement : null;
  const serverId = answer?.ok ? answer.value.serverId : null;
  const server = (serverId && board?.servers.find(({ id }) => id === serverId)) || null;
  const actions = panelActions(place, server, start.isPending);
  const open = (url: string) => (navigation?.openBrowser ? navigation.openBrowser({ url, workspaceId }) : openExternal(url));
  const run = (input: { serveFrom?: string; dedicated?: boolean }) => {
    setStarted(null);
    if (directory) start.mutate({ cwd: directory, ...input }, { onSuccess: setStarted });
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>Dev server</Text>
      {!directory && <Text style={styles.detail}>Reading the workspace…</Text>}
      {board?.error && (
        <View style={styles.card}>
          <Text style={styles.danger}>{board.error}</Text>
          <Text style={styles.detail}>Check the config file in Settings → Plugins → coco dev servers.</Text>
        </View>
      )}
      {placement.isPending && directory && <Text style={styles.detail}>Looking at this worktree…</Text>}
      {placement.isError && <Text style={styles.danger}>The plugin did not answer: {placement.error.message}</Text>}
      {answer && !answer.ok && (
        <View style={styles.card}>
          <Text style={answer.error.code === "not_a_project_worktree" ? styles.title : styles.danger}>
            {answer.error.code === "not_a_project_worktree" ? "No dev server for this workspace" : answer.error.message}
          </Text>
          {answer.error.code === "not_a_project_worktree" && <Text style={styles.detail}>{answer.error.message}</Text>}
        </View>
      )}
      {place && directory && (
        <View style={styles.card}>
          <Text style={styles.title}>{placementText(place, directory)}</Text>
          {place.because.map((reason) => (
            <Text key={reason} style={styles.detail}>
              • {reason}
            </Text>
          ))}
          {place.ambiguous && (
            <>
              <Text style={styles.warning}>{place.ambiguous.question}</Text>
              <View style={styles.actions}>
                {place.ambiguous.options.map((option) => (
                  <ActionButton
                    key={option.worktree}
                    action={button(`Serve from ${option.branch ?? baseName(option.worktree)}`, !start.isPending)}
                    onPress={() => run({ serveFrom: option.worktree })}
                    styles={styles}
                  />
                ))}
              </View>
            </>
          )}
          <View style={styles.actions}>
            <ActionButton action={actions.start} onPress={() => run({})} styles={styles} variant="primary" />
            <ActionButton action={actions.dedicated} onPress={() => run({ dedicated: true })} styles={styles} />
          </View>
          {actions.start.hint ? <Text style={styles.detail}>{actions.start.hint}</Text> : null}
          {start.error ? <Text style={styles.danger}>{start.error.message}</Text> : null}
          {started && (
            <>
              <Text style={styles.body}>{started.next}</Text>
              {started.evicted?.map(({ worktree, why }) => (
                <Text key={worktree} style={styles.warning}>
                  Stopped {baseName(worktree)} to make room: {why}
                </Text>
              ))}
            </>
          )}
          {!server && <Text style={styles.detail}>No server runs for it yet.</Text>}
        </View>
      )}
      {server && board && (
        <ServerCard
          server={server}
          lost={lostFor(board, server.id)}
          theme={theme}
          styles={styles}
          open={open}
          openExternal={openExternal}
          logsOpen={server.state !== "external"}
        />
      )}
    </ScrollView>
  );
}
