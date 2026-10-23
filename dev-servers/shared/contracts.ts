import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const DEFAULT_CONFIG_PATH = "~/cocopilot/coco.config.json";

export const pluginSettings = defineSettings({
  id: "dev-servers",
  scope: "host",
  version: 1,
  schema: z.object({
    configPath: z.string().trim().min(1).default(DEFAULT_CONFIG_PATH),
    apiPort: z.number().int().min(1).max(65535).nullable().default(null).describe("null: use devServers.api.port from the config"),
  }),
});

export const configStatusRpc = defineRpc({
  name: "devServers.configStatus",
  input: z.object({}),
  output: z.object({
    configPath: z.string(),
    found: z.boolean(),
    error: z.string().nullable(),
    projects: z.array(z.string()),
    stateDir: z.string().nullable(),
    api: z.object({ bind: z.string(), port: z.number() }).nullable(),
  }),
});
