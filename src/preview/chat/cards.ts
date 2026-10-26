import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.ts';
import type { Card } from '../../types.ts';

const byTime = (a: Card, b: Card) => a.createdAt.localeCompare(b.createdAt);

export function mergeCards(prev: Card[], next: Card[]) {
  const map = new Map(prev.map((c) => [c.id, c]));
  for (const c of next) map.set(c.id, c);
  return [...map.values()].sort(byTime);
}

export function useCardList() {
  const [cards, setCards] = useState<Card[]>([]);
  const merge = useCallback((list: Card | Card[]) => setCards((p) => mergeCards(p, Array.isArray(list) ? list : [list])), []);
  return { cards, merge, setCards };
}

// the chat stream's `cards` event carries the agent's changed cards; a (re)connect reloads the whole list
export function followCards(es: EventSource, agentId: string, merge: (list: Card[]) => void) {
  const load = () => api.cards(agentId).then(merge, () => {});
  es.addEventListener('open', load);
  es.addEventListener('cards', (m) => {
    try {
      const list = JSON.parse((m as MessageEvent).data);
      merge(Array.isArray(list) ? list : [list]);
    } catch {
      void load();
    }
  });
}

// cards of an agent whose timeline streams elsewhere (Ask conversations): kept across the agents of one conversation
export function useAgentCards(agentId: string | null | undefined, scope: string | null | undefined) {
  const { cards, merge, setCards } = useCardList();
  useEffect(() => setCards([]), [scope]);
  useEffect(() => {
    if (!agentId) return;
    const es = new EventSource(`/api/agent-chat/${encodeURIComponent(agentId)}/events`);
    followCards(es, agentId, merge);
    return () => es.close();
  }, [agentId]);
  return { cards, merge };
}
