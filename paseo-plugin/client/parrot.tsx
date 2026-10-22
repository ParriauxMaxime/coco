import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Text } from "react-native";

export function ParrotIcon({ size }: PluginButtonIconProps) {
  return (
    <Text accessible={false} style={{ fontSize: size * 0.85, lineHeight: size, width: size, textAlign: "center" }}>
      🦜
    </Text>
  );
}
