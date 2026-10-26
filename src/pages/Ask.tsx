import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import Markdown from '../components/Markdown.tsx';
import AgentActivity from '../components/AgentActivity.tsx';
import { ThreadComposer } from '../components/Thread.tsx';
import { toast } from '../components/Toast.tsx';
import { pendingClass } from '../components/action.ts';
import type { ActivityEvent, AddRepoResult, AskRun, AskScope } from '../types.ts';

export type Run = Partial<AskRun> & { id: string };
type Pending = { nonce: string; text: string };
type StartFn = (prompt: string, nonce: string) => Promise<{ id: string }>;

const GLOBAL_EXAMPLES = [
  'Which works across my repos are blocked, and on what?',
  'Which repo does a CSV export of invoices belong in, and is there a precedent work for it?',
  'Add the acme/widgets repo to coco.',
];
const REPO_EXAMPLES = [
  'Scaffold a work for adding CSV export to the invoices page, mirroring the PDF export stack. Who reviews each PR?',
  'Which open PRs touch alice\'s surfaces this week and have no persona self-review yet?',
  'From Notion page https://www.notion.so/acme/Spec-00000000000000000000000000000000, list what is not built yet and propose a work for the next piece.',
  'Summarise the csv-export work: what is blocked, what is next.',
];

export function Proposal({ run, onApplied, label = 'Apply' }: { run: Run; onApplied?: (slug: string) => void; label?: string }) {
  const p = run.proposal;
  const [status, setStatus] = useState('');
  const [stackKept, setStackKept] = useState(false);
  if (!p) return null;
  const apply = async (replaceStack: boolean) => {
    setStatus('applying…');
    const r = await api.applyAsk(run.id, { replaceStack });
    setStackKept(Boolean(r.stackKept));
    setStatus(r.ok ? `${r.created ? 'created' : 'updated'} work ${r.slug}${r.stackKept ? ', stack kept' : ''}` : r.error ?? '');
    if (r.ok && r.slug && !r.stackKept) onApplied?.(r.slug);
  };
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-blue">proposal</span> <b>{p.title}</b> <code>{p.slug}</code> <span className="chip c-grey">tier {p.tier}</span></span>
        <span className="row">
          {stackKept ? <button className="primary" onClick={() => apply(true)}>Replace the stack too</button> : <button className="primary" onClick={() => apply(false)}>{label}</button>}
          <span className="status">{status}</span>
        </span>
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
      <details><summary>Notes and next steps</summary><Markdown text={p.notes} /><ul>{(p.nextSteps || []).map((s, i) => <li key={i}>{s}</li>)}</ul></details>    </div>
  );
}

export function AgentProposal({ run }: { run: Run }) {
  const p = run.agentProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const start = async () => {
    setStatus('starting…');
    const r = await api.startAskAgent(run.id);
    setStatus(r.ok ? `started ${r.agentId ? r.agentId.slice(0, 8) : ''}` : r.error ?? '');
  };
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-purple">paseo agent</span> <b>{p.title}</b> <span className="chip c-grey">{p.provider} · {p.thinking}</span></span>
        <span className="row"><button className="primary" onClick={start} disabled={status.startsWith('start')}>Start agent</button><span className="status">{status}</span></span>
      </div>
      <p style={{ marginTop: 8 }}>{p.why}</p>
      <div className="status">{p.workspaceId ? <>workspace <code>{p.workspaceId}</code></> : <>cwd <code>{p.cwd || 'the repo'}</code></>}{p.workSlug ? <> · work <a href={`#/work/${p.workSlug}`}>{p.workSlug}</a></> : null}</div>
      <details style={{ marginTop: 6 }}><summary>Brief</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{p.prompt}</pre></details>
    </div>
  );
}

export function DispatchProposal({ run }: { run: Run }) {
  const p = run.dispatchProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const confirm = async () => {
    setStatus('dispatching…');
    const r = await api.askDispatch(run.id).catch((e) => ({ ok: false, error: errorMessage(e), out: '' }));
    setStatus(r.ok ? r.out || 'started' : r.error ?? '');
  };
  const pr = p.pr == null ? 'the whole work' : /^\d+$/.test(String(p.pr)) ? `#${p.pr}` : String(p.pr).slice(2).replaceAll(':', '/');
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-purple">dispatch</span> <b>{p.entry}</b> on {pr}{p.persona ? <> as <code>{p.persona}</code></> : null}{p.edits ? <span className="chip c-grey">on the branch</span> : null}</span>
        <span className="row"><button className="primary" onClick={confirm} disabled={status === 'dispatching…' || status.startsWith('started')}>Confirm</button><span className="status">{status}</span></span>
      </div>
      {p.why && <p style={{ marginTop: 8 }}>{p.why}</p>}
      {p.prompt && <details style={{ marginTop: 6 }}><summary>Prompt</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{p.prompt}</pre></details>}
    </div>
  );
}

