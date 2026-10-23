import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { summarize } from "../shared/view-model.ts";
import { SCREEN_ID, useBoard } from "./board.ts";

export function DevServersFooter({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const query = useBoard(15_000);
  return (
    <SidebarRow
      icon="Server"
      label={summarize(query.data)}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}
