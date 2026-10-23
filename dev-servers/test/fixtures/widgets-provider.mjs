// Settings provider for acme/widgets: turns off every worker the user's settings list, except the opted-in ones.
export function settingsOverlay({ base, services, port, dedicatedDb }) {
  const workers = Object.keys(base.workers ?? {}).filter((name) => !services.includes(name));
  return { workers: Object.fromEntries(workers.map((name) => [name, null])), servedOn: port, freshDb: dedicatedDb };
}

// Login for acme/widgets: a fake session token the widgets app reads from localStorage. "nobody" is not in its database.
export async function login({ url, port, path, user = "usr_ada" }) {
  if (user === "nobody") throw new Error("no user nobody in the widgets database");
  if (user === "elsewhere") return { url: `http://127.0.0.2:${port}${path}`, seed: { storage: "localStorage", origin: url, entries: {} } };
  const origin = new URL(url).origin;
  return {
    url: `${origin}${path}`,
    seed: { storage: "localStorage", origin, entries: { "widgets.session": `tok_${user}_${port}`, "widgets.user": user } },
    expiresAt: "2030-01-01T00:00:00.000Z",
    user: { id: user, name: user === "usr_ada" ? "Ada" : user },
  };
}
