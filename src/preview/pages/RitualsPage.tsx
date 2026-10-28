import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { ritualFields, useConfig } from '../../config.ts';
import Icon from '../Icon.tsx';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import type { Persona, RitualRun } from '../../types.ts';
import './rituals.css';

const stamp = (ts: string) => ts.slice(0, 16).replace('T', ' ');
type Status = { tone: 'busy' | 'ok' | 'bad'; text: string } | null;

export default function RitualsPage({ preset }: { preset?: string }) {
  const rituals = useConfig((s) => s.rituals);
  const model = useConfig((s) => s.models.default);
  const loaded = useConfig((s) => s.loaded);
  const [picked, setKind] = useState(preset?.split('/')[0] || '');
  const [form, setForm] = useState<Record<string, string>>({ login: preset?.split('/')[1] || '', pr: '', paths: '', text: '' });
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [history, setHistory] = useState<RitualRun[]>([]);
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    api.personas().then(setPersonas, () => {});
    api.rituals().then((r) => setHistory(r.history), () => {});
  }, []);
  const spec = rituals.find((r) => r.kind === picked) || rituals[0];
  const kind = spec?.kind;
  const fields = spec ? ritualFields(spec) : [];
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const busy = status?.tone === 'busy';
  const launch = async () => {
    setStatus({ tone: 'busy', text: 'Launching a Paseo agent…' });
    try {
      const r = await api.launch({ kind, ...form });
      setStatus(r.ok ? { tone: 'ok', text: `Launched ${r.agentId ? r.agentId.slice(0, 8) : ''} — ${r.title}` } : { tone: 'bad', text: `Failed: ${'error' in r ? r.error : r.out}` });
      if ('ts' in r) setHistory((h) => [r, ...h]);
    } catch (e) {
      setStatus({ tone: 'bad', text: `Failed: ${errorMessage(e)}` });
    }
  };
  const ready = fields.every((f) => (f === 'paths' && form.login) || (f === 'login' && fields.includes('paths') && form.paths) || form[f]);

  return (
    <Page>
      <PageHead
        icon="sparkles"
        title="Rituals"
        sub={<>Each ritual starts a fresh Paseo agent in your repo (<span className="dp-t1">{model || 'default model'}</span>, auto mode) with its prompt or skill. You press the button; agents never push, post or send.</>}
      />
      {!loaded ? <Section title="Launch"><Loading what="Loading rituals…" /></Section> : !spec ? (
        <Section title="Launch">
          <Empty icon="sparkles">No ritual configured. Add a <code>rituals</code> list to <code>coco.config.json</code>: <code>{'{ "kind": "review-as", "label": "Review a PR as a persona", "prompt": "/review-as {login} {pr}" }'}</code></Empty>
        </Section>
      ) : (
        <Section title="Launch" count={rituals.length}>
          <div className="dp-rit-grid">
            <div className="dp-rows dp-rit-list" role="tablist">
              {rituals.map((r) => (
                <button key={r.kind} type="button" role="tab" aria-selected={kind === r.kind} className={`dp-rit-item${kind === r.kind ? ' dp-on' : ''}`} onClick={() => { setKind(r.kind); setStatus(null); }}>
                  <Icon name="play" size={12} />
                  <span className="dp-rowi-b"><span className="dp-ell">{r.label || r.kind}</span><span className="dp-t3 dp-ell">{r.prompt || r.kind}</span></span>
                </button>
              ))}
            </div>
            <form className="dp-box dp-rit-form" onSubmit={(e) => { e.preventDefault(); void launch(); }}>
              <div className="dp-rit-fh">
                <div className="dp-row dp-g8"><b className="dp-grow dp-ell">{spec.label || spec.kind}</b><span className="dp-chip">{spec.kind}</span></div>
                {spec.hint && <p className="dp-t2">{spec.hint}</p>}
                {spec.prompt && <code className="dp-rit-cmd">{spec.prompt}</code>}
              </div>
              <div className="dp-rit-fields">
                {fields.includes('login') && (
                  <div className="dp-rit-f">
                    <label className="dp-rit-f"><span>Persona login</span><input className="dp-inp" list="dp-rit-logins" value={form.login} onChange={set('login')} placeholder="alice" /></label>
                    <datalist id="dp-rit-logins">{personas.map((p) => <option key={p.login} value={p.login} />)}</datalist>
                    {personas.length > 0 && (
                      <span className="dp-rit-people">
                        {personas.map((p) => (
                          <button key={p.login} type="button" className={`dp-rit-person${form.login === p.login ? ' dp-on' : ''}`} title={p.title} onClick={() => setForm({ ...form, login: form.login === p.login ? '' : p.login })}>
                            <img src={`/api/avatar/${p.login}`} alt="" loading="lazy" />{p.login}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                )}
                {fields.includes('pr') && <label className="dp-rit-f"><span>PR number</span><input className="dp-inp" value={form.pr} onChange={set('pr')} placeholder="1234" inputMode="numeric" /></label>}
                {fields.includes('paths') && <label className="dp-rit-f"><span>Paths or PR to find the owner of</span><input className="dp-inp" value={form.paths} onChange={set('paths')} placeholder="src/billing/invoices" /></label>}
                {fields.includes('text') && <label className="dp-rit-f"><span>Situation and recipient</span><textarea className="dp-inp dp-rit-ta" rows={3} value={form.text} onChange={set('text')} placeholder="review ping to Alice on #1234, focus on the invoice rounding fix" /></label>}
              </div>
              <div className="dp-rit-ff">
                <button className="dp-btn dp-primary" type="submit" disabled={!ready || busy}><Icon name="play" size={14} />Launch</button>
                {status && status.tone !== 'bad' && <span className={`dp-row dp-g6 dp-sm dp-ell ${status.tone === 'ok' ? 'dp-rit-ok' : 'dp-t3'}`}>{status.tone === 'busy' ? <span className="dp-ag-dot dp-ag-running" /> : <Icon name="check" size={12} />}<span className="dp-ell">{status.text}</span></span>}
              </div>
              {status?.tone === 'bad' && <div className="dp-rit-err"><ErrorNote>{status.text}</ErrorNote></div>}
            </form>
          </div>
        </Section>
      )}
      <Section title="History" count={history.length}>
        {history.length ? (
          <div className="dp-rows">
            {history.map((r, i) => (
              <div key={i} className="dp-rowi dp-rit-run">
                <span className={`dp-ag-dot ${r.ok ? 'dp-ag-done' : 'dp-ag-failed'}`} title={r.ok ? 'launched' : 'failed'} />
                <span className="dp-chip">{r.kind}</span>
                <span className="dp-rowi-b"><span className="dp-ell">{r.title}</span>{r.prompt && <code className="dp-rit-pr dp-ell" title={r.prompt}>{r.prompt}</code>}</span>
                <span className="dp-rowi-m">{stamp(r.ts)}{r.agentId ? ` · ${r.agentId.slice(0, 8)}` : ''}</span>
                {r.agentId && <a className="dp-btn dp-sm" href={`#/agents/${encodeURIComponent(r.agentId)}`} title="Its transcript, cards and a composer to message it"><Icon name="message-square" size={12} />Chat</a>}
              </div>
            ))}
          </div>
        ) : <Empty icon="history">Nothing launched from here yet.</Empty>}
      </Section>
    </Page>
  );
}
