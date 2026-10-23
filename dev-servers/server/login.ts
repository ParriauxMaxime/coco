import { z } from "zod";
import { loginSeedSchema, loginUserSchema, type LoginResult, type LoginSeed } from "../shared/contracts.ts";
import { ServiceError } from "./errors.ts";
import { loadProvider, type LoginContext } from "./settings-overlay.ts";

const providerLoginSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  seed: loginSeedSchema.optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  user: z
    .union([
      z
        .string()
        .min(1)
        .transform((id) => ({ id })),
      loginUserSchema,
    ])
    .optional(),
});

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const failed = (provider: string, message: string) => new ServiceError("login_failed", `login of ${provider} failed: ${message}`, { provider });

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} gave no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

export async function callLogin(provider: string, ctx: LoginContext, timeoutMs: number) {
  let login: unknown;
  try {
    login = (await loadProvider(provider)).login;
  } catch (error) {
    throw failed(provider, `the module did not load: ${messageOf(error)}`);
  }
  if (typeof login !== "function") throw new ServiceError("login_unavailable", `${provider} has no login(ctx) export`, { provider });
  let raw: unknown;
  try {
    raw = await withTimeout(Promise.resolve(login(ctx)), timeoutMs, "login(ctx)");
  } catch (error) {
    throw failed(provider, messageOf(error));
  }
  const parsed = providerLoginSchema.safeParse(raw);
  if (!parsed.success) throw failed(provider, `login(ctx) returned an unexpected shape: ${z.prettifyError(parsed.error)}`);
  const { seed, url } = parsed.data;
  if (seed && new URL(seed.origin).origin !== new URL(url).origin)
    throw failed(provider, `the seed is for ${seed.origin} but the page is on ${new URL(url).origin}, where the browser would not see it`);
  return parsed.data;
}

const setItems = ({ entries }: LoginSeed) =>
  Object.entries(entries)
    .map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
    .join(" ");

// Storage is per origin, so the script must run on a page of that origin before the target page loads.
export function loginReply(id: string, { url, seed, expiresAt, user }: Awaited<ReturnType<typeof callLogin>>): LoginResult {
  const who = user ? ` as ${user.id}` : "";
  const until = expiresAt ? ` until ${expiresAt}` : "";
  if (!seed) return { id, url, ...(user && { user }), ...(expiresAt && { expiresAt }), next: `open ${url} to be logged in${who}${until}` };
  const origin = new URL(seed.origin).origin;
  const script = setItems(seed);
  const apply = { open: `${origin}/`, function: `() => { ${script} return location.origin; }`, script, then: url };
  return {
    id,
    url,
    ...(user && { user }),
    ...(expiresAt && { expiresAt }),
    seed,
    apply,
    next:
      `logged in${who}${until} once the browser holds the seed: open ${apply.open}, run apply.function there with your browser's evaluate tool ` +
      `(it returns ${origin}), then navigate to ${url}. A browser tool with an init script can instead open ${url} with apply.script as that script.`,
  };
}
