import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { ritualFields, useConfig } from '../../config.ts';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import { Empty, ErrorNote, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import { FeedbackForm, FileEditor, FileList, SubTabs, inline } from './parts.tsx';
import type { FeedbackItem, PersonaDetail, PersonaJson, Quote } from '../../types.ts';
import './persona.css';

type PersonaCheck = NonNullable<PersonaJson['checks']>[number];
type Scope = NonNullable<PersonaJson['scope']>[number];

const personName = (p: PersonaDetail) => p.title.replace(/\s+[—-]\s+`[^`]*`\s*$/, '').replace(/ — .*$/, '');

function FbSection({ title, count, node, fbTitle, children }: { title: string; count?: number; node: string; fbTitle: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title={title} count={count} action={<button type="button" className={`dp-btn dp-ghost dp-sm${open ? ' dp-pers-fbon' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="message-square" size={12} />Feedback</button>}>
      {children}
      <div className={`dp-collapse${open ? ' dp-open' : ''}`}><div>{open && <FeedbackForm node={node} title={fbTitle} />}</div></div>
    </Section>
  );
}

const Quotes = ({ q }: { q?: Quote[] }) => (q?.length ? <div className="dp-pers-quotes">{q.map(([t, w], i) => <blockquote key={i} className="dp-pers-quote"><span>{inline(t)}</span><cite>{w}</cite></blockquote>)}</div> : null);
const Bullets = ({ items, ordered = false }: { items?: string[]; ordered?: boolean }) => {
  if (!items?.length) return null;
  const lis = items.map((x, i) => <li key={i}>{inline(x)}</li>);
  return ordered ? <ol className="dp-pers-list dp-pers-ol">{lis}</ol> : <ul className="dp-pers-list">{lis}</ul>;
};
const CONF: Record<string, string> = { high: 'dp-ok', medium: 'dp-warn' };

function ScopeRow({ d }: { d: Scope }) {
  const primary: unknown = d.primary;
  const raw: unknown = d.paths;
  const paths = Array.isArray(raw) ? raw.join(' · ') : d.paths;
  return (
    <div className="dp-rowi dp-pers-scope">
      <span className="dp-rowi-b">
        <span className="dp-row dp-g6 dp-pers-wrap">
          <b>{d.name}</b>
          <span className={`dp-chip ${CONF[d.conf] || ''}`}>{d.conf}</span>
          {Boolean(d.rev) && <span className="dp-chip dp-acc">{d.strong ? 'strong review surface' : 'reviews here'}</span>}
          {primary === true && <span className="dp-chip dp-acc">primary</span>}
        </span>
        <span className="dp-t3 dp-mono dp-pers-paths">{paths}</span>
      </span>
      <span className="dp-pers-touch">
        <span className={`dp-pers-bar${d.strong ? ' dp-pers-strong' : ''}`}><i style={{ width: `${Math.min(100, d.touch)}%` }} /></span>
        <span className="dp-pers-pc">{d.touch}%{typeof primary === 'number' && <span className="dp-t3"> · {primary}% primary</span>}</span>
      </span>
    </div>
  );
}

function CheckRow({ i, c }: { i: number; c: PersonaCheck }) {
  const [open, setOpen] = useState(false);
  const body = (c.quotes?.length ?? 0) > 0 || Boolean(c.rule);
  return (
    <div className={`dp-pers-check${open ? ' dp-on' : ''}`}>
      <button type="button" className="dp-pers-checkh" aria-expanded={open} disabled={!body} onClick={() => setOpen(!open)}>
        <span className="dp-pers-num">{i + 1}</span>
        <span className="dp-grow dp-pers-q">{inline(c.q)}</span>
        {c.block && <span className="dp-chip dp-bad">blocking</span>}
        <span className="dp-chip dp-pers-hits">{c.hits} hit{c.hits === 1 ? '' : 's'}</span>
        {body && <span className="dp-pers-chev"><Icon name="chevron-down" size={14} /></span>}
      </button>
      {body && (
        <div className={`dp-collapse${open ? ' dp-open' : ''}`}>
          <div><div className="dp-pers-checkb"><Quotes q={c.quotes} />{c.rule && <p className="dp-pers-rule"><span className="dp-t3">House rule</span>{inline(c.rule)}</p>}</div></div>
        </div>
      )}
    </div>
  );
}

