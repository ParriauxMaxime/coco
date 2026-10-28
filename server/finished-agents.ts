// Agents coco started or links (a dispatch, a New agent, a setup, a ritual, a hand-off's successor, an agent linked to a PR row) whose turn ended
// with the agent's last word, for the waiting queue. Read from Paseo's live agent list; the last word from the tail of the agent's timeline,
// fetched again only once the agent was updated. Ask agents and cc-group agents wait through their own kinds.
import { isCocoAgent } from './permissions.ts';
import { TITLE_PREFIX } from './paseo-agent.ts';
import type { AgentSnapshot } from './permissions.ts';
import type { DaemonClient } from './paseo-agent.ts';
import type { RowKey } from './core-types.ts';

const KINDS = ['agent', 'dispatch', 'setup'];
const TAIL = 30;
const MAX_FETCHED = 40;
const TITLE_MAX = 80;

export type LastWord = { agentId: string; title: string; work: string | null; pr: string | null; text: string; at: string };
type Word = { text: string; at: string } | null;
type Options = {
  client: () => Promise<Pick<DaemonClient, 'agents'>>;
  agents: () => AgentSnapshot[];
  linked: () => { agentId: string; slug: string; key: RowKey }[];
  successors: () => string[];
  // an agent not updated within this long is not looked at
  maxAgeMs: number;
  now?: () => number;
};

export function createFinishedAgents({ client, agents, linked, successors, maxAgeMs, now = Date.now }: Options) {
  const memo = new Map<string, { updatedAt: string; word: Promise<Word> }>();
  const states = new Map<string, string>();

  // an agent whose finished turn waits on the owner, whatever its status now
  const tracked = (a: AgentSnapshot, links: Map<string, unknown>, handed: Set<string>) =>
    !a.labels?.ask && a.labels?.kind !== 'cc-group' && (links.has(a.id) || handed.has(a.id) || (isCocoAgent(a) && (KINDS.includes(a.labels?.kind ?? '') || Boolean(a.labels?.ritual))));
  const done = (a: AgentSnapshot) => !a.archivedAt && a.status === 'idle' && !a.pendingPermissions?.length;

  async function wordOf(agentId: string): Promise<Word> {
    const page = await (await client()).agents.ref(agentId).timeline.refetch?.({ direction: 'tail', limit: TAIL, projection: 'projected' });
    const last = page?.entries.findLast((e) => e.item?.type === 'user_message' || e.item?.type === 'assistant_message');
    const text = last?.item?.type === 'assistant_message' ? last.item.text?.trim() : '';
    return text && last?.timestamp ? { text, at: last.timestamp } : null;
  }
  function cached(a: AgentSnapshot) {
    const updatedAt = a.updatedAt ?? '';
    const hit = memo.get(a.id);
    if (hit?.updatedAt === updatedAt) return hit.word;
    const word = wordOf(a.id);
    memo.set(a.id, { updatedAt, word });
    word.catch(() => memo.get(a.id)?.word === word && memo.delete(a.id));
    return word;
  }

  async function list(): Promise<LastWord[]> {
    const links = new Map(linked().map((l) => [l.agentId, l]));
    const handed = new Set(successors());
    const after = new Date(now() - maxAgeMs).toISOString();
    const picked = agents().filter((a) => done(a) && (a.updatedAt ?? '') >= after && tracked(a, links, handed))
      .sort((x, y) => (y.updatedAt ?? '').localeCompare(x.updatedAt ?? '')).slice(0, MAX_FETCHED);
    for (const id of memo.keys()) if (!picked.some((a) => a.id === id)) memo.delete(id);
    const words = await Promise.all(picked.map((a) => cached(a).catch(() => null)));
    return picked.flatMap((a, i) => {
      const w = words[i];
      if (!w) return [];
      const link = links.get(a.id);
      const pr = link ? String(link.key) : a.labels?.pr ? a.labels.pr.replaceAll('~', ':') : null;
      return [{ agentId: a.id, title: (a.title || '').replace(TITLE_PREFIX, '').trim().slice(0, TITLE_MAX) || a.id.slice(0, 8), work: link?.slug ?? a.labels?.work ?? null, pr, text: w.text, at: w.at }];
    });
  }

  // whether a change Paseo pushed may change the list: an agent it tracks started, ended, or was updated while idle
  function changed(a: AgentSnapshot) {
    if (!tracked(a, new Map(linked().map((l) => [l.agentId, l])), new Set(successors()))) return false;
    const state = `${a.status}|${a.archivedAt ?? ''}|${a.pendingPermissions?.length ?? 0}|${a.status === 'idle' ? a.updatedAt : ''}`;
    if (states.get(a.id) === state) return false;
    states.set(a.id, state);
    return true;
  }

  return { list, changed };
}
