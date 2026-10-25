import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import Markdown from '../components/Markdown.tsx';
import AgentActivity from '../components/AgentActivity.tsx';
import { ThreadComposer } from '../components/Thread.tsx';
import { toast } from '../components/Toast.tsx';
import { pendingClass } from '../components/action.ts';

const EXAMPLES = [
  'Scaffold a work for adding CSV export to the invoices page, mirroring the PDF export stack. Who reviews each PR?',
  'Which open PRs touch alice\'s surfaces this week and have no persona self-review yet?',
  'From Notion page https://www.notion.so/acme/Spec-00000000000000000000000000000000, list what is not built yet and propose a work for the next piece.',
  'Summarise the csv-export work: what is blocked, what is next.',
];

export function Proposal({ run, onApplied, label = 'Apply' }) {
  const p = run.proposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const apply = async (replaceStack) => {
    setStatus('applying…');
    const r = await api.applyAsk(run.id, { replaceStack });
    setStatus(r.ok ? `${r.created ? 'created' : 'updated'} work ${r.slug}` : r.error);
    if (r.ok) onApplied?.(r.slug);
  };
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-blue">proposal</span> <b>{p.title}</b> <code>{p.slug}</code> <span className="chip c-grey">tier {p.tier}</span></span>
        <span className="row"><button className="primary" onClick={() => apply(false)}>{label}</button><span className="status">{status}</span></span>
      </div>
      <p style={{ marginTop: 8 }}>{p.summary}</p>
      <div className="status">Paseo: {p.paseoProject?.existingProjectId ? `existing ${p.paseoProject.existingProjectId}` : p.paseoProject?.createNamed ? `create "${p.paseoProject.createNamed}"` : 'none'} · personas: {(p.personas || []).join(', ') || 'none'}</div>
      <h3>Planned stack</h3>
      {(p.stack || []).map((s) => (
        <div key={s.order} className="list-item"><span className="step">{s.order}</span> <b>{s.title}</b> <span className="status">{s.scope}</span><div className="status"><code>{s.branch}</code>{s.existingPr ? ` · #${s.existingPr}` : ''} · {(s.personas || []).map((x) => <span key={x} className="chip c-purple">{x}</span>)}</div></div>
      ))}
      <h3>Surfaces</h3>
      <table className="md" style={{ fontSize: 13 }}><tbody>{(p.surfaces || []).map((s, i) => <tr key={i}><td>{s.surface}</td><td><code>{s.entryPoint}</code></td><td>{s.coverage}</td></tr>)}</tbody></table>
      <h3>Open questions</h3>
      <ol>{(p.openQuestions || []).map((q, i) => <li key={i}>{q.question} <b>Recommended: {q.recommendation}.</b> <span className="status">{q.tradeoff}</span></li>)}</ol>
      <details><summary>Notes and next steps</summary><Markdown text={p.notes} /><ul>{(p.nextSteps || []).map((s, i) => <li key={i}>{s}</li>)}</ul></details>
      <div className="row" style={{ marginTop: 8 }}><button className="sm" onClick={() => apply(true)}>Apply and replace the existing stack</button></div>
    </div>
  );
}

function AgentProposal({ run }) {
  const p = run.agentProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const start = async () => {
    setStatus('starting…');
    const r = await api.startAskAgent(run.id);
    setStatus(r.ok ? `started ${r.agentId ? r.agentId.slice(0, 8) : ''}` : r.error);
  };
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-purple">paseo agent</span> <b>{p.title}</b> <span className="chip c-grey">{p.provider} · {p.thinking} · {p.mode}</span></span>
        <span className="row"><button className="primary" onClick={start} disabled={status.startsWith('start')}>Start agent</button><span className="status">{status}</span></span>
      </div>
      <p style={{ marginTop: 8 }}>{p.why}</p>
      <div className="status">{p.workspaceId ? <>workspace <code>{p.workspaceId}</code></> : <>cwd <code>{p.cwd || 'the repo'}</code></>}{p.workSlug ? <> · work <a href={`#/work/${p.workSlug}`}>{p.workSlug}</a></> : null}</div>
      <details style={{ marginTop: 6 }}><summary>Brief</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{p.prompt}</pre></details>
    </div>
  );
}

