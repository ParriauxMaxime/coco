// Settings provider for acme/widgets: turns off every worker the user's settings list, except the opted-in ones.
export function settingsOverlay({ base, services, port, dedicatedDb }) {
  const workers = Object.keys(base.workers ?? {}).filter((name) => !services.includes(name));
  return { workers: Object.fromEntries(workers.map((name) => [name, null])), servedOn: port, freshDb: dedicatedDb };
}
