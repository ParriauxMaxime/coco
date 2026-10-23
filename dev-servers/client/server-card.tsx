import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { loginRpc, pinRpc, stopRpc, type BoardLost, type BoardServer } from "../shared/contracts.ts";
import {
  holdersText,
  idleText,
  loginSteps,
  lostText,
  optInsText,
  pinnedText,
  serverActions,
  statusText,
  worktreeName,
  type LoginSteps,
  type StopAction,
} from "../shared/view-model.ts";
import { isRpcFailure, useServerAction } from "./board.ts";
import { ActionButton, Confirm, LoginCard, LogTail, StateBadge } from "./parts.tsx";
import type { CardStyles } from "./style.ts";

type Props = {
  server: BoardServer;
  lost: BoardLost[];
  theme: PluginTheme;
  styles: CardStyles;
  open: (url: string) => void;
  openExternal: (url: string) => void;
  logsOpen?: boolean;
  children?: ReactNode;
};

export function ServerCard({ server, lost, theme, styles, open, openExternal, logsOpen = false, children }: Props) {
  const [confirming, setConfirming] = useState<StopAction | null>(null);
  const [showLogs, setShowLogs] = useState(logsOpen);
  const [login, setLogin] = useState<LoginSteps | null>(null);
  const [loginGone, setLoginGone] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const stop = useServerAction(useRpc(stopRpc));
  const pin = useServerAction(useRpc(pinRpc));
  const signIn = useServerAction(useRpc(loginRpc));
  const actions = serverActions(server);
  const loginAction = loginGone
    ? { ...actions.login, visible: false }
    : signIn.isPending
      ? { ...actions.login, enabled: false, label: "Logging in…" }
      : actions.login;
  const error = [stop.error, pin.error, signIn.error].find((failure) => failure && !isRpcFailure(failure, "login_unavailable"));

  const runStop = (action: StopAction) => {
    setConfirming(null);
    stop.mutate({ id: server.id, force: action.force }, { onSuccess: (result) => setNote(result.note ? `${result.next} (${result.note})` : result.next) });
  };
  const runLogin = () =>
    signIn.mutate(
      { id: server.id },
      {
        onSuccess: (result) => setLogin(loginSteps(result)),
        onError: (failure) => isRpcFailure(failure, "login_unavailable") && setLoginGone(true),
      },
    );
  const status = statusText(server);
  const lines = [holdersText(server), pinnedText(server), optInsText(server), idleText(server)].filter((line): line is string => Boolean(line));

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text style={styles.title}>{worktreeName(server)}</Text>
        <StateBadge state={server.state} theme={theme} styles={styles} />
        <Text style={styles.detail}>:{server.port}</Text>
      </View>
      <Text style={styles.detail} selectable>
        {server.worktree.branch ? `${server.worktree.branch}${server.worktree.dirty ? " (uncommitted changes)" : ""} · ` : ""}
        {server.worktree.path}
      </Text>
      <Text style={styles.body} selectable>
        {server.url}
      </Text>
      {status ? <Text style={server.state === "crashed" ? styles.danger : styles.detail}>{status}</Text> : null}
      {lines.map((line) => (
        <Text key={line} style={styles.detail}>
          {line}
        </Text>
      ))}
      {lost.map((notice) => (
        <Text key={notice.id} style={styles.warning}>
          {lostText(notice)}
        </Text>
      ))}
      <View style={styles.actions}>
        <ActionButton action={actions.open} onPress={() => open(server.url)} styles={styles} variant="primary" />
        <ActionButton action={loginAction} onPress={runLogin} styles={styles} />
        <ActionButton action={{ ...actions.logs, label: showLogs ? "Hide logs" : "Logs" }} onPress={() => setShowLogs(!showLogs)} styles={styles} />
        <ActionButton
          action={pin.isPending ? { ...actions.pin, enabled: false } : actions.pin}
          onPress={() => pin.mutate({ id: server.id, pinned: !server.pinned }, { onSuccess: (result) => setNote(result.next) })}
          styles={styles}
        />
        {actions.stop && (
          <ActionButton
            action={stop.isPending ? { ...actions.stop, enabled: false, label: "Stopping…" } : actions.stop}
            onPress={() => setConfirming(actions.stop)}
            styles={styles}
            variant={actions.stop.force ? "danger" : "secondary"}
          />
        )}
      </View>
      {!actions.open.enabled && actions.open.hint ? <Text style={styles.detail}>{actions.open.hint}</Text> : null}
      {confirming && (
        <Confirm
          text={confirming.confirm}
          label={confirming.label}
          onConfirm={() => runStop(confirming)}
          onCancel={() => setConfirming(null)}
          styles={styles}
        />
      )}
      {error ? <Text style={styles.danger}>{error.message}</Text> : null}
      {note ? <Text style={styles.detail}>{note}</Text> : null}
      {login && <LoginCard steps={login} open={openExternal} onClose={() => setLogin(null)} styles={styles} />}
      {showLogs && actions.logs.visible && <LogTail id={server.id} styles={styles} />}
      {children}
    </View>
  );
}
