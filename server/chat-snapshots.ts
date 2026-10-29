// The replayed chat of each idle or archived agent, so its tab opens without waiting on Paseo to load a cold timeline:
// its events, the cursor of its last timeline entry and Paseo's updatedAt then; a later turn is read as the entries after that cursor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActivityEvent, Cursor } from './paseo-agent.ts';

export type ChatSnapshot = { updatedAt: string | null; cursor: Cursor; events: ActivityEvent[] };
export type ChatSnapshots = ReturnType<typeof createChatSnapshots>;

const AGENT_ID = /^[\w-]{1,80}$/;

export function createChatSnapshots(dir: string) {
  const fileOf = (agentId: string) => (AGENT_ID.test(agentId) ? path.join(dir, `${agentId}.json`) : null);
  function get(agentId: string): ChatSnapshot | null {
    const file = fileOf(agentId);
    try {
      return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch {
      return null;
    }
  }
  function put(agentId: string, snapshot: ChatSnapshot) {
    const file = fileOf(agentId);
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file);
  }
  function drop(agentId: string) {
    const file = fileOf(agentId);
    if (file) fs.rmSync(file, { force: true });
  }
  return { get, put, drop };
}
