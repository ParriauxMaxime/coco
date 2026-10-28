import React, { useEffect, useState } from 'react';
import { errorMessage, scheduleApi } from '../../api.ts';
import { confirmDialog } from '../../components/Dialogs.tsx';
import { toast } from '../../components/Toast.tsx';
import Markdown from '../../components/Markdown.tsx';
import { useUnsaved } from '../../updates.ts';
import Icon from '../Icon.tsx';
import { ModelControls, modelOf, useModelCatalog, useModelChoice } from '../chat/ModelPicker.tsx';
import { ago, stamp } from '../format.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import { dailyCron, dailyOf, describeCadence, fillTemplate } from '../../../server/schedule-view.ts';
import type { Cadence, ScheduleInput, ScheduleProject, ScheduleRun, ScheduleView, SchedulesResponse } from '../../../server/schedule-view.ts';
import './schedules.css';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_CHOICES: [string, string][] = [['*', 'Every day'], ['1-5', 'Weekdays'], ['0,6', 'Weekends'], ['1', 'Mondays'], ['2', 'Tuesdays'], ['3', 'Wednesdays'], ['4', 'Thursdays'], ['5', 'Fridays'], ['6', 'Saturdays'], ['0', 'Sundays']];
const UNITS: [string, number][] = [['minutes', 60000], ['hours', 3600000], ['days', 86400000]];
const OTHER = '\0other';

