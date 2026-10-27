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

const listOf = (d: Card | Card[]) => (Array.isArray(d) ? d : [d]);

// the chat topic's `cards` event carries the agent's changed cards; a (re)subscribe reloads the whole list
export const cardEvents = (agentId: string, merge: (list: Card[]) => void) => ({
  open: () => void api.cards(agentId).then(merge, () => {}),
  cards: (d: Card | Card[]) => merge(listOf(d)),
});

// an Ask conversation's topic sends the cards of all its agents, past ones included, on subscribe and on every change
export const askCardEvents = (merge: (list: Card[]) => void) => ({ cards: (d: Card | Card[]) => merge(listOf(d)) });
