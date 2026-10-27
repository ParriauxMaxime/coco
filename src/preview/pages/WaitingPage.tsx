import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { pendingClass, useAction } from '../../components/action.ts';
import { toast } from '../../components/Toast.tsx';
import { prLabel } from '../agents.ts';
import { forget, useWaiting } from '../waiting.ts';
import Icon from '../Icon.tsx';
import { Empty, Loading, Page, PageHead, Section } from './Page.tsx';
import type { Overview, WaitingAction, WaitingItem } from '../../types.ts';
import './waiting.css';

const KIND: Record<WaitingItem['kind'], string> = { card: 'question', approve: 'approve', thread: 'thread', ask: 'ask' };
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
// what Dismiss selected does to an item: its own dismiss, else the ack that hides it
const dismissOf = (i: WaitingItem) => i.actions.find((a) => a.kind === 'dismiss') || i.actions.find((a) => a.kind === 'ack');
const replyOf = (i: WaitingItem) => i.actions.find((a) => a.kind === 'reply');

function Row({ item, on, onTick, run, pending }: { item: WaitingItem; on: boolean; onTick: () => void; run: (a: WaitingAction, text?: string) => void; pending: string | null }) {
  const [text, setText] = useState('');
  const reply = replyOf(item);
  const key = (a: WaitingAction) => `${item.id}:${a.id}`;
  const send = () => {
    if (reply && text.trim()) {
      run(reply, text.trim());
      setText('');
    }
  };
  return (
    <div className={`dp-wt-row${on ? ' dp-on' : ''}`}>
      <input type="checkbox" className="dp-wt-tick" checked={on} onChange={onTick} aria-label={`Select ${item.title}`} />
      <div className="dp-wt-b">
        <div className="dp-wt-h">
          <span className="dp-chip">{KIND[item.kind]}</span>
          <a className="dp-ell dp-wt-title" href={item.link}><b>{item.title}</b></a>
          <span className="dp-t3 dp-sm dp-num">{when(item.at)}</span>
        </div>
        {item.excerpt && <div className="dp-wt-x">{item.excerpt}</div>}
        <div className="dp-wt-f">
          {item.actions.filter((a) => a.kind !== 'reply').map((a) => (
            <button key={a.id} type="button" className={`dp-btn dp-sm${a.kind === 'approve' ? ' dp-primary' : a.kind === 'dismiss' || a.kind === 'ack' ? ' dp-ghost' : ''}${pendingClass(pending === key(a))}`} disabled={pending !== null} onClick={() => run(a)}>{a.label}</button>
          ))}
          {reply && (
            <span className="dp-wt-reply">
              <input value={text} placeholder="Reply to the agent…" disabled={pending !== null} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
              <button type="button" className={`dp-btn dp-sm${pendingClass(pending === key(reply))}`} disabled={pending !== null || !text.trim()} onClick={send}>Send</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// work, then PR (null: the work itself), items newest first as the server sorted them
function grouped(items: WaitingItem[]) {
  const works = new Map<string | null, Map<string | null, WaitingItem[]>>();
  for (const i of items) {
    const prs = works.get(i.work) ?? new Map<string | null, WaitingItem[]>();
    prs.set(i.pr, [...(prs.get(i.pr) ?? []), i]);
    works.set(i.work, prs);
  }
  return [...works];
}

export default function WaitingPage({ ov }: { ov: Overview | null }) {
  const view = useWaiting();
  const [picked, setPicked] = useState<string[]>([]);
  const { pending, run } = useAction();
  const items = view?.items ?? [];
  const mine = picked.filter((id) => items.some((i) => i.id === id));
  const tick = (ids: string[]) => setPicked((p) => (ids.every((id) => p.includes(id)) ? p.filter((id) => !ids.includes(id)) : [...new Set([...p, ...ids])]));
  const act = (item: WaitingItem) => (a: WaitingAction, text?: string) =>
    void run(`${item.id}:${a.id}`, () => api.waitingAct(a, text)).then((r) => r !== undefined && forget([item.id]));
  // one common action over the ticked rows: each runs its own endpoint; items without it are skipped
  const batch = async (label: string, of: (i: WaitingItem) => WaitingAction | undefined, text?: string) => {
    const todo = items.filter((i) => mine.includes(i.id)).flatMap((i) => { const a = of(i); return a ? [{ i, a }] : []; });
    const done: string[] = [];
    const failed: string[] = [];
    for (const { i, a } of todo) {
      try {
        await api.waitingAct(a, text);
        done.push(i.id);
      } catch (e) {
        failed.push(`${i.title}: ${errorMessage(e)}`);
      }
    }
    forget(done);
    setPicked([]);
    if (failed.length) toast.error(`${label}: ${failed.length} failed. ${failed[0]}`);
    else toast.success(`${label}: ${done.length} of ${mine.length}`);
  };
  const title = (slug: string | null) => (slug ? ov?.works.find((w) => w.slug === slug)?.title || slug : 'No work');

  return (
    <Page>
      <PageHead icon="clock" title="Waiting on you" sub="Open questions, agents that finished their turn and wait for your word, and suggestions with an Approve. Nothing here acts until you click." />
      {mine.length > 0 && (
        <div className="dp-wt-batch">
          <b>{mine.length} selected</b>
          <button type="button" className="dp-btn dp-sm" onClick={() => void batch('Dismissed', dismissOf)}>Dismiss selected</button>
          <button type="button" className="dp-btn dp-sm" onClick={() => void batch('Sent go', replyOf, 'go')}>Send &lsquo;go&rsquo; to selected</button>
          <button type="button" className="dp-btn dp-ghost dp-sm" onClick={() => setPicked([])}>Clear</button>
        </div>
      )}
      {!view ? <Loading /> : !items.length ? <Empty icon="check">Nothing waits on you.</Empty> : grouped(items).map(([work, prs]) => {
        const all = [...prs.values()].flat();
        return (
          <Section key={work ?? ''} title={work ? <a href={`#/work/${work}`}>{title(work)}</a> : title(work)} count={all.length} action={<button type="button" className="dp-btn dp-ghost dp-sm" onClick={() => tick(all.map((i) => i.id))}>{all.every((i) => mine.includes(i.id)) ? 'Unselect all' : 'Select all'}</button>}>
            {[...prs].map(([pr, list]) => (
              <div key={pr ?? ''} className="dp-box dp-wt-group">
                <div className="dp-wt-gh"><Icon name="git-branch" size={12} />{pr ? prLabel(pr) : 'Work'}<span className="dp-count">{list.length}</span></div>
                {list.map((i) => <Row key={i.id} item={i} on={mine.includes(i.id)} onTick={() => tick([i.id])} run={act(i)} pending={pending} />)}
              </div>
            ))}
          </Section>
        );
      })}
    </Page>
  );
}
