import { openExternalUrl, useRpc, useWorkspace, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { describeRun, resolveRpc } from "../shared/contracts";
import { usePendingBrowserTab } from "./pending-browser";
import { cardStyles, describeComments } from "./style";

export function CocopilotPanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ directory, projectId, name }) => ({ directory, projectId, name }));
  const resolve = useRpc(resolveRpc);
  const query = useQuery({
    queryKey: ["resolve", workspace?.directory, workspace?.projectId, workspaceId],
    queryFn: () => resolve({ cwd: workspace!.directory, projectId: workspace!.projectId, workspaceId }),
    enabled: !!workspace,
    refetchInterval: 30_000,
  });
  const styles = useMemo(
    () => ({
      ...cardStyles({ theme, layout }),
      screen: { padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0, flexGrow: 1 },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20, fontWeight: "600" as const },
      runRow: { gap: 4, paddingTop: 6 },
    }),
    [theme, layout],
  );
  usePendingBrowserTab(workspaceId, navigation?.openBrowser);

  const open = (url: string) => {
    if (navigation?.openBrowser) navigation.openBrowser({ url, workspaceId });
    else void openExternalUrl(url);
  };
  const button = (label: string, url: string | null | undefined, primary = false) =>
    url ? (
      <Pressable key={label} accessibilityRole="button" onPress={() => open(url)} style={primary ? styles.button : styles.secondaryButton}>
        <Text style={primary ? styles.buttonText : styles.secondaryButtonText}>{label}</Text>
      </Pressable>
    ) : null;

  const data = query.data;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>🦜 cocopilot</Text>
      {query.isPending && <Text style={styles.detail}>Looking up this workspace…</Text>}
      {query.isError && (
        <View style={styles.card}>
          <Text style={styles.danger}>cocopilot is unreachable: {query.error.message}</Text>
          <Text style={styles.detail}>Start it with `npm start` in the cocopilot folder, or change its URL in the plugin settings.</Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={() => void query.refetch()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Retry</Text>
            </Pressable>
          </View>
        </View>
      )}
      {data && !data.work && (
        <View style={styles.card}>
          <Text style={styles.title}>No work for {workspace?.name}</Text>
          <Text style={styles.detail}>{data.branch ? `Branch ${data.branch} is in no cocopilot work.` : "This directory has no branch."}</Text>
          <View style={styles.actions}>{button("Open cocopilot", data.home)}</View>
        </View>
      )}
      {data?.work && (
        <View style={styles.card}>
          <Text style={styles.title}>{data.work.title}</Text>
          <Text style={styles.detail}>
            {data.pr ? `PR #${data.pr.number} · ${describeComments(data.pr.comments)}` : `Stack ${data.work.stack.map((n) => `#${n}`).join(", ")}`}
          </Text>
          <View style={styles.actions}>
            {button("Review", data.links?.review, true)}
            {button("PR", data.links?.pr)}
            {button("Plan", data.links?.plan, !data.pr)}
          </View>
        </View>
      )}
      {data?.runs.length ? (
        <View style={styles.card}>
          <Text style={styles.title}>Runs</Text>
          {data.runs.map((run) => (
            <View key={run.runId} style={styles.runRow}>
              <Text style={run.status === "running" ? styles.title : styles.detail}>
                {describeRun(run)} {run.runId} · {run.status} · {describeComments(run.comments)}
                {run.startedAt ? ` · ${new Date(run.startedAt).toLocaleString()}` : ""}
              </Text>
              <View style={styles.actions}>
                {run.agentId && navigation ? (
                  <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: run.agentId! })} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>Open agent</Text>
                  </Pressable>
                ) : null}
                {button("Open run", run.url)}
              </View>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
