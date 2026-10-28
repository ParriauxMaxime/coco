// What a composer does to a live agent without leaving coco, as Paseo's own composer does: switch its mode, list its slash commands,
// recall the prompts the user sent it, rename it.
import { HttpError, errorMessage, httpStatus } from './core-types.ts';
import { TITLE_PREFIX, cocoTitle } from './paseo-agent.ts';
import type { DaemonClient } from './paseo-agent.ts';
import type { Models } from './models.ts';
import type { ReadBody, Req, Res, Send } from './core-types.ts';

const ID = /^[\w-]{1,80}$/;
const NAME_MAX = 80;
// the latest prompts the Up arrow cycles through; a clipped preview is read in full from the timeline
const PROMPTS = 30;
const CLIPPED = '…';

export type Command = { name: string; description: string; hint: string; kind: string };
export type Prompt = { text: string; at: string | null };
type Options = {
  client: () => Promise<Pick<DaemonClient, 'agents' | 'updateAgent' | 'listAgentTimelinePrompts'>>;
  models: Pick<Models, 'liveModes' | 'setMode'>;
  // coco's own copy of the title (an Ask conversation's), told once Paseo has the new one
  renamed?: (agentId: string, title: string) => void;
};

export function createAgentControls({ client, models, renamed }: Options) {
  async function commands(agentId: string): Promise<{ commands: Command[]; error: string | null }> {
    const agent = (await client()).agents.ref(agentId);
    if (!agent.commands) throw new HttpError(501, 'this Paseo client cannot list commands');
    const r = await agent.commands();
    const list = (r.commands || []).map((c) => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '', kind: c.kind || 'command' }));
    return { commands: list.filter((c) => c.name && !c.name.startsWith('__')).sort((a, b) => a.name.localeCompare(b.name)), error: r.error || null };
  }

  // what the user sent it, oldest first, the latest PROMPTS only
  async function prompts(agentId: string): Promise<{ prompts: Prompt[] }> {
    const c = await client();
    if (!c.listAgentTimelinePrompts) throw new HttpError(501, 'this Paseo client cannot list prompts');
    const index = await c.listAgentTimelinePrompts(agentId);
    if (index.error) throw new HttpError(502, index.error);
    const timeline = c.agents.ref(agentId).timeline;
    const full = async (seq: number, preview: string) => {
      if (!preview.endsWith(CLIPPED) || !index.epoch || !timeline.refetch) return preview;
      const page = await timeline.refetch({ direction: 'after', cursor: { epoch: index.epoch, seq: seq - 1 }, limit: 1, projection: 'projected' }).catch(() => null);
      const item = page?.entries[0]?.item;
      return item?.type === 'user_message' && item.text ? item.text : preview;
    };
    const latest = (index.prompts || []).slice(-PROMPTS);
    return { prompts: await Promise.all(latest.map(async (p) => ({ text: await full(p.seq, p.preview), at: p.timestamp || null }))) };
  }

  // an agent coco started keeps its `coco · ` prefix, which coco's lists strip
  async function rename(agentId: string, name: unknown) {
    if (typeof name !== 'string') throw new HttpError(400, 'name must be a string');
    const title = name.replace(/\s+/g, ' ').trim();
    if (!title) throw new HttpError(400, 'name required');
    if (title.length > NAME_MAX) throw new HttpError(400, `name too long: at most ${NAME_MAX} characters`);
    const c = await client();
    const found = (await c.agents.ref(agentId).refresh())?.agent;
    if (!found) throw new HttpError(404, 'Paseo no longer knows this agent');
    if (!c.updateAgent) throw new HttpError(501, 'this Paseo client cannot rename an agent');
    const full = found.title?.startsWith(TITLE_PREFIX) ? cocoTitle(title) : title;
    await c.updateAgent(agentId, { name: full });
    renamed?.(agentId, title);
    return { ok: true, title };
  }

  // GET|POST /api/agent-chat/<agentId>/mode · GET /api/agent-chat/<agentId>/commands|prompts · POST /api/agent-chat/<agentId>/rename
  async function handle(req: Req, res: Res, parts: string[], readBody: ReadBody, send: Send) {
    const [, agentId, what] = parts;
    try {
      if (!ID.test(agentId || '')) throw new HttpError(400, 'bad agent id');
      const body = async () => {
        try {
          return JSON.parse((await readBody(req)) || '{}');
        } catch {
          throw new HttpError(400, 'body must be JSON');
        }
      };
      if (what === 'mode' && req.method === 'GET') return send(res, 200, await models.liveModes(agentId));
      if (what === 'mode' && req.method === 'POST') return send(res, 200, await models.setMode(agentId, (await body()).mode));
      if (what === 'commands' && req.method === 'GET') return send(res, 200, await commands(agentId));
      if (what === 'prompts' && req.method === 'GET') return send(res, 200, await prompts(agentId));
      if (what === 'rename' && req.method === 'POST') return send(res, 200, await rename(agentId, (await body()).name));
      return send(res, 404, { error: 'no route' });
    } catch (e) {
      return send(res, httpStatus(e), { error: errorMessage(e) });
    }
  }

  return { handle, commands, prompts, rename };
}
export const AGENT_CONTROLS = ['mode', 'commands', 'prompts', 'rename'];
