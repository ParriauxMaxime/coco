import React, { useEffect, useState } from 'react';
import { PersonaChip } from '../components/PersonaChip.tsx';
import { api } from '../api.ts';
import { ritualFields, useConfig } from '../config.ts';
import Markdown from '../components/Markdown.tsx';
import TeamPack from '../components/TeamPack.tsx';
import Onboarding from '../components/Onboarding.tsx';

const statusChip = (s) => (s === 'running' ? 'c-green' : s === 'idle' ? 'c-grey' : s === 'error' ? 'c-red' : 'c-orange');

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const rituals = useConfig((s) => s.rituals);
  useEffect(() => {
    api.overview().then(setData).catch((e) => setErr(e.message));
  }, []);
  if (err) return <div className="card danger">{err}</div>;
  if (!data) return <div className="sub">Loading…</div>;
  const reviewers = data.personas.filter((p) => p.kind === 'reviewer');
  const writers = data.personas.filter((p) => p.kind === 'writer');
  const personaRituals = rituals.filter((r) => ritualFields(r).includes('login'));
  const writerRitual = rituals.find((r) => ritualFields(r).includes('text'));
  return (
    <>
      <h1>cocopilot</h1>
      <p className="sub">Copiloting the copilots: skills, personas, works and Paseo agents, in one place. Runs on your machine; agents never push, post or send on their own.</p>
      <Onboarding />
      <div className="card kpis">
        <div className="kpi"><div className="label">Personas</div><div className="value">{data.personas.length}</div></div>
        <div className="kpi"><div className="label">Stale (&gt;60d)</div><div className="value">{data.personas.filter((p) => p.stale).length}</div></div>
        <div className="kpi"><div className="label">Skills</div><div className="value">{data.skills.length}</div></div>
        <div className="kpi"><div className="label">Agents running</div><div className="value">{data.agents.filter((a) => a.status === 'running').length}</div></div>
        <div className="kpi"><div className="label">Feedback</div><div className="value">{data.feedbackCount}</div></div>
      </div>

      <h2>Works <a href="#/projects" className="sub">projects →</a></h2>
      <div className="grid">
        {(data.works || []).filter((wk) => !wk.archived || localStorage.getItem('showArchived') === '1').map((wk) => (
          <a key={wk.slug} className="card" href={`#/work/${wk.slug}`}>
            <b style={{ color: 'var(--ink)' }}>{wk.title}</b>
            <div className="row" style={{ marginTop: 6 }}><span className="chip c-grey">{wk.projectName}</span><span className="chip c-blue">{wk.stack} PRs</span>{wk.archived && <span className="chip c-grey">archived</span>}<span className="status">{(wk.updatedAt || '').slice(0, 10)}</span></div>
          </a>
        ))}
        {(data.works || []).length === 0 && <div className="sub">No work yet. Attach one from Projects.</div>}
      </div>

      <h2>Reviewer personas</h2>
      <div className="grid">
        {reviewers.map((p) => (
          <a key={p.login} className="card" href={`#/persona/${p.login}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b style={{ color: 'var(--ink)' }}>{p.title.replace(/ — .*$/, '')}</b>
              <PersonaChip login={p.login} href={null} />
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <span className="chip c-blue">{p.surfaces} surfaces</span>
              <span className="chip c-purple">{p.checks} checks</span>
              {p.hasSlack && <span className="chip c-green">slack</span>}
              {p.calibration > 0 && <span className="chip c-orange">{p.calibration} calibrations</span>}
              <span className={`chip ${p.stale ? 'c-red' : 'c-grey'}`}>mined {p.mined}{p.stale ? ' · stale' : ''}</span>
            </div>
          </a>
        ))}
      </div>
      {writers.length > 0 && (
        <>
          <h2>Message-writer personas</h2>
          <div className="grid">
            {writers.map((p) => (
              <a key={p.login} className="card" href={`#/persona/${p.login}`}>
                <b style={{ color: 'var(--ink)' }}>{p.title.replace(/ — .*$/, '')}</b> <code>{p.login}</code>
                <div className="sub" style={{ marginTop: 4 }}>{writerRitual ? `Used by the ${writerRitual.label || writerRitual.kind} ritual. ` : ''}Drafts only; nothing is sent.</div>
              </a>
            ))}
          </div>
        </>
      )}
      {personaRituals.length > 0 && (
        <div className="row" style={{ margin: '8px 0 0' }}>
          {personaRituals.map((r) => <a key={r.kind} href={`#/rituals/${r.kind}`}><button>{r.label || r.kind}</button></a>)}
        </div>
      )}

      <h2>Skills</h2>
      <div className="card">
        {data.skills.map((s) => (
          <div key={s.name} className="list-item">
            <a href={`#/skill/${s.name}`}><b>{s.name}</b></a>
            {s.argumentHint && <code style={{ marginLeft: 6 }}>{s.argumentHint}</code>}
            <div className="sub" style={{ margin: '2px 0 0' }}>{s.description.slice(0, 180)}{s.description.length > 180 ? '…' : ''}</div>
          </div>
        ))}
      </div>

      <h2>Team pack</h2>
      <TeamPack />

      <h2>Agents <a href="#/agents" className="sub">all →</a></h2>
      <div className="card">
        {data.agentsError && <div className="danger">{data.agentsError}</div>}
        {data.agents.map((a) => (
          <div key={a.id} className="list-item row" style={{ justifyContent: 'space-between' }}>
            <span><span className={`chip ${statusChip(a.status)}`}>{a.status}</span> {a.name}</span>
            <span className="status">{a.provider} · {a.created}</span>
          </div>
        ))}
      </div>

      {(rituals.length > 0 || data.rituals.length > 0) && (
        <>
          <h2>Recent rituals</h2>
          <div className="card">
            {data.rituals.length === 0 && <span className="sub">None launched from here yet.</span>}
            {data.rituals.map((r, i) => (
              <div key={i} className="list-item">
                <span className={`chip ${r.ok ? 'c-green' : 'c-red'}`}>{r.kind}</span> {r.title} <span className="status">{r.ts.slice(0, 16).replace('T', ' ')}{r.agentId ? ` · ${r.agentId.slice(0, 8)}` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Recent feedback</h2>
      <div className="card">
        {data.feedback.length === 0 && <span className="sub">None yet.</span>}
        {data.feedback.map((f, i) => (
          <div key={i} className="list-item"><b>{f.title || f.node}</b> <span className="chip c-grey">{f.verdict || 'note'}</span> {f.text} <span className="status">{f.ts}</span></div>
        ))}
      </div>

      <h2>Backlog</h2>
      <div className="card"><Markdown text={data.backlog.replace(/^# .*\n/, '')} /></div>
      <h2>Changelog</h2>
      <div className="card"><Markdown text={data.changelog.replace(/^# .*\n/, '')} /></div>
    </>
  );
}