// conversation states (older one-shot runs read done or error)
export const ASK_STATE = {
  running: ['c-blue', 'working'],
  idle: ['c-green', 'agent live'],
  parked: ['c-grey', 'agent archived after an idle hour'],
  closed: ['c-grey', 'closed'],
  done: ['c-grey', 'done'],
  error: ['c-red', 'error'],
};
// the agent's side of one turn: tool and thinking rows, its text streaming until the finished message replaces it
function AgentTurn({ events, active }) {
  return (
    <div className="thread-msg agent">
      <b>coco</b>
      <AgentActivity events={events} active={active} />
    </div>
  );
}

const LIVE = ['delta', 'think_delta'];

function UserMessage({ e, sending }) {
  const [first, ...rest] = e.text.split('\n');
  return (
    <div className="thread-msg user" style={sending ? { opacity: .6 } : undefined}>
      <b>You{e.steer ? ' · while coco worked' : ''}{sending ? ' · sending…' : ''}</b>
      {rest.length && e.text.length > 400 ? <details><summary>{first}</summary><Markdown text={rest.join('\n')} /></details> : <Markdown text={e.text} />}
    </div>
  );
}

// a run's events as a chat: each message of the owner, then what coco did and said until the next one
export function Conversation({ run, events, pending = [], working }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [events.length, pending.length]);
  const all = events[0]?.type === 'user' || !run.prompt ? events : [{ type: 'user', text: run.prompt }, ...events];
  const turns = [];
  // a message sent mid-stream: the text still streaming carries over to the agent's side after it
  let carry = [];
  for (const e of all) {
    if (e.type === 'user') {
      const agent = turns.at(-1)?.agent;
      while (agent && LIVE.includes(agent.at(-1)?.type)) carry.unshift(agent.pop());
      turns.push({ user: e });
    } else {
      if (!turns.length || turns.at(-1).user) turns.push({ agent: carry });
      carry = [];
      turns.at(-1).agent.push(e);
    }
  }
  if (working && (!turns.length || turns.at(-1).user)) turns.push({ agent: carry });
  return (
    <div ref={ref} className="thread ask-conv">
      {turns.map((t, i) => (t.user ? <UserMessage key={i} e={t.user} /> : <AgentTurn key={i} events={t.agent} active={working && i === turns.length - 1} />))}
      {pending.map((p) => <UserMessage key={p.nonce} e={p} sending />)}
    </div>
  );
}

const nonceOf = () => Math.random().toString(36).slice(2, 12);

