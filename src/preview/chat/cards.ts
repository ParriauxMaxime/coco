import { useCallback, useState } from 'react';
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

const parsed = (m: Event): Card[] | null => {
  try {
    const list = JSON.parse((m as MessageEvent).data);
    return Array.isArray(list) ? list : [list];
  } catch {
    return null;
  }
};

// the chat stream's `cards` event carries the agent's changed cards; a (re)connect reloads the whole list
export function followCards(es: EventSource, agentId: string, merge: (list: Card[]) => void) {
  const load = () => api.cards(agentId).then(merge, () => {});
  es.addEventListener('open', load);
  es.addEventListener('cards', (m) => {
    const list = parsed(m);
    if (list) merge(list);
    else void load();
  });
}

// an Ask conversation's stream sends the cards of all its agents, past ones included, on connect and on every change
export function followAskCards(es: EventSource, merge: (list: Card[]) => void) {
  es.addEventListener('cards', (m) => {
    const list = parsed(m);
    if (list) merge(list);
  });
}
