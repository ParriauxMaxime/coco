import { useEffect } from "react";

// Buttons cannot reach navigation.openBrowser; they queue the URL and open the panel, which can.
type Request = { workspaceId: string; url: string };

let pending: Request | null = null;
const listeners = new Set<() => void>();

export function requestBrowserTab(request: Request) {
  pending = request;
  for (const listener of listeners) listener();
}

export function usePendingBrowserTab(workspaceId: string, open: ((input: Request) => void) | undefined) {
  useEffect(() => {
    if (!open) return;
    const drain = () => {
      if (pending?.workspaceId !== workspaceId) return;
      const request = pending;
      pending = null;
      open(request);
    };
    listeners.add(drain);
    drain();
    return () => {
      listeners.delete(drain);
    };
  }, [workspaceId, open]);
}
