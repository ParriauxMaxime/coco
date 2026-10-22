import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from '../../components/Markdown.jsx';
import Collapsible from '../../components/Collapsible.jsx';
import { useWork } from '../use-work.js';
import { useWorkbench } from '../workbench-store.js';
import { reviewApi, loadReview } from './use-comments.js';
import { keyLabel } from './ids.js';
import { useConfig } from '../../config.js';
import './code.css';

const POLL_MS = 5000;
const STATUS_CHIP = { running: 'c-orange', done: 'c-green', failed: 'c-red' };
const short = (sha) => (sha ? sha.slice(0, 9) : '…');

function useStackFix(slug, live) {
  const [state, setState] = useState({ runs: [], open: [] });
  const running = state.runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!live) return undefined;
    let on = true;
    const load = () => reviewApi.stackFix(slug).then((s) => on && setState(s)).catch(() => {});
    load();
    const t = setInterval(load, running ? POLL_MS : 30000);
    return () => { on = false; clearInterval(t); };
  }, [slug, live, running]);
  return state;
}

function FixDialog({ slug, open, onClose, onSent }) {
  const [commits, setCommits] = useState('one');
  const models = useConfig((s) => s.models);
  const providers = [...new Set([models.default, models.fast].filter(Boolean))];
  const [picked, setProvider] = useState('');
  const provider = picked || providers[0] || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const total = open.reduce((n, r) => n + r.count, 0);
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      onSent(await reviewApi.startStackFix(slug, { commits, ...(provider ? { provider } : {}) }));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="cc-scrim" onMouseDown={() => !busy && onClose()}>
      <div className="card cc-dialog" role="dialog" aria-label="Fix all comments" onMouseDown={(e) => e.stopPropagation()}>
        <b>Fix all comments · one agent, bottom-up</b>
        <ul className="sd-list">
          {open.map((r, i) => <li key={r.key}><code>{i + 1}</code> {keyLabel(r.key)} · {r.count ? `${r.count} open` : 'restack only when its parent moves'}</li>)}
        </ul>
        <div className="row">
          <label className="row"><input type="radio" name="sf-commits" checked={commits === 'one'} onChange={() => setCommits('one')} /> one commit per comment</label>
          <label className="row"><input type="radio" name="sf-commits" checked={commits === 'squash'} onChange={() => setCommits('squash')} /> one commit per row</label>
          {providers.length > 0 && <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ marginLeft: 'auto' }}>{providers.map((p) => <option key={p}>{p}</option>)}</select>}
        </div>
        <pre className="sd-preview">{`${total} comments · row 1 first, each row fixed on its branch, children restacked with git rebase --onto\na restack conflict stops the chain · never push, never post`}</pre>
        {error && <div className="card danger" style={{ margin: '8px 0 0' }}>{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="sm" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="sm primary" disabled={busy || !total} onClick={send}>{busy ? 'Starting…' : 'Start'}</button>
        </div>
      </div>
    </div>
  );
}