function Overview({ p }: { p: PersonaDetail }) {
  const P = p.json;
  const l = p.login;
  if (!P) return <div className="dp-box dp-pers-md"><Markdown text={p.md} /></div>;
  const checks = P.checks || [];
  const blocking = checks.filter((c) => c.block).length;
  return (
    <>
      {(P.kpis?.length ?? 0) > 0 && <Tiles items={(P.kpis || []).map((k) => ({ label: k.label, value: k.value, hint: k.note }))} />}
      {P.portrait && <Section title="Portrait"><p className="dp-pers-portrait">{inline(P.portrait)}</p></Section>}
      <FbSection title="Scope" count={P.scope?.length ?? 0} node={`persona:${l}:scope`} fbTitle={`${l} · scope`}>
        {P.scope?.length ? <div className="dp-rows">{P.scope.map((d, i) => <ScopeRow key={i} d={d} />)}</div> : <Empty icon="layers">No scope mined.</Empty>}
        {P.scopeNote && <p className="dp-pers-note">{inline(P.scopeNote)}</p>}
      </FbSection>
      <FbSection title="What they check" count={checks.length} node={`persona:${l}:checks`} fbTitle={`${l} · checks`}>
        {blocking > 0 && <p className="dp-pers-note dp-pers-lead">{blocking} of {checks.length} are blocking. Open a check to see the quotes behind it.</p>}
        {checks.length ? <div className="dp-rows">{checks.map((c, i) => <CheckRow key={i} i={i} c={c} />)}</div> : <Empty icon="check">No checks mined.</Empty>}
      </FbSection>
      <FbSection title="What they let pass" count={P.pass?.length ?? 0} node={`persona:${l}:pass`} fbTitle={`${l} · pass`}>
        {P.pass?.length ? <Bullets items={P.pass} /> : <Empty icon="check">Nothing listed.</Empty>}
      </FbSection>
      <FbSection title="Voice" node={`persona:${l}:voice`} fbTitle={`${l} · voice`}>
        <Bullets items={P.voice} />
        <Quotes q={P.voiceQuotes} />
      </FbSection>
      <FbSection title="How they answer review" node={`persona:${l}:reply`} fbTitle={`${l} · reply`}>
        {P.replyIntro && <p className="dp-pers-portrait">{inline(P.replyIntro)}</p>}
        <Quotes q={P.replyQuotes} />
      </FbSection>
      <FbSection title="Authoring bar" count={P.author?.length ?? 0} node={`persona:${l}:author`} fbTitle={`${l} · author`}>
        <Bullets items={P.author} ordered />
        {P.authorNotes && <p className="dp-pers-portrait">{inline(P.authorNotes)}</p>}
        {(P.commitExamples?.length ?? 0) > 0 && <><div className="dp-pers-sub">Commit examples</div><pre className="dp-pers-pre">{P.commitExamples?.join('\n')}</pre></>}
        {(P.codeExamples?.length ?? 0) > 0 && <><div className="dp-pers-sub">Code examples</div><pre className="dp-pers-pre">{P.codeExamples?.join('\n\n')}</pre></>}
        {P.avoids && <p className="dp-pers-avoid"><span className="dp-chip dp-bad">Avoids</span><span>{inline(P.avoids)}</span></p>}
      </FbSection>
    </>
  );
}