export const repoAdded = (r: AddRepoResult) => [
  `${r.repo?.name} ${r.how === 'cloned' ? 'cloned into' : r.how === 'found' ? 'found at' : 'at'} ${r.repo?.path}`,
  r.project?.error ? `no Paseo project: ${r.project.error}` : r.project ? `Paseo project ${r.project.name}` : null,
  r.setup?.error ? `setup run failed: ${r.setup.error}` : r.setup?.agentId ? `setup run ${r.setup.agentId.slice(0, 8)} proposes its config` : null,
].filter(Boolean).join(' · ');

// adds the repo, then opens its page: the overview reload that comes with the route shows its sidebar section
export async function addRepoAndOpen(add: () => Promise<AddRepoResult>) {
  const r = await add();
  toast.success(repoAdded(r));
  if (r.repo) location.hash = `#/repo/${r.repo.id}`;
  return r;
}

export function RepoProposal({ run }: { run: Run }) {
  const p = run.repoProposal;
  const [status, setStatus] = useState('');
  if (!p) return null;
  const confirm = async () => {
    setStatus('adding…');
    await addRepoAndOpen(() => api.askAddRepo(run.id)).then(() => setStatus('added'), (e) => setStatus(errorMessage(e)));
  };
  return (
    <div className="card" style={{ borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--brand-100)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span><span className="chip c-blue">new repo</span> <code>{p.source}</code></span>
        <span className="row"><button className="primary" onClick={confirm} disabled={status === 'adding…' || status === 'added'}>Add repo</button><span className="status">{status}</span></span>
      </div>
      {p.why && <p style={{ marginTop: 8 }}>{p.why}</p>}
      <div className="status">coco reuses a clone already on disk or clones it, lists it in your config, adds its Paseo project and starts a setup run proposing its config.</div>
    </div>
  );
}

// conversation states (older one-shot runs read done or error)
export const ASK_STATE: Record<string, [string, string]> = {
  running: ['c-blue', 'working'],
  idle: ['c-green', 'agent live'],
  parked: ['c-grey', 'agent archived after an idle hour'],
  closed: ['c-grey', 'closed'],
  done: ['c-grey', 'done'],
  error: ['c-red', 'error'],
};
// the agent's side of one turn: tool and thinking rows, its text streaming until the finished message replaces it
function AgentTurn({ events, active }: { events: ActivityEvent[]; active: boolean }) {
  return (
    <div className="thread-msg agent">
      <b>coco</b>
      <AgentActivity events={events} active={active} />
    </div>
  );
}

const LIVE = ['delta', 'think_delta'];

function UserMessage({ e, sending }: { e: { text?: string; steer?: boolean }; sending?: boolean }) {
  const text = e.text ?? '';
  const [first, ...rest] = text.split('\n');
  return (
    <div className="thread-msg user" style={sending ? { opacity: .6 } : undefined}>
      <b>You{e.steer ? ' · while coco worked' : ''}{sending ? ' · sending…' : ''}</b>
      {rest.length && text.length > 400 ? <details><summary>{first}</summary><Markdown text={rest.join('\n')} /></details> : <Markdown text={text} />}
    </div>
  );
}

// a run's events as a chat: each message of the owner, then what coco did and said until the next one
type Turn = { user?: ActivityEvent; agent?: ActivityEvent[] };

export function Conversation({ run, events, pending = [], working }: { run: Run; events: ActivityEvent[]; pending?: Pending[]; working: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [events.length, pending.length]);
  const all: ActivityEvent[] = events[0]?.type === 'user' || !run.prompt ? events : [{ type: 'user', text: run.prompt }, ...events];
  const turns: Turn[] = [];
  // a message sent mid-stream: the text still streaming carries over to the agent's side after it
  let carry: ActivityEvent[] = [];
  for (const e of all) {
    if (e.type === 'user') {
      const agent = turns.at(-1)?.agent;
      while (agent && LIVE.includes(agent.at(-1)?.type ?? '')) {
        const streaming = agent.pop();
        if (streaming) carry.unshift(streaming);
      }
      turns.push({ user: e });
    } else {
      if (!turns.length || turns.at(-1)?.user) turns.push({ agent: carry });
      carry = [];
      turns.at(-1)?.agent?.push(e);
    }
  }
  if (working && (!turns.length || turns.at(-1)?.user)) turns.push({ agent: carry });
  return (
    <div ref={ref} className="thread ask-conv">
      {turns.map((t, i) => (t.user ? <UserMessage key={i} e={t.user} /> : <AgentTurn key={i} events={t.agent ?? []} active={working && i === turns.length - 1} />))}
      {pending.map((p) => <UserMessage key={p.nonce} e={p} sending />)}
    </div>
  );
}

const nonceOf = () => Math.random().toString(36).slice(2, 12);
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
type AskConvo = ReturnType<typeof useAskConversation>;

// the conversation card: its messages, then the composer that stays open while coco works
type ConversationProps = { convo: AskConvo; start?: StartFn; placeholder: string; examples?: string[] };
export function AskConversation({ convo, start, placeholder, examples = [] }: ConversationProps) {
  const { run, events, pending, working, state, send, reset } = convo;
  const [closing, setClosing] = useState(false);
  const [chip, label] = (state && ASK_STATE[state]) || ['c-grey', state];
  const close = async () => {
    if (!run) return;
    setClosing(true);
    try {
      await api.closeAsk(run.id);
    } catch (e) {
      toast.error(errorMessage(e));
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
        onSend={(text) => send(text, start && ((nonce) => start(text, nonce)))}
      />
      {!run && examples.length > 0 && <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>{examples.map((e, i) => <button key={i} type="button" className="sm" onClick={() => send(e, start && ((nonce) => start(e, nonce)))}>{e.slice(0, 48)}…</button>)}</div>}
    </div>
  );
}

type HistoryProps = { title: string; history: AskRun[]; onOpen: (h: AskRun) => void; label?: (h: AskRun) => string };
export function AskHistory({ title, history, onOpen, label = (h) => h.prompt.slice(0, 110) }: HistoryProps) {
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
              <span className="status">{h.startedAt.slice(0, 16).replace('T', ' ')}{(h.turns ?? 0) > 1 ? ` · ${h.turns} turns` : ''}{h.proposal ? ` · ${h.proposal.title || 'proposal'}` : ''}{h.cost != null ? ` · $${Number(h.cost).toFixed(3)}` : ''}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

const SAFE = 'Follow up as long as you like, even while it works. It reads and proposes; you apply. Nothing is pushed, posted or sent.';

// three tiers: global (no work, no repo), a repo's (repoId: scaffolds its works), a work's (workSlug)
export default function Ask({ workSlug, repoId, repoName, convId }: { workSlug?: string; repoId?: string; repoName?: string; convId?: string }) {
  const scope: AskScope = workSlug ? { kind: 'work', slug: workSlug } : repoId ? { kind: 'repo', repoId } : { kind: 'global' };
  const convo = useAskConversation('ask', scope);
  const { run, open } = convo;
  useEffect(() => {
    if (convId && run?.id !== convId) api.askConversation(convId).then(open, (e) => toast.error(errorMessage(e)));
  }, [convId]);
  const repo = repoName || repoId;
  return (
    <>
      {scope.kind === 'global' && <h1>Ask coco 🦜</h1>}
      <p className="sub">
        {scope.kind === 'global' ? `The global coco, on cocopilot's own folder with its MCP server (works, personas, Paseo, gh): questions across your repos, and new repos. A new work starts from its repo's page. ${SAFE}`
          : scope.kind === 'repo' ? `Coco for ${repo}, on its main checkout: scaffolds new works in this repo and answers about its code and PRs. ${SAFE}`
          : `Coco for this work, in its Plan workspace: the plan, the stack and the findings. ${SAFE}`}
      </p>
      <AskConversation
        convo={convo}
        start={(prompt, nonce) => api.ask({ prompt, workSlug, repoId, nonce })}
        examples={scope.kind === 'global' ? GLOBAL_EXAMPLES : scope.kind === 'repo' ? REPO_EXAMPLES : []}
        placeholder={run ? 'Follow up, correct or narrow it down (markdown, ⌘↵)' : workSlug ? `Ask about or extend the ${workSlug} work… (⌘↵)` : repoId ? `Scaffold a work in ${repo} for … / Who reviews … (⌘↵)` : 'What is blocked across my repos … / Where does … belong (⌘↵)'}
      />
      {run && (
        <>
          <Proposal run={run} onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />
          <AgentProposal run={run} />
          <DispatchProposal run={run} />
          <RepoProposal run={run} />
        </>
      )}
      <AskHistory title={workSlug ? 'Earlier conversations on this work' : repoId ? `Earlier conversations on ${repo}` : 'Previous conversations'} history={convo.history} onOpen={open} />
    </>
  );
}
