import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export type TemplateVars = { port?: number; logDir?: string; worktree?: string; services?: string[] };

const TEMPLATE_NAMES = ["port", "logDir", "worktree", "services"];
const PLACEHOLDER = /\{(port\+\d+|[A-Za-z]\w*)\}/g;
const WHOLE_PLACEHOLDER = /^\{(port\+\d+|[A-Za-z]\w*)\}$/;
const PORT_OFFSET = /^port\+(\d+)$/;

const isKnownName = (name: string) => PORT_OFFSET.test(name) || TEMPLATE_NAMES.includes(name);

const unknownPlaceholders = (value: unknown): string[] => {
  if (typeof value === "string") return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => !isKnownName(name));
  if (Array.isArray(value)) return value.flatMap(unknownPlaceholders);
  if (value && typeof value === "object") return Object.values(value).flatMap(unknownPlaceholders);
  return [];
};

const lookup = (name: string, vars: TemplateVars): number | string | string[] => {
  const offset = PORT_OFFSET.exec(name);
  const key = offset ? "port" : name;
  const value = vars[key as keyof TemplateVars];
  if (value === undefined) throw new Error(`no value for {${name}}`);
  return offset ? (value as number) + Number(offset[1]) : value;
};

export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = lookup(name, vars);
    return Array.isArray(value) ? value.join(",") : String(value);
  });
}

// A string that is exactly one placeholder takes the variable's own type, so "{port}" gives a number and "{services}" an array.
export function renderValue(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    return whole ? lookup(whole[1], vars) : renderTemplate(value, vars);
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, vars)]));
  return value;
}

export const expandHome = (value: string, home = os.homedir()) => (value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value);

const placeholderMessage = (names: string[]) =>
  `unknown placeholder ${names.map((name) => `{${name}}`).join(", ")}; use {port}, {port+N}, {logDir}, {worktree} or {services}`;

const withKnownPlaceholders = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const unknown = unknownPlaceholders(value);
    if (unknown.length) ctx.addIssue({ code: "custom", message: placeholderMessage(unknown) });
  });

const templated = withKnownPlaceholders(z.string());
const templatedArgv = z.array(templated);
const templatedEnv = z.record(z.string(), templated);

const regex = z.string().refine((source) => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}, "not a valid regular expression");

const port = z.number().int().min(1).max(65535);

const portsSchema = z
  .strictObject({
    range: z.tuple([port, port]).default([8100, 8990]),
    step: z.number().int().min(1).default(10),
    reserve: z.array(z.string().regex(/^\{port(\+\d+)?\}$/, 'use "{port}" or "{port+N}"')).default(["{port}"]),
    exclude: z.array(port).default([]),
  })
  .refine(({ range }) => range[0] <= range[1], { message: "range starts above its end", path: ["range"] })
  .refine(({ reserve }) => reserve.includes("{port}"), { message: 'reserve must include "{port}"', path: ["reserve"] });

const httpProbe = z.strictObject({ path: z.string().startsWith("/").default("/"), bodyIncludes: z.string().optional() });

const projectSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][\w.-]*$/, "letters, digits, '.', '_' and '-' only"),
  match: z
    .strictObject({ remote: z.string().min(1).optional(), paths: z.array(z.string().min(1)).optional() })
    .refine(({ remote, paths }) => remote || paths?.length, "set match.remote or match.paths"),
  mainCheckout: z.string().default(""),
  appDir: z.string().default("."),
  command: templatedArgv.min(1),
  env: templatedEnv.default({}),
  ports: portsSchema.prefault({}),
  settings: z
    .strictObject({
      file: z.string().min(1),
      overlay: withKnownPlaceholders(z.record(z.string(), z.unknown())).default({}),
    })
    .optional(),
  warm: z
    .strictObject({
      symlink: z.array(z.string()).default([]),
      clone: z.array(z.string()).default([]),
      copyIfMissing: z.array(z.string()).default([]),
      prebuild: z.boolean().default(false),
    })
    .prefault({}),
  readiness: z
    .strictObject({ http: httpProbe.prefault({}), command: templatedArgv.min(1).optional(), timeoutMinutes: z.number().positive().default(15) })
    .prefault({}),
  logPatterns: z.strictObject({ progress: regex.optional(), ready: regex.optional(), crash: regex.optional(), rebuild: regex.optional() }).prefault({}),
  stop: z.strictObject({ graceSeconds: z.number().min(0).default(10), sweepCwdUnder: z.array(z.string()).default([]) }).prefault({}),
  adopt: z.strictObject({ cwdPattern: regex.optional(), probe: httpProbe.prefault({}) }).optional(),
  optIns: z
    .strictObject({
      dedicatedDb: z.strictObject({ args: templatedArgv.default([]), env: templatedEnv.default({}) }).optional(),
      services: z.strictObject({ path: z.string().min(1) }).optional(),
    })
    .prefault({}),
  urlTemplate: templated.default("http://localhost:{port}"),
  provider: z.string().min(1).optional(),
});

const devServersSchema = z
  .strictObject({
    api: z.strictObject({ port: port.default(8779), bind: z.string().min(1).default("127.0.0.1") }).prefault({}),
    stateDir: z.string().min(1).default("~/.cocopilot/dev-servers"),
    cap: z.number().int().min(1).default(3),
    idleStopMinutes: z.number().positive().default(30),
    leaseTtlMinutes: z.number().positive().default(240),
    worktreeRoots: z.array(z.string()).default(["~/.paseo/worktrees"]),
    injectMcp: z.enum(["all", "matching-projects", "off"]).default("matching-projects"),
    coco: z.strictObject({ url: z.url().nullable().default("http://127.0.0.1:8777"), timeoutMs: z.number().int().positive().default(1500) }).prefault({}),
    projects: z.array(projectSchema).default([]),
  })
  .superRefine(({ projects }, ctx) => {
    const seen = new Set<string>();
    projects.forEach(({ id }, index) => {
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate project id "${id}"`, path: ["projects", index, "id"] });
      seen.add(id);
    });
  });

export type DevServersConfig = z.output<typeof devServersSchema>;
export type ProjectConfig = DevServersConfig["projects"][number];
export type PortsConfig = ProjectConfig["ports"];

export function parseConfig(raw: unknown, { home = os.homedir() } = {}): DevServersConfig {
  const config = devServersSchema.parse(raw ?? {});
  const expand = (value: string) => expandHome(value, home);
  return {
    ...config,
    stateDir: expand(config.stateDir),
    worktreeRoots: config.worktreeRoots.map(expand),
    projects: config.projects.map((project) => ({
      ...project,
      match: { ...project.match, ...(project.match.paths && { paths: project.match.paths.map(expand) }) },
      mainCheckout: project.mainCheckout && expand(project.mainCheckout),
      ...(project.provider && { provider: expand(project.provider) }),
    })),
  };
}

export type ConfigLoad = { file: string; found: boolean } & ({ config: DevServersConfig; error: null } | { config: null; error: string });

const describeError = (error: unknown) => (error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error));

export async function loadConfig(configPath: string, { home = os.homedir() } = {}): Promise<ConfigLoad> {
  const file = expandHome(configPath, home);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { file, found: false, config: null, error: describeError(error) };
    return { file, found: false, config: parseConfig({}, { home }), error: null };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return { file, found: true, config: null, error: `${file}: ${describeError(error)}` };
  }
  try {
    const raw = root && typeof root === "object" ? (root as { devServers?: unknown }).devServers : undefined;
    return { file, found: true, config: parseConfig(raw, { home }), error: null };
  } catch (error) {
    return { file, found: true, config: null, error: `devServers in ${file}:\n${describeError(error)}` };
  }
}

export const resolveApi = (api: DevServersConfig["api"], settingsPort: number | null) => ({ bind: api.bind, port: settingsPort ?? api.port });