const since = (ts: string | null) => {
  const a = ago(ts ?? undefined);
  return !a ? '' : a === 'now' ? 'just now' : /\d (min|h|d)$/.test(a) ? `${a} ago` : `on ${a}`;
};
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
const titleOf = (s: ScheduleView) => s.name || s.prompt.split('\n')[0].slice(0, 80);
const until = (ts: string | null) => {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return '';
  const m = Math.round((t - Date.now()) / 60000);
  return m < 1 ? 'any moment' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`;
};
const took = (r: ScheduleRun) => {
  if (!r.endedAt) return '';
  const s = Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const runDot = (r: ScheduleRun) => (r.status === 'running' ? 'dp-ag-running' : r.status === 'succeeded' ? 'dp-ag-done' : 'dp-ag-failed');
const agentLink = (id: string | null) => id && <a className="dp-btn dp-sm" href={`#/agents/${encodeURIComponent(id)}`} title="The agent this run started: its transcript and a composer"><Icon name="bot" size={12} />Agent</a>;

// #/schedules: Paseo's schedules; #/schedules/new[?ritual=<kind>&<field>=…] and #/schedules/<id>/edit open the form, #/schedules/<id> its logs
export default function SchedulesPage({ id, edit, query = '' }: { id?: string; edit?: boolean; query?: string }) {
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(id && id !== 'new' && !edit ? id : null);
  useEffect(() => { if (id && id !== 'new' && !edit) setOpen(id); }, [id, edit]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => scheduleApi.list().then((d) => { setData(d); setErr(''); }, (e) => setErr(errorMessage(e)));
  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === 'visible' && void load(), 30000);
    return () => clearInterval(timer);
  }, []);

  const creating = id === 'new';
  const editing = edit && data ? data.schedules.find((s) => s.id === id) ?? null : null;
  const formOpen = creating || Boolean(editing);
  const closeForm = () => { location.hash = '#/schedules'; };

  const act = async (s: ScheduleView, action: 'pause' | 'resume' | 'run-once') => {
    if (action === 'run-once') {
      const where = s.target.type === 'agent' ? `to agent ${s.target.agentId.slice(0, 8)}` : `in a new agent (${s.project?.name ?? s.target.cwd})`;
      if (!(await confirmDialog({ title: `Run “${titleOf(s)}” now?`, body: `Paseo runs its prompt once now, ${where}. Its cadence stays as it is.`, ok: 'Run now' }))) return;
    }
    setBusy(s.id);
    try {
      await scheduleApi.act(s.id, action);
      toast.success(action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Run started');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: ScheduleView) => {
    if (!(await confirmDialog({ title: `Delete “${titleOf(s)}”?`, body: 'Paseo forgets the schedule and its run logs; the agents its runs started stay. This cannot be undone.', ok: 'Delete', danger: true }))) return;
    setBusy(s.id);
    try {
      await scheduleApi.remove(s.id);
      toast.success('Schedule deleted');
      await load();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const list = data?.schedules ?? [];
  const order = { active: 0, paused: 1, completed: 2 };
  const sorted = [...list].sort((a, b) => order[a.status] - order[b.status] || (a.nextRunAt ?? '~').localeCompare(b.nextRunAt ?? '~'));
  return (
    <Page>
      <PageHead
        icon="calendar"
        title="Schedules"
        sub={<>Recurring agent runs kept by Paseo's daemon, the ones its app lists: on each tick a fresh agent gets the prompt, even with coco closed. A one-off launch by hand is a <a href="#/rituals">ritual</a>.</>}
        actions={<>
          <button className="dp-btn dp-sm" type="button" onClick={() => void load()} title="Read the schedules again"><Icon name="refresh" size={12} />Refresh</button>
          {!formOpen && <a className="dp-btn dp-sm dp-primary" href="#/schedules/new"><Icon name="plus" size={12} />New schedule</a>}
        </>}
      />
      {err && <ErrorNote>{err}</ErrorNote>}
      {formOpen && data && <ScheduleForm key={editing?.id ?? `new?${query}`} schedule={editing} data={data} query={creating ? new URLSearchParams(query) : undefined} onDone={() => { closeForm(); void load(); }} onCancel={closeForm} />}
      {edit && data && !editing && <ErrorNote>No schedule {id}: it may have been deleted.</ErrorNote>}
      <Section title="Schedules" count={data ? list.length : undefined} meta={data ? `${list.filter((s) => s.status === 'active').length} active` : undefined}>
        {!data && !err ? <Loading what="Reading Paseo's schedules…" /> : !list.length ? (
          <Empty icon="calendar">No schedule yet. <a href="#/schedules/new">New schedule</a> runs a prompt on a cadence.</Empty>
        ) : (
          <div className="dp-rows">
            {sorted.map((s) => <ScheduleRow key={s.id} s={s} open={open === s.id} busy={busy === s.id} onToggle={() => setOpen(open === s.id ? null : s.id)} onAct={(a) => void act(s, a)} onDelete={() => void remove(s)} />)}
          </div>
        )}
      </Section>
    </Page>
  );
}

function ScheduleRow({ s, open, busy, onToggle, onAct, onDelete }: { s: ScheduleView; open: boolean; busy: boolean; onToggle: () => void; onAct: (a: 'pause' | 'resume' | 'run-once') => void; onDelete: () => void }) {
  const { catalog } = useModelCatalog();
  const t = s.target;
  const model = t.type === 'new-agent' && t.model ? modelOf(catalog, `${t.provider}/${t.model}`) : null;
  const last = s.lastRun;
  const when = s.status === 'active' ? (s.nextRunAt ? `next ${until(s.nextRunAt)} · ${stamp(s.nextRunAt)}` : 'no next run') : s.status === 'paused' ? `paused${s.pausedAt ? ` ${since(s.pausedAt)}` : ''}` : 'completed';
  return (
    <div className={`dp-sch${open ? ' dp-on' : ''}`}>
      <div className="dp-rowi dp-sch-row">
        <span className={`dp-chip dp-sch-st ${s.status === 'active' ? 'dp-ok' : s.status === 'paused' ? 'dp-warn' : ''}`}><span className="dp-d" />{s.status}</span>
        <button type="button" className="dp-sch-main" onClick={onToggle} aria-expanded={open} title={open ? 'Hide its prompt and runs' : 'Show its prompt and runs'}>
          <span className="dp-ell dp-sch-name">{titleOf(s)}</span>
          <span className="dp-sch-meta">
            <span title={s.cadence.type === 'cron' ? `cron ${s.cadence.expression}` : undefined}><Icon name="clock" size={12} />{describeCadence(s.cadence, s.maxRuns)}</span>
            <span className="dp-t3">{when}</span>
          </span>
          <span className="dp-sch-meta">
            {t.type === 'new-agent' ? (
              <>
                <span className="dp-chip" title={[`provider ${t.provider}`, t.model && `model ${t.model}`, t.thinking && `thinking ${t.thinking}`, t.mode && `mode ${t.mode}`].filter(Boolean).join(' · ')}><Icon name="sparkles" size={12} />{t.provider}{t.model ? ` · ${model?.label ?? t.model}` : ''}</span>
                <span className="dp-chip" title={t.cwd}><Icon name="folder" size={12} />{s.project ? (s.project.path === t.cwd ? s.project.name : `${s.project.name}/${t.cwd.slice(s.project.path.length + 1)}`) : tilde(t.cwd)}</span>
                {t.isolation === 'worktree' && <span className="dp-chip" title="Each run starts in a new worktree"><Icon name="git-branch" size={12} />worktree</span>}
              </>
            ) : <span className="dp-chip" title={t.agentId}><Icon name="bot" size={12} />to agent {t.agentId.slice(0, 8)}</span>}
            {last ? (
              <span className="dp-sch-last" title={last.error ?? undefined}><span className={`dp-ag-dot ${runDot(last)}`} />last run {last.status === 'running' ? 'running' : `${last.status} ${since(last.startedAt)}`}</span>
            ) : <span className="dp-t3">never ran</span>}
          </span>
        </button>
        <span className="dp-sch-acts">
          {last?.agentId && agentLink(last.agentId)}
          {s.status === 'active' && <button className="dp-btn dp-sm" type="button" disabled={busy} onClick={() => onAct('pause')} title="Stop its runs until resumed"><Icon name="pause" size={12} />Pause</button>}
          {s.status === 'paused' && <button className="dp-btn dp-sm" type="button" disabled={busy} onClick={() => onAct('resume')} title="Run it on its cadence again"><Icon name="play" size={12} />Resume</button>}
          <button className="dp-btn dp-sm" type="button" disabled={busy} onClick={() => onAct('run-once')} title="One run now, its cadence untouched"><Icon name="send" size={12} />Run once</button>
          <a className="dp-ibtn" href={`#/schedules/${encodeURIComponent(s.id)}/edit`} title="Edit"><Icon name="pencil" size={14} /></a>
          <button className="dp-ibtn dp-sch-del" type="button" disabled={busy} onClick={onDelete} title="Delete"><Icon name="trash" size={14} /></button>
        </span>
      </div>
      {open && <ScheduleDetail s={s} />}
    </div>
  );
}

// its prompt and its runs, newest first, each with its agent
function ScheduleDetail({ s }: { s: ScheduleView }) {
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    scheduleApi.logs(s.id).then((r) => setRuns(r.runs), (e) => setErr(errorMessage(e)));
  }, [s.id, s.lastRun?.id, s.lastRun?.status]);
  return (
    <div className="dp-sch-detail">
      <div className="dp-sch-sec">
        <div className="dp-sec-t">Prompt</div>
        <pre className="dp-sch-prompt">{s.prompt}</pre>
        <div className="dp-xs dp-t3">Created {stamp(s.createdAt)}{s.maxRuns ? ` · at most ${s.maxRuns} runs` : ''}{s.expiresAt ? ` · ends ${stamp(s.expiresAt)}` : ''} · id {s.id}</div>
      </div>
      <div className="dp-sch-sec">
        <div className="dp-sec-t">Runs{runs ? ` · ${runs.length}` : ''}</div>
        {err ? <ErrorNote>{err}</ErrorNote> : !runs ? <Loading what="Reading its logs…" /> : !runs.length ? <Empty icon="history">No run yet.</Empty> : (
          <div className="dp-rows">
            {runs.map((r) => (
              <details key={r.id} className="dp-sch-run">
                <summary className="dp-rowi">
                  <span className={`dp-ag-dot ${runDot(r)}`} title={r.status} />
                  <span className="dp-rowi-b"><span className="dp-ell">{r.status === 'running' ? 'Running' : r.status === 'succeeded' ? 'Succeeded' : 'Failed'} · {stamp(r.startedAt)}{took(r) ? ` · ${took(r)}` : ''}</span>{(r.error || r.output) && <span className="dp-t3 dp-ell">{(r.error || r.output || '').split('\n').find((l) => l.trim())}</span>}</span>
                  <span className="dp-rowi-m">{agentLink(r.agentId)}</span>
                </summary>
                <div className="dp-sch-out">{r.error ? <ErrorNote>{r.error}</ErrorNote> : r.output ? <Markdown text={r.output} /> : <span className="dp-t3">No output.</span>}</div>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Kind = 'daily' | 'interval' | 'cron';
function cadenceState(c: Cadence | null) {
  const daily = c ? dailyOf(c) : { time: '09:00', days: '1-5' };
  const unit = c?.type === 'every' ? [...UNITS].reverse().find(([, ms]) => c.everyMs % ms === 0) ?? UNITS[0] : UNITS[1];
  return {
    kind: (daily ? 'daily' : c?.type === 'every' ? 'interval' : 'cron') as Kind,
    time: daily?.time ?? '09:00',
    days: daily?.days ?? '*',
    every: c?.type === 'every' ? String(c.everyMs / unit[1]) : '1',
    unit: unit[0],
    expr: c?.type === 'cron' ? c.expression : '0 9 * * 1-5',
    tz: c?.type === 'cron' ? c.timezone ?? 'UTC' : LOCAL_TZ,
  };
}

// a schedule to make or edit: a ritual's prompt can seed a new one (#/schedules/new?ritual=<kind>&login=…)
function ScheduleForm({ schedule, data, query, onDone, onCancel }: { schedule: ScheduleView | null; data: SchedulesResponse; query?: URLSearchParams; onDone: () => void; onCancel: () => void }) {
  const t = schedule?.target;
  const seed = data.rituals.find((r) => r.kind === query?.get('ritual'));
  const vars = Object.fromEntries(query?.entries() ?? []);
  const [name, setName] = useState(schedule?.name ?? (seed ? fillTemplate(seed.title, vars, true) : ''));
  const [prompt, setPrompt] = useState(schedule?.prompt ?? (seed ? fillTemplate(seed.prompt, vars, true) : ''));
  const [cad, setCad] = useState(() => cadenceState(schedule?.cadence ?? null));
  const set = (patch: Partial<typeof cad>) => setCad({ ...cad, ...patch });
  const current = t?.type === 'new-agent' && t.model ? { provider: `${t.provider}/${t.model}`, thinking: t.thinking } : null;
  const model = useModelChoice('schedule', schedule ? { live: true, current } : {});
  const { catalog } = useModelCatalog();
  const [mode, setMode] = useState<string | null>(t?.type === 'new-agent' ? t.mode : null);
  const fam = model.choice?.provider.split('/')[0];
  const modes = catalog?.providers.find((p) => p.id === fam)?.modes ?? [];
  useEffect(() => { if (mode && modes.length && !modes.some((m) => m.id === mode)) setMode(null); }, [fam, modes.length]);
  const projects: ScheduleProject[] = data.projects;
  const [cwd, setCwd] = useState(t?.type === 'new-agent' ? t.cwd : projects[0]?.path ?? '');
  const [other, setOther] = useState(Boolean(cwd) && !projects.some((p) => p.path === cwd));
  const [worktree, setWorktree] = useState(t?.type === 'new-agent' && t.isolation === 'worktree');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  useUnsaved(!schedule && Boolean(prompt.trim()));

  const cadence: Cadence = cad.kind === 'daily' ? { type: 'cron', expression: dailyCron(cad), timezone: cad.tz.trim() || undefined }
    : cad.kind === 'interval' ? { type: 'every', everyMs: Math.round(Number(cad.every) * (UNITS.find(([u]) => u === cad.unit)?.[1] ?? 60000)) }
    : { type: 'cron', expression: cad.expr, timezone: cad.tz.trim() || undefined };
  const unfilled = [...new Set(prompt.match(/\{[\w|]+\}/g) ?? [])];
  const toAgent = t?.type === 'agent';
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setSaving(true);
    const input: ScheduleInput = { name: name.trim() || null, prompt, cadence, ...(toAgent ? {} : { provider: model.choice?.provider, thinking: model.choice?.thinking ?? null, mode, cwd, isolation: worktree ? 'worktree' : 'local' }) };
    try {
      if (schedule) await scheduleApi.update(schedule.id, input);
      else await scheduleApi.create(input);
      toast.success(schedule ? 'Schedule saved' : 'Schedule created');
      onDone();
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setSaving(false);
    }
  };
  const pickRitual = (kind: string) => {
    const r = data.rituals.find((x) => x.kind === kind);
    if (!r) return;
    setPrompt(r.prompt);
    if (!name.trim()) setName(r.title);
  };

  return (
    <form className="dp-box dp-sch-form" onSubmit={(e) => void save(e)}>
      <div className="dp-sch-fh"><Icon name="calendar" size={14} /><b className="dp-grow">{schedule ? `Edit ${titleOf(schedule)}` : 'New schedule'}</b>{schedule && <span className="dp-chip">{schedule.id}</span>}</div>
      <div className="dp-sch-fields">
        <div className="dp-sch-two">
          <label className="dp-rit-f"><span>Name</span><input className="dp-inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly dependency check" maxLength={120} /></label>
          {!schedule && data.rituals.length > 0 && (
            <label className="dp-rit-f"><span>Start from a ritual</span>
              <select className="dp-inp" value={seed?.kind ?? ''} onChange={(e) => pickRitual(e.target.value)}>
                <option value="">—</option>
                {data.rituals.map((r) => <option key={r.kind} value={r.kind}>{r.label}</option>)}
              </select>
            </label>
          )}
        </div>
        <label className="dp-rit-f"><span>Prompt</span><textarea className="dp-inp dp-rit-ta" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What each run's agent should do, on its own: no one answers its questions" required /></label>
        {unfilled.length > 0 && <div className="dp-xs dp-sch-warn"><Icon name="alert-triangle" size={12} />Replace {unfilled.join(', ')} in the prompt: a schedule's runs fill nothing in.</div>}
        <div className="dp-rit-f">
          <span>Cadence</span>
          <div className="dp-row dp-g8 dp-sch-cad">
            <span className="dp-seg" role="tablist">
              {(['daily', 'interval', 'cron'] as Kind[]).map((k) => <button key={k} type="button" role="tab" aria-selected={cad.kind === k} className={cad.kind === k ? 'dp-on' : ''} onClick={() => set({ kind: k })}>{k === 'daily' ? 'At a time' : k === 'interval' ? 'Every' : 'Cron'}</button>)}
            </span>
            {cad.kind === 'daily' && <>
              <select className="dp-inp" value={cad.days} onChange={(e) => set({ days: e.target.value })} aria-label="Days">{DAY_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              <input className="dp-inp" type="time" value={cad.time} onChange={(e) => set({ time: e.target.value })} aria-label="Time" required />
            </>}
            {cad.kind === 'interval' && <>
              <input className="dp-inp dp-sch-num" type="number" min={1} step={1} value={cad.every} onChange={(e) => set({ every: e.target.value })} aria-label="How many" required />
              <select className="dp-inp" value={cad.unit} onChange={(e) => set({ unit: e.target.value })} aria-label="Unit">{UNITS.map(([u]) => <option key={u} value={u}>{u}</option>)}</select>
            </>}
            {cad.kind === 'cron' && <input className="dp-inp dp-sch-cron" value={cad.expr} onChange={(e) => set({ expr: e.target.value })} placeholder="0 9 * * 1-5" aria-label="Cron expression" spellCheck={false} required />}
            {cad.kind !== 'interval' && <input className="dp-inp dp-sch-tz" value={cad.tz} onChange={(e) => set({ tz: e.target.value })} placeholder="UTC" aria-label="Time zone" title="IANA time zone, e.g. Europe/Paris" spellCheck={false} />}
          </div>
          <span className="dp-xs dp-t3">{cad.kind === 'cron' ? 'minute hour day-of-month month day-of-week (0 is Sunday): numbers, *, ranges, lists, steps · ' : ''}Runs {describeCadence(cadence, schedule?.maxRuns)}</span>
        </div>
        {toAgent ? (
          <div className="dp-xs dp-t3">Each run sends the prompt to agent <a href={`#/agents/${encodeURIComponent(t.agentId)}`}>{t.agentId.slice(0, 8)}</a>; its model and folder are that agent's.</div>
        ) : (
          <>
            <div className="dp-rit-f">
              <span>Agent</span>
              <div className="dp-row dp-g8"><ModelControls choice={model.choice} onPick={model.pick} hint="for each run's new agent" mode={{ value: mode, onPick: setMode }} />{fam && <span className="dp-chip" title="Paseo provider: its own login and quota">{catalog?.providers.find((p) => p.id === fam)?.label || fam}</span>}</div>
            </div>
            <div className="dp-sch-two">
              <label className="dp-rit-f"><span>Runs in</span>
                <select className="dp-inp" value={other ? OTHER : cwd} onChange={(e) => { const v = e.target.value; setOther(v === OTHER); if (v !== OTHER) setCwd(v); }}>
                  {projects.map((p) => <option key={p.path} value={p.path}>{p.name} · {tilde(p.path)}</option>)}
                  <option value={OTHER}>Another folder…</option>
                </select>
              </label>
              {other && <label className="dp-rit-f"><span>Folder</span><input className="dp-inp" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~/Projects/app" spellCheck={false} required /></label>}
            </div>
            <label className="dp-row dp-g6 dp-sm dp-sch-check"><input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />Each run in a new worktree of that folder's repo</label>
          </>
        )}
      </div>
      <div className="dp-rit-ff">
        <button className="dp-btn dp-primary" type="submit" disabled={saving || !prompt.trim() || (!toAgent && (!model.choice || !cwd.trim()))}><Icon name="check" size={14} />{schedule ? 'Save' : 'Create'}</button>
        <button className="dp-btn" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        {!schedule && <span className="dp-xs dp-t3 dp-ell">Its first run comes at its next tick; Run once fires one now.</span>}
      </div>
      {err && <div className="dp-rit-err"><ErrorNote>{err}</ErrorNote></div>}
    </form>
  );
}
