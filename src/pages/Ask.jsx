import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Markdown from '../components/Markdown.jsx';

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

// text streams in as deltas until its finished message arrives as one text event
export function Transcript({ events }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [events.length]);
  const last = events.findLastIndex((e) => e.type !== 'delta');
  const live = events.slice(last + 1).map((e) => e.text).join('');
  return (
    <div ref={ref} style={{ maxHeight: '50vh', overflow: 'auto' }}>
      {events.map((e, i) => {
        if (e.type === 'text') return <div key={i} style={{ margin: '6px 0' }}><Markdown text={e.text} /></div>;
        if (e.type === 'tool') return <div key={i} className="status">⚙ {e.name.replace('mcp__cocopilot__', 'coco.')} <code>{e.input.slice(0, 120)}</code></div>;
        if (e.type === 'tool_result') return <div key={i} className="status" style={{ opacity: .7 }}>↳ {e.text.slice(0, 160)}</div>;
        if (e.type === 'stderr') return <div key={i} className="status danger">{e.text}</div>;
        if (e.type === 'end') return <div key={i} className="status">— {e.status}{e.cost != null ? ` · $${Number(e.cost).toFixed(3)}` : ''}</div>;
        if (e.type === 'meta') return <div key={i} className="status" style={{ opacity: .6 }}>{e.text}</div>;
        return null;
      })}
      {live && <div style={{ margin: '6px 0' }}><Markdown text={live} /></div>}
    </div>
  );
}

// one coco run streamed over SSE: follow a run just started, or open a past one
export function useAskRun(kind) {
  const [run, setRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const loadHistory = () => api.asks().then((list) => setHistory(list.filter((h) => (h.kind || 'ask') === kind)));
  useEffect(() => { loadHistory(); }, []);
  const follow = (id, prompt) => {
    setBusy(true);
    setEvents([]);
    setRun({ id, prompt, proposal: null, agentProposal: null });
    const es = new EventSource(`/api/ask/${id}/events`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.type === 'end') { es.close(); setBusy(false); setRun((r) => ({ ...r, proposal: ev.proposal, agentProposal: ev.agentProposal, status: ev.status })); loadHistory(); }
    };
    es.onerror = () => { es.close(); setBusy(false); };
  };
  const open = (h) => {
    setRun(h);
    const es = new EventSource(`/api/ask/${h.id}/events`);
    const acc = [];
    es.onmessage = (m) => { acc.push(JSON.parse(m.data)); setEvents([...acc]); };
    es.onerror = () => es.close();
  };
  return { run, events, history, busy, setBusy, follow, open };
}

export default function Ask({ workSlug }) {
  const [prompt, setPrompt] = useState('');
  const { run, events, history, busy, setBusy, follow, open } = useAskRun('ask');
  const launch = async (text) => {
    const q = text || prompt;
    if (!q) return;
    setBusy(true);
    const { id } = await api.ask({ prompt: q, workSlug });
    follow(id, q);
  };
  return (
    <>
      {!workSlug && <h1>Ask coco 🦜</h1>}
      <p className="sub">Natural language in, proposal out. Runs a Paseo agent in your repo with the cocopilot MCP server (works, personas, Paseo, gh). It reads and proposes; you apply. Nothing is pushed, posted or sent.</p>
      <div className="card">
        <textarea className="short" style={{ minHeight: 90 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={workSlug ? `Ask about or extend the ${workSlug} work…` : 'Scaffold a work for … / Who reviews … / What is blocked on …'} />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" disabled={busy || !prompt} onClick={() => launch()}>{busy ? <><span className="spinner" aria-hidden /> coco is thinking…</> : 'Ask'}</button>
          {!workSlug && EXAMPLES.map((e, i) => <button key={i} className="sm" disabled={busy} onClick={() => { setPrompt(e); launch(e); }}>{e.slice(0, 48)}…</button>)}
        </div>
      </div>
      {run && (
        <>
          <div className="card"><div className="status" style={{ marginBottom: 6 }}>run {run.id.slice(0, 8)} · {run.prompt}</div><Transcript events={events} /></div>
          <Proposal run={run} onApplied={(slug) => { location.hash = `#/work/${slug}`; }} />
          <AgentProposal run={run} />
        </>
      )}
      {!workSlug && history.length > 0 && (
        <>
          <h2>Previous asks</h2>
          <div className="card">{history.map((h) => <div key={h.id} className="list-item row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => open(h)}><span><span className={`chip ${h.status === 'done' ? 'c-green' : 'c-red'}`}>{h.status}</span> {h.prompt.slice(0, 110)}</span><span className="status">{h.startedAt.slice(0, 16).replace('T', ' ')}{h.proposal ? ' · proposal' : ''}{h.cost != null ? ` · $${Number(h.cost).toFixed(3)}` : ''}</span></div>)}</div>
        </>
      )}
    </>
  );
}
