import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { pendingClass, useAction } from '../components/action.ts';
import { useVisible } from '../resource.ts';
import { useShown } from './waiting.ts';
import { reloadWorkAgents } from './agents.ts';
import { useWorkbench } from '../workbench/workbench-store.ts';
import Icon from './Icon.tsx';
import type { WorkAgent } from '../types.ts';

const ARCHIVE_S = 30;
// finished turns the owner kept, so the card does not come back on a remount; a new finished turn offers it again
const kept = new Set<string>();

// a done one-job agent's card: it archives the agent after 30 s counted only while the card is on screen; Cancel keeps it
export function ArchiveCountdown({ agentId, turn, onArchived }: { agentId: string; turn: string | null; onArchived?: () => void }) {
  const key = `${agentId}:${turn ?? ''}`;
  const [left, setLeft] = useState(ARCHIVE_S);
  const [stopped, setStopped] = useState(() => kept.has(key));
  const [ref, shown] = useShown();
  useEffect(() => {
    setLeft(ARCHIVE_S);
    setStopped(kept.has(key));
  }, [key]);
  const ticking = shown && !stopped && left > 0;
  useEffect(() => {
    if (!ticking) return undefined;
    const t = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [ticking, left]);
  useEffect(() => {
    if (left > 0 || stopped) return;
    setStopped(true);
    api.agentArchive(agentId).then(() => onArchived?.(), (e) => {
      toast.error(errorMessage(e));
      setLeft(ARCHIVE_S);
    });
  }, [left, stopped]);
  if (stopped && left > 0) return null;
  return (
    <div ref={ref} className="dp-thr-pend dp-ag-pend" role="status">
      <span className="dp-chip dp-info" title="Its job is done and nothing waits on you: it is archived once this has been on screen for 30 s">
        <Icon name="archive" size={12} />{left > 0 ? `Archiving in ${left} s` : 'Archiving…'}
      </span>
      {left > 0 && <button type="button" className="dp-btn dp-sm" onClick={() => { kept.add(key); setStopped(true); }}>Cancel</button>}
    </div>
  );
}

// messages sent to an agent, by agent id: one sent after its last known turn is a turn under way, even before the list says so
const sentAt = new Map<string, number>();
export const markSent = (agentId: string) => sentAt.set(agentId, Date.now());

const tabState = (slug: string, tabId: string) => {
  const s = useWorkbench.getState();
  if (s.slug !== slug) return 'elsewhere';
  return s.groups.some((g) => g.active === tabId) ? 'active' : s.groups.some((g) => g.tabs.includes(tabId)) ? 'behind' : 'closed';
};

// an idle agent whose last turn you saw in its tab is archived when you leave that tab: another tab of its pane comes to the front,
// or you close it. A layout change (maximize, a drag to another pane, a reload of the work) or leaving the work or the window does
// not count. Never while it waits on you (a card, a permission), holds a commit to approve, has subagents at work or was just sent
// a message; the toast undoes it
export function useArchiveOnLeave(slug: string, tabId: string, agentId: string | null | undefined, a: WorkAgent | undefined, blocked: boolean) {
  const shown = useVisible();
  const seen = useRef<string | null>(null);
  const idle = a?.status === 'done';
  useEffect(() => { if (shown && idle && a) seen.current = a.updatedAt; }, [shown, idle, a?.updatedAt]);
  const latest = useRef(() => {});
  latest.current = () => {
    if (!agentId || !a || a.status !== 'done' || blocked || a.openCards > 0 || (a.subagents?.running ?? 0) > 0) return;
    if (!seen.current || seen.current !== a.updatedAt || (sentAt.get(agentId) ?? 0) > Date.parse(a.updatedAt ?? '')) return;
    seen.current = null;
    api.agentArchive(agentId).then(() => {
      void reloadWorkAgents(slug);
      toast.success(`Archived ${a.title}: you read its last reply`, { undo: () => api.agentUnarchive(agentId).then(() => reloadWorkAgents(slug)) });
    }, () => {});
  };
  useEffect(() => {
    let was = tabState(slug, tabId);
    return useWorkbench.subscribe(() => {
      const now = tabState(slug, tabId);
      if (was === 'active' && (now === 'behind' || now === 'closed')) latest.current();
      was = now;
    });
  }, [slug, tabId]);
  // closed by its pane's close button: the tab is gone from the store by the time it unmounts
  useEffect(() => () => { if (tabState(slug, tabId) === 'closed') latest.current(); }, [slug, tabId]);
}

// an archived agent back as it was (Paseo's Unarchive)
export function RestoreButton({ agentId, onRestored }: { agentId: string; onRestored?: () => void }) {
  const { pending, busy, run } = useAction();
  return (
    <button type="button" className={`dp-btn dp-sm${pendingClass(pending === 'restore')}`} disabled={busy} title="Unarchive this agent: it takes messages again" onClick={() => run('restore', async () => {
      await api.agentUnarchive(agentId);
      onRestored?.();
    })}><Icon name="refresh" size={14} /><span className="dp-ag-lbl">Restore</span></button>
  );
}
