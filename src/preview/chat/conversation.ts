import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import type { ActivityEvent, AskRun, AskScope } from '../../types.ts';

export type Run = Partial<AskRun> & { id: string };
export type Pending = { nonce: string; text: string };

// conversation states (older one-shot runs read done or error): status dot, chip tone, label, short label
type AskState = { dot: string; tone: string; label: string; short: string };
export const ASK_STATE: Record<string, AskState> = {
  running: { dot: 'dp-ag-running', tone: 'dp-info', label: 'working', short: 'working' },
  idle: { dot: 'dp-ag-done', tone: 'dp-ok', label: 'agent live', short: 'agent live' },
  parked: { dot: 'dp-ag-archived', tone: '', label: 'agent archived after an idle hour', short: 'parked' },
  closed: { dot: 'dp-ag-archived', tone: '', label: 'closed', short: 'closed' },
  done: { dot: 'dp-ag-archived', tone: '', label: 'done', short: 'done' },
  error: { dot: 'dp-ag-failed', tone: 'dp-bad', label: 'error', short: 'error' },
};
export const askState = (s?: string | null): AskState => ASK_STATE[s || ''] || { dot: 'dp-ag-archived', tone: '', label: s || '', short: s || '' };

export const nonceOf = () => Math.random().toString(36).slice(2, 12);
const scopeKey = (s: AskScope) => (s.kind === 'global' ? 'global' : s.kind === 'repo' ? `repo:${s.repoId}` : `work:${s.slug}`);

// one conversation streamed over SSE; the stream stays open for the follow-ups, and a reconnect replays the whole log
export function useAskConversation(kind: string, scope: AskScope = { kind: 'global' }) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [history, setHistory] = useState<AskRun[]>([]);
  const source = useRef<EventSource | null>(null);
  const loadHistory = () => api.asks(scopeKey(scope)).then((list) => setHistory(list.filter((h) => (h.kind || 'ask') === kind)), () => {});
  useEffect(() => {
    loadHistory();
    return () => source.current?.close();
  }, []);
  const watch = (conv: Run) => {
    source.current?.close();
    setRun(conv);
    setEvents([]);
    const es = new EventSource(`/api/ask/${conv.id}/events`);
    source.current = es;
    es.onopen = () => setEvents([]);
    es.onmessage = (m) => {
      const ev: ActivityEvent = JSON.parse(m.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.nonce) setPending((p) => p.filter((x) => x.nonce !== ev.nonce));
      if (ev.type === 'end' || ev.type === 'closed') {
        setRun((r) => r && { ...r, status: ev.conversation || ev.status, proposal: ev.proposal || r.proposal, agentProposal: ev.agentProposal || r.agentProposal, dispatchProposal: ev.dispatchProposal || r.dispatchProposal, repoProposal: ev.repoProposal || r.repoProposal, agentId: ev.agentId || r.agentId });
        loadHistory();
      }
    };
  };
  // the first message starts the conversation through start(nonce), any later one goes to its agent
  const send = async (text: string, start?: (nonce: string) => Promise<{ id: string }>) => {
    const nonce = nonceOf();
    setPending((p) => [...p, { nonce, text }]);
    try {
      if (run) await api.askSay(run.id, { text, nonce });
      else {
        if (!start) throw new Error('no conversation to start');
        const { id } = await start(nonce);
        watch({ id, prompt: text, kind, status: 'running' });
        loadHistory();
      }
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x.nonce !== nonce));
      toast.error(errorMessage(e));
      return false;
    }
  };
  const open = (h: Run) => {
    setPending([]);
    watch(h);
  };
  const reset = () => {
    source.current?.close();
    setRun(null);
    setEvents([]);
    setPending([]);
  };
  const mark = events.findLast((e) => e.type === 'user' || e.type === 'end' || e.type === 'closed');
  const working = pending.length > 0 || mark?.type === 'user';
  const state = working ? 'running' : mark?.conversation || run?.status || null;
  return { run, events, pending, history, working, state, watch, send, open, reset, loadHistory };
}
export type AskConvo = ReturnType<typeof useAskConversation>;
