// The desktop shell (desktop/), when coco runs inside it: a dock badge and native notifications
type Desktop = { setWaiting(count: number): void };

export const desktop = (window as unknown as { cocoDesktop?: Desktop }).cocoDesktop;

// a native notification for what happened while the window was not in front
export function notifyAway(title: string, body: string) {
  if (!desktop || document.hasFocus()) return;
  new Notification(title, { body, silent: false });
}
