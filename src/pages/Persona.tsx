import React, { useCallback, useEffect, useState } from 'react';
import { PersonaChip } from '../components/PersonaChip.tsx';
import { api, errorMessage } from '../api.ts';
import type { PersonaDetail, PersonaJson, Quote } from '../types.ts';
import { ritualFields, useConfig } from '../config.ts';
import Markdown from '../components/Markdown.tsx';
import Editor from '../components/Editor.tsx';
import Feedback from '../components/Feedback.tsx';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

type PersonaCheck = NonNullable<PersonaJson['checks']>[number];

function Overview({ p }: { p: PersonaDetail }) {
  const P = p.json;
  if (!P) return <div className="card"><Markdown text={p.md} /></div>;
  const quotes = (a?: Quote[]) => (a || []).map(([q, w], i) => <blockquote key={i}>{q} <small style={{ color: 'var(--mute)' }}>— {w}</small></blockquote>);
  return (
    <>
      <div className="card kpis">
        {(P.kpis || []).map((k, i) => (
          <div key={i} className="kpi"><div className="label">{k.label}</div><div className="value">{k.value}</div>{k.note && <div className="label">{k.note}</div>}</div>
        ))}
      </div>
      <div className="card"><b>Portrait.</b> {P.portrait}</div>
      <h2>Scope</h2>
      <div className="card">
        {(P.scope || []).map((d, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            <b>{d.name}</b> <span className={`chip c-${d.conf === 'high' ? 'green' : d.conf === 'medium' ? 'orange' : 'grey'}`}>{d.conf}</span>
            {d.rev && <span className="chip c-purple">{d.strong ? 'strong review surface' : 'reviews here'}</span>}
            <div className="sub" style={{ margin: 0 }}>{d.paths}</div>
            <div className={`bar ${d.strong ? 'rev' : ''}`}><i style={{ width: `${d.touch}%` }} /></div>
            <span className="status">{d.touch}%{d.primary != null ? ` · ${d.primary}% primary` : ''}</span>
          </div>
        ))}
        {P.scopeNote && <p className="sub">{P.scopeNote}</p>}
        <Feedback node={`persona:${p.login}:scope`} title={`${p.login} · scope`} />
      </div>
      <h2>What they check</h2>
      {(P.checks || []).map((c, i) => <Check key={i} i={i} c={c} />)}
      <div className="card"><Feedback node={`persona:${p.login}:checks`} title={`${p.login} · checks`} /></div>
      <h2>What they let pass</h2>
      <div className="card"><ul>{(P.pass || []).map((x, i) => <li key={i}>{x}</li>)}</ul><Feedback node={`persona:${p.login}:pass`} title={`${p.login} · pass`} /></div>
      <h2>Voice</h2>
      <div className="card"><ul>{(P.voice || []).map((x, i) => <li key={i}>{x}</li>)}</ul>{quotes(P.voiceQuotes)}<Feedback node={`persona:${p.login}:voice`} title={`${p.login} · voice`} /></div>
      <h2>How they answer review</h2>
      <div className="card"><p>{P.replyIntro}</p>{quotes(P.replyQuotes)}<Feedback node={`persona:${p.login}:reply`} title={`${p.login} · reply`} /></div>
      <h2>Authoring bar</h2>
      <div className="card">
        <ol>{(P.author || []).map((x, i) => <li key={i}>{x}</li>)}</ol>
        {P.authorNotes && <p>{P.authorNotes}</p>}
        {P.commitExamples && <pre>{P.commitExamples.join('\n')}</pre>}
        {P.codeExamples && <pre>{P.codeExamples.join('\n\n')}</pre>}
        {P.avoids && <p><b>Avoids:</b> {P.avoids}</p>}
        <Feedback node={`persona:${p.login}:author`} title={`${p.login} · author`} />
      </div>
    </>
  );
}

function Check({ i, c }: { i: number; c: PersonaCheck }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`item ${open ? 'open' : ''}`}>
      <div className="top" onClick={() => setOpen(!open)}>
        <b>{i + 1}. {c.q}</b>
        <span className={`chip ${c.block ? 'c-red' : 'c-purple'}`}>{c.hits} hit{c.hits > 1 ? 's' : ''}{c.block ? ' · blocking' : ''}</span>
      </div>
      <div className="body">
        {(c.quotes || []).map(([q, w], j) => <blockquote key={j}>{q} <small style={{ color: 'var(--mute)' }}>— {w}</small></blockquote>)}
        {c.rule && <p className="sub">House rule: {c.rule}</p>}
      </div>
    </div>
  );
}

export default function Persona({ login, tab = 'overview' }: { login: string; tab?: string }) {
  const [p, setP] = useState<PersonaDetail | null>(null);
  const [err, setErr] = useState('');
  const rituals = useConfig((s) => s.rituals);
  const [file, setFile] = useState(`${login}.md`);
  useEffect(() => {
    api.persona(login).then(setP).catch((e) => setErr(errorMessage(e)));
  }, [login]);
  const load = useCallback(() => api.personaFile(login, file), [login, file]);
  const save = useCallback((t: string) => api.savePersonaFile(login, file, t), [login, file]);
  if (err) return <div className="card danger">{err}</div>;
  if (!p) return <div className="sub">Loading…</div>;
  const tabs = [['overview', 'Overview'], ['file', 'Persona file'], ['edit', 'Edit'], ['feedback', `Feedback (${p.feedback.length})`]];
  return (
    <>
      <h1 className="row"><img className="ava lg" src={`/api/avatar/${login}`} alt="" />{p.title}</h1>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`chip ${p.stale ? 'c-red' : 'c-grey'}`}>mined {p.mined}</span>
        <span className="chip c-blue">{p.surfaces} surfaces</span>
        <span className="chip c-purple">{p.checks} checks</span>
        {p.hasSlack && <span className="chip c-green">slack</span>}
        {rituals.filter((r) => ritualFields(r).includes('login')).map((r) => <a key={r.kind} href={`#/rituals/${r.kind}/${login}`}><button>{r.label || r.kind}</button></a>)}
      </div>
      <div className="tabs">
        {tabs.map(([t, l]) => <a key={t} href={`#/persona/${login}/${t}`}><button className={tab === t ? 'on' : ''}>{l}</button></a>)}
      </div>
      {tab === 'overview' && <Overview p={p} />}
      {tab === 'file' && <div className="card"><Markdown text={p.md} /></div>}
      {tab === 'edit' && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <select value={file} onChange={(e) => setFile(e.target.value)}>
              {p.files.map((f) => <option key={f}>{f}</option>)}
              {p.hasJson && <option>{`${login}.json`}</option>}
            </select>
          </div>
          <Editor key={file} load={load} save={save} label={file} />
        </div>
      )}
      {tab === 'feedback' && (
        <div className="card">
          {p.feedback.length === 0 && <span className="sub">No feedback yet.</span>}
          {p.feedback.map((f, i) => <div key={i} className="list-item"><b>{f.title}</b> <span className="chip c-grey">{f.verdict || 'note'}</span> {f.text} <span className="status">{f.ts}</span></div>)}
          <Feedback node={`persona:${login}:general`} title={`${login} · general`} />
        </div>
      )}
    </>
  );
}