function ImportDialog({ slug, onClose, onDone }) {
  const [files, setFiles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { reviewApi.reviewFiles(slug).then((r) => setFiles(r.files), (e) => setError(e.message)); }, [slug]);
  const run = async (path) => {
    setBusy(true);
    setError('');
    try {
      setOut(await reviewApi.importReview(slug, path));
      onDone();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="cc-scrim" onMouseDown={() => !busy && onClose()}>
      <div className="card cc-dialog" role="dialog" aria-label="Import review findings" onMouseDown={(e) => e.stopPropagation()}>
        <b>Import review findings as comments</b>
        {!out && (
          <ul className="sd-list">
            {(files || []).map((f) => <li key={f.path}><button className="cc-link" disabled={busy} onClick={() => run(f.path)} title={f.path}>{f.name}</button> <span className="status">{new Date(f.mtime).toLocaleString()}</span></li>)}
            {files && !files.length && <li className="status">No review file in .claude/reviews.</li>}
            {!files && !error && <li className="status">Loading…</li>}
          </ul>
        )}
        {out && (
          <ul className="sd-list">
            {out.added.map((a) => <li key={a.id}><span className="chip c-green">added</span> <code>{a.where}</code> on {keyLabel(a.key)}</li>)}
            {out.skipped.map((s, i) => <li key={i} className="off"><span className="chip c-grey">skipped</span> <code>{s.where}</code> {s.reason}</li>)}
          </ul>
        )}
        {error && <div className="card danger" style={{ margin: '8px 0 0' }}>{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button className="sm" disabled={busy} onClick={onClose}>{out ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  );
}

const RowLine = ({ row, i }) => (
  <li>
    <code>{i + 1}</code> {row.branch} · {row.commentIds.length} comments · {short(row.tipBefore)} → {short(row.tipAfter)}
    {row.restacked && <span className="chip c-blue">restacked</span>}
    {row.error && <span className="chip c-red" title={row.error}>{row.error.slice(0, 80)}</span>}
  </li>
);

export function StackFixCard({ group }) {
  const { slug } = useWork();
  const { runs, open } = useStackFix(slug, true);
  const [dialog, setDialog] = useState(null);
  const total = open.reduce((n, r) => n + r.count, 0);
  const rows = open.filter((r) => r.count).length;
  const last = runs[0];
  const openTab = (id) => useWorkbench.getState().open(`stack-${id}`, { group: group === 1 ? 2 : 1 });
  const refresh = () => open.forEach((r) => loadReview(slug, r.key));
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Review comments on the stack</b>
        <span className="row">
          <button className="sm" onClick={() => setDialog('import')}>Import review…</button>
          <button className="sm primary" disabled={!total || last?.status === 'running'} onClick={() => setDialog('fix')}>Fix all comments ({total} on {rows} row{rows === 1 ? '' : 's'})</button>
        </span>
      </div>
      {last && (
        <div className="status" style={{ marginTop: 6 }}>
          <a href="#" onClick={(e) => { e.preventDefault(); openTab(last.id); }}>stack fix {last.id}</a> <span className={`chip ${STATUS_CHIP[last.status] || 'c-grey'}`}>{last.status}</span> {new Date(last.startedAt).toLocaleString()}
          {last.pushWarned && <span className="chip c-red">remote head moved</span>}
        </div>
      )}
      {dialog === 'fix' && <FixDialog slug={slug} open={open} onClose={() => setDialog(null)} onSent={(run) => { setDialog(null); refresh(); openTab(run.id); }} />}
      {dialog === 'import' && <ImportDialog slug={slug} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

export default function StackRun({ tabId }) {
  const { slug } = useWork();
  const id = tabId.slice(6);
  const active = useWorkbench((s) => s.groups.some((g) => g.active === tabId));
  const { runs } = useStackFix(slug, active);
  const run = runs.find((r) => r.id === id);
  const [brief, setBrief] = useState(null);
  const [out, setOut] = useState('');
  const pre = useRef(null);
  const done = run && run.status !== 'running';
  useEffect(() => { reviewApi.stackFixBrief(slug, id).then(setBrief); }, [slug, id]);
  useEffect(() => {
    if (!run?.agentId || !active) return undefined;
    let on = true;
    const tick = () => reviewApi.stackFixLogs(slug, id).then((l) => on && setOut(l.out || ''), (e) => on && setOut(e.message));
    tick();
    if (done) return () => { on = false; };
    const t = setInterval(tick, POLL_MS);
    return () => { on = false; clearInterval(t); };
  }, [slug, id, run?.agentId, active, done]);
  useLayoutEffect(() => { if (pre.current) pre.current.scrollTop = pre.current.scrollHeight; }, [out]);
  useEffect(() => { if (done) run.rows.forEach((r) => loadReview(slug, r.key)); }, [done]);

  if (!run) return <div className="sub">Loading stack fix…</div>;
  return (
    <div className="ar">
      <div className="row">
        <b>Stack fix <code>{id}</code></b>
        <span className="chip c-grey">{run.mode}</span>
        <span className={`chip ${STATUS_CHIP[run.status] || 'c-grey'}`}>{run.status}</span>
        {run.pushWarned && <span className="chip c-red">remote head moved</span>}
      </div>
      <div className="status" style={{ margin: '4px 0 8px' }}>
        started {new Date(run.startedAt).toLocaleString()}{run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleTimeString()}` : ''} · {run.commits === 'squash' ? 'one commit per row' : 'one commit per comment'} · {run.provider} · agent <code>{(run.agentId || '?').slice(0, 8)}</code>{run.cwd ? <> · <code>{run.cwd}</code></> : null}
      </div>
      <ul className="sd-list">{run.rows.map((row, i) => <RowLine key={row.key} row={row} i={i} />)}</ul>
      {brief && <Collapsible title="Brief sent to the agent" badge={run.briefPath?.split('/').pop()}><Markdown text={brief} /></Collapsible>}
      <h3>Logs {done ? '' : '· live every 5 s'}</h3>
      <pre ref={pre} className="ar-log">{out || '…'}</pre>
    </div>
  );
}