// one conversation streamed over SSE; the stream stays open for the follow-ups, and a reconnect replays the whole log
export function useAskConversation(kind, workSlug = null) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const source = useRef(null);
  const loadHistory = () => api.asks().then((list) => setHistory(list.filter((h) => (h.kind || 'ask') === kind && (!workSlug || h.workSlug === workSlug))), () => {});
  useEffect(() => {
    loadHistory();
    return () => source.current?.close();
  }, []);
  const watch = (conv) => {
    source.current?.close();
    setRun(conv);
    setEvents([]);
    const es = new EventSource(`/api/ask/${conv.id}/events`);
    source.current = es;
    es.onopen = () => setEvents([]);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.nonce) setPending((p) => p.filter((x) => x.nonce !== ev.nonce));
      if (ev.type === 'end' || ev.type === 'closed') {
        setRun((r) => r && { ...r, status: ev.conversation || ev.status, proposal: ev.proposal || r.proposal, agentProposal: ev.agentProposal || r.agentProposal, agentId: ev.agentId || r.agentId });
        loadHistory();
      }
    };
  };
  // the first message starts the conversation through start(nonce), any later one goes to its agent
  const send = async (text, start) => {
    const nonce = nonceOf();
    setPending((p) => [...p, { nonce, text }]);
    try {
      if (run) await api.askSay(run.id, { text, nonce });
      else {
        const { id } = await start(nonce);
        watch({ id, prompt: text, kind, status: 'running' });
        loadHistory();
      }
      return true;
    } catch (e) {
      setPending((p) => p.filter((x) => x.nonce !== nonce));
      toast.error(e.message);
      return false;
    }
  };
  const open = (h) => {
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

// the conversation card: its messages, then the composer that stays open while coco works
export function AskConversation({ convo, start, placeholder, examples = [] }) {
  const { run, events, pending, working, state, send, reset } = convo;
  const [closing, setClosing] = useState(false);
  const [chip, label] = ASK_STATE[state] || ['c-grey', state];
  const close = async () => {
    setClosing(true);
    try {
      await api.closeAsk(run.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setClosing(false);
    }
  };
  // a new conversation hands the current agent back unless it is mid-turn
  const fresh = () => {
    if (run && state === 'idle') api.closeAsk(run.id).catch(() => {});
    reset();
  };
  return (
    <div className="card">
      {run && (
        <div className="row thread-group" style={{ justifyContent: 'space-between' }}>
          <span className="status">conversation {run.id.slice(0, 8)} <span className={`chip ${chip}`}>{label}</span>{run.agentId ? <> · agent <code>{run.agentId.slice(0, 8)}</code></> : null}</span>
          <span className="row" style={{ gap: 6 }}>
            {(state === 'idle' || state === 'running') && <button type="button" className={`sm${pendingClass(closing)}`} disabled={closing} title="Archive coco's agent; a new message starts a new one with the conversation so far" onClick={close}>Close</button>}
            <button type="button" className="sm" onClick={fresh}>New conversation</button>
          </span>
        </div>
      )}
      {run && <Conversation run={run} events={events} pending={pending} working={working} />}
      <ThreadComposer
        busy={false}
        rows={run ? 2 : 4}
        sendLabel={!run ? 'Ask' : working ? 'Send while it works' : 'Send'}
        placeholder={placeholder}
        onSend={(text) => send(text, (nonce) => start(text, nonce))}
      />
      {!run && examples.length > 0 && <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>{examples.map((e, i) => <button key={i} type="button" className="sm" onClick={() => send(e, (nonce) => start(e, nonce))}>{e.slice(0, 48)}…</button>)}</div>}
    </div>
  );
}

export function AskHistory({ title, history, onOpen, label = (h) => h.prompt.slice(0, 110) }) {
  if (!history.length) return null;
  return (
    <>
      <h2>{title}</h2>
      <div className="card">
        {history.map((h) => {
          const [chip, text] = ASK_STATE[h.status] || ['c-grey', h.status];
          return (
            <div key={h.id} className="list-item row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => onOpen(h)}>
              <span><span className={`chip ${chip}`}>{text}</span> {label(h)}</span>
              <span className="status">{h.startedAt.slice(0, 16).replace('T', ' ')}{h.turns > 1 ? ` · ${h.turns} turns` : ''}{h.proposal ? ` · ${h.proposal.title || 'proposal'}` : ''}{h.cost != null ? ` · $${Number(h.cost).toFixed(3)}` : ''}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function Ask({ workSlug }) {
  const convo = useAskConversation('ask', workSlug);
  const { run, open } = convo;
  return (
    <>
      {!workSlug && <h1>Ask coco 🦜</h1>}
      <p className="sub">A conversation with one Paseo agent in your repo with the cocopilot MCP server (works, personas, Paseo, gh): follow up as long as you like, even while it works. It reads and proposes; you apply. Nothing is pushed, posted or sent.</p>
      <AskConversation
        convo={convo}
        start={(prompt, nonce) => api.ask({ prompt, workSlug, nonce })}
        examples={workSlug ? [] : EXAMPLES}
        placeholder={run ? 'Follow up, correct or narrow it down (markdown, ⌘↵)' : workSlug ? `Ask about or extend the ${workSlug} work… (⌘↵)` : 'Scaffold a work for … / Who reviews … / What is blocked on … (⌘↵)'}
      />
      {run && (
        <>
          <Proposal run={run} onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />
          <AgentProposal run={run} />
        </>
      )}
      <AskHistory title={workSlug ? 'Earlier conversations on this work' : 'Previous conversations'} history={convo.history} onOpen={open} />
    </>
  );
}