function FeedbackTab({ login, items }: { login: string; items: FeedbackItem[] }) {
  return (
    <>
      <Section title="Feedback sent" count={items.length}>
        {items.length ? (
          <div className="dp-rows">
            {items.map((f, i) => (
              <div key={i} className="dp-rowi">
                <span className="dp-chip">{f.verdict || 'note'}</span>
                <span className="dp-rowi-b"><b className="dp-ell">{f.title || f.node}</b>{f.text && <span className="dp-t2">{f.text}</span>}</span>
                <span className="dp-rowi-m">{f.ts}</span>
              </div>
            ))}
          </div>
        ) : <Empty icon="message-square">No feedback yet.</Empty>}
      </Section>
      <Section title="General feedback"><div className="dp-box dp-fbbox"><FeedbackForm node={`persona:${login}:general`} title={`${login} · general`} /></div></Section>
    </>
  );
}

const TABS = ['overview', 'file', 'edit', 'feedback'];

export default function PersonaPage({ login, tab = 'overview' }: { login: string; tab?: string }) {
  const [p, setP] = useState<PersonaDetail | null>(null);
  const [err, setErr] = useState('');
  const rituals = useConfig((s) => s.rituals);
  const [file, setFile] = useState(`${login}.md`);
  useEffect(() => {
    api.persona(login).then(setP).catch((e) => setErr(errorMessage(e)));
  }, [login]);
  const load = useCallback(() => api.personaFile(login, file), [login, file]);
  const save = useCallback((t: string) => api.savePersonaFile(login, file, t), [login, file]);
  if (!p) return <Page>{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading persona…" />}</Page>;

  const on = TABS.includes(tab) ? tab : 'overview';
  const files = [...p.files.filter((f) => f !== `${login}.json`), ...(p.hasJson ? [`${login}.json`] : [])];
  const personaRituals = rituals.filter((r) => ritualFields(r).includes('login'));
  const writer = p.kind === 'writer';
  return (
    <Page>
      <div className="dp-pers">
        <PageHead
          meta={<><Icon name={writer ? 'mail' : 'eye'} size={12} />{writer ? 'Message-writer persona' : 'Reviewer persona'}<span className="dp-t4">·</span>@{login}</>}
          title={<><img className="dp-pers-av" src={`/api/avatar/${login}`} alt="" />{personName(p)}</>}
          sub={
            <span className="dp-row dp-g6 dp-pers-wrap">
              <span className={`dp-chip${p.stale ? ' dp-bad' : ''}`}><Icon name="clock" size={12} />mined {p.mined}{p.stale ? ' · stale' : ''}</span>
              <span className="dp-chip dp-info">{p.surfaces} surfaces</span>
              <span className="dp-chip dp-acc">{p.checks} checks</span>
              {p.hasSlack && <span className="dp-chip dp-ok">slack</span>}
              {p.calibration > 0 && <span className="dp-chip dp-warn">{p.calibration} calibration{p.calibration === 1 ? '' : 's'}</span>}
            </span>
          }
        />
        <SubTabs
          base={`#/persona/${login}`}
          on={on}
          extra={personaRituals.length > 0 && <><span className="dp-t3 dp-sm">Rituals</span>{personaRituals.map((r) => <a key={r.kind} className="dp-btn dp-ghost dp-sm" href={`#/rituals/${r.kind}/${login}`}><Icon name="sparkles" size={12} />{r.label || r.kind}</a>)}</>}
          tabs={[{ id: 'overview', label: 'Overview' }, { id: 'file', label: 'Persona file' }, { id: 'edit', label: 'Edit' }, { id: 'feedback', label: 'Feedback', count: p.feedback.length }]} />
        {on === 'overview' && <Overview p={p} />}
        {on === 'file' && <div className="dp-box dp-pers-md"><Markdown text={p.md} /></div>}
        {on === 'edit' && (
          <div className="dp-filegrid dp-pers-split">
            <FileList files={files} on={file} pick={setFile} />
            <FileEditor key={file} load={load} save={save} label={file} />
          </div>
        )}
        {on === 'feedback' && <FeedbackTab login={login} items={p.feedback} />}
      </div>
    </Page>
  );
}
