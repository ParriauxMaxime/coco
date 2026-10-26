import React from 'react';
import Markdown from '../../components/Markdown.tsx';
import TeamPack from '../../components/TeamPack.tsx';
import Onboarding from '../../components/Onboarding.tsx';
import { usePendingPermissions } from '../../components/PermissionCard.tsx';
import { ritualFields, useConfig } from '../../config.ts';
import Icon from '../Icon.tsx';
import { SegBar, workDot } from '../Shell.tsx';
import { workHref } from '../prefs.ts';
import { useOverview } from '../overview.ts';
import { Empty, ErrorNote, Legacy, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import type { Persona, WorkSummary } from '../../types.ts';
import './dashboard.css';

const firstName = (p: Persona) => p.title.replace(/ — .*$/, '');
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const AGENT_TONE: Record<string, string> = { running: 'dp-ag-running', idle: 'dp-ag-done', error: 'dp-ag-failed' };

function WorkCard({ w, repo }: { w: WorkSummary; repo?: string }) {
  const p = w.progress;
  const open = p.ready + p.draft;
  return (
    <a className="dp-card dp-dash-work" href={workHref(w.slug)}>
      <span className="dp-card-t"><span className={`dp-dot dp-lg ${workDot(w)}`} /><span className="dp-ell dp-grow">{w.title}</span>{p.restack && <span className="dp-chip dp-warn">restack</span>}</span>
      <span className="dp-work-bar"><SegBar w={w} thin={false} /><span className="dp-pc">{p.merged}/{w.stack - p.closed}</span></span>
      <span className="dp-card-s">
        {repo && <><Icon name="git-branch" size={12} />{repo}<span className="dp-t4">·</span></>}
        {open > 0 ? `${open} open` : w.stack ? `${p.planned} planned` : 'no PR yet'}
        {p.attention && <><span className="dp-t4">·</span><span className="dp-dash-attn">needs attention</span></>}
        <span className="dp-sp" />{day(w.updatedAt)}
      </span>
    </a>
  );
}

export default function DashboardPage() {
  const { ov, err } = useOverview();
  const { pending } = usePendingPermissions();
  const rituals = useConfig((s) => s.rituals);
  if (!ov) return <Page>{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading your works…" />}</Page>;

  const live = ov.works.filter((w) => !w.archived);
  const repoOf = new Map(ov.repos.flatMap((r) => r.works.map((s) => [s, r.name] as const)));
  const ordered = ov.repos.flatMap((r) => r.works).map((s) => live.find((w) => w.slug === s)).filter((w): w is WorkSummary => Boolean(w));
  const works = [...ordered, ...live.filter((w) => !ordered.includes(w))];
  const openPrs = live.reduce((n, w) => n + w.progress.ready + w.progress.draft, 0);
  const attention = live.filter((w) => w.progress.attention || w.progress.restack).length;
  const running = ov.agents.filter((a) => a.status === 'running');
  const reviewers = ov.personas.filter((p) => p.kind === 'reviewer');
  const writers = ov.personas.filter((p) => p.kind === 'writer');
  const stale = ov.personas.filter((p) => p.stale).length;
  const personaRituals = rituals.filter((r) => ritualFields(r).includes('login'));
  const writerRitual = rituals.find((r) => ritualFields(r).includes('text'));

  return (
    <Page>
      <PageHead
        icon="home"
        title="Dashboard"
        sub="Copiloting the copilots: works, personas, skills and Paseo agents in one place. Runs on your machine; agents never push, post or send on their own."
        actions={<><a className="dp-btn" href="#/repos/new"><Icon name="plus" size={14} />New repo</a><a className="dp-btn dp-primary" href="#/ask"><Icon name="message-square" size={14} />Ask coco</a></>}
      />
      <Legacy><Onboarding /></Legacy>
      <Tiles items={[
        { label: 'Works', value: live.length, hint: `${ov.repos.length} repo${ov.repos.length === 1 ? '' : 's'}`, href: '#/projects' },
        { label: 'Open PRs', value: openPrs, hint: attention ? `${attention} need attention` : 'all calm', tone: attention ? 'warn' : undefined },
        { label: 'Waiting on you', value: pending.length, hint: 'agent questions', tone: pending.length ? 'acc' : undefined, href: '#/agents' },
        { label: 'Agents running', value: running.length, hint: `${ov.agents.length} known`, tone: running.length ? 'ok' : undefined, href: '#/agents' },
        { label: 'Personas', value: ov.personas.length, hint: stale ? `${stale} stale (>60d)` : 'all fresh', tone: stale ? 'bad' : undefined },
        { label: 'Skills', value: ov.skills.length, hint: `${ov.feedbackCount} feedback` },
      ]} />

      <Section title="Works" count={works.length} action={<a className="dp-lnk" href="#/projects">All projects<Icon name="chevron-right" size={12} /></a>}>
        {works.length ? <div className="dp-cards">{works.map((w) => <WorkCard key={w.slug} w={w} repo={repoOf.get(w.slug)} />)}</div> : <Empty icon="layers">No work yet: open a repo and ask coco to scaffold one.</Empty>}
      </Section>

      <Section title="Agents" count={ov.agents.length} meta={running.length ? `${running.length} running` : undefined} action={<a className="dp-lnk" href="#/agents">All agents<Icon name="chevron-right" size={12} /></a>}>
        {ov.agentsError && <ErrorNote>{ov.agentsError}</ErrorNote>}
        {ov.agents.length ? (
          <div className="dp-rows">
            {ov.agents.slice(0, 8).map((a) => (
              <div key={a.id} className="dp-rowi">
                <span className={`dp-ag-dot ${AGENT_TONE[a.status] || 'dp-ag-archived'}`} title={a.status} />
                <span className="dp-ell dp-grow">{a.name}</span>
                <span className="dp-chip">{a.provider}</span>
                <span className="dp-rowi-m">{a.created}</span>
              </div>
            ))}
          </div>
        ) : !ov.agentsError && <Empty icon="bot">No Paseo agent right now.</Empty>}
      </Section>

      <Section title="Reviewer personas" count={reviewers.length} action={personaRituals.length > 0 && <span className="dp-row dp-g6">{personaRituals.map((r) => <a key={r.kind} className="dp-btn dp-sm" href={`#/rituals/${r.kind}`}><Icon name="sparkles" size={12} />{r.label || r.kind}</a>)}</span>}>
        <div className="dp-cards dp-dash-people">
          {reviewers.map((p) => (
            <a key={p.login} className="dp-card" href={`#/persona/${p.login}`}>
              <span className="dp-card-t"><img className="dp-dash-av" src={`/api/avatar/${p.login}`} alt="" loading="lazy" /><span className="dp-rowi-b"><span className="dp-ell">{firstName(p)}</span><span className="dp-t3 dp-ell">@{p.login}</span></span></span>
              <span className="dp-card-s">
                <span className="dp-chip">{p.surfaces} surfaces</span><span className="dp-chip">{p.checks} checks</span>
                {p.hasSlack && <span className="dp-chip dp-ok">slack</span>}
                {p.calibration > 0 && <span className="dp-chip dp-warn">{p.calibration} calibrations</span>}
              </span>
              <span className={`dp-card-s${p.stale ? ' dp-dash-stale' : ''}`}><Icon name="clock" size={12} />mined {p.mined}{p.stale ? ' · stale' : ''}</span>
            </a>
          ))}
        </div>
      </Section>

      {writers.length > 0 && (
        <Section title="Message-writer personas" count={writers.length}>
          <div className="dp-rows">
            {writers.map((p) => (
              <a key={p.login} className="dp-rowi" href={`#/persona/${p.login}`}>
                <img className="dp-dash-av" src={`/api/avatar/${p.login}`} alt="" />
                <span className="dp-rowi-b"><span>{firstName(p)} <span className="dp-t3">@{p.login}</span></span><span className="dp-t3">{writerRitual ? `Used by the ${writerRitual.label || writerRitual.kind} ritual. ` : ''}Drafts only; nothing is sent.</span></span>
                <Icon name="chevron-right" size={14} />
              </a>
            ))}
          </div>
        </Section>
      )}

      <Section title="Skills" count={ov.skills.length}>
        <div className="dp-rows">
          {ov.skills.map((s) => (
            <a key={s.name} className="dp-rowi" href={`#/skill/${s.name}`}>
              <Icon name="book" size={14} />
              <span className="dp-rowi-b"><span><b>{s.name}</b>{s.argumentHint && <code className="dp-dash-arg">{s.argumentHint}</code>}</span><span className="dp-t3 dp-dash-clamp">{s.description}</span></span>
            </a>
          ))}
        </div>
      </Section>

      <Section title="Team pack"><Legacy><TeamPack /></Legacy></Section>

      {(rituals.length > 0 || ov.rituals.length > 0) && (
        <Section title="Recent rituals" count={ov.rituals.length} action={<a className="dp-lnk" href="#/rituals">Rituals<Icon name="chevron-right" size={12} /></a>}>
          {ov.rituals.length ? (
            <div className="dp-rows">
              {ov.rituals.map((r, i) => (
                <div key={i} className="dp-rowi">
                  <span className={`dp-ag-dot ${r.ok ? 'dp-ag-done' : 'dp-ag-failed'}`} />
                  <span className="dp-chip">{r.kind}</span><span className="dp-ell dp-grow">{r.title}</span>
                  <span className="dp-rowi-m">{r.ts.slice(0, 16).replace('T', ' ')}{r.agentId ? ` · ${r.agentId.slice(0, 8)}` : ''}</span>
                </div>
              ))}
            </div>
          ) : <Empty icon="sparkles">None launched from here yet.</Empty>}
        </Section>
      )}

      <Section title="Recent feedback" count={ov.feedback.length}>
        {ov.feedback.length ? (
          <div className="dp-rows">
            {ov.feedback.map((f, i) => (
              <div key={i} className="dp-rowi">
                <span className="dp-chip">{f.verdict || 'note'}</span>
                <span className="dp-rowi-b"><b className="dp-ell">{f.title || f.node}</b>{f.text && <span className="dp-t3">{f.text}</span>}</span>
                <span className="dp-rowi-m">{f.ts}</span>
              </div>
            ))}
          </div>
        ) : <Empty icon="message-square">None yet.</Empty>}
      </Section>

      <div className="dp-dash-notes">
        <Section title="Backlog"><div className="dp-box dp-dash-md"><Legacy><Markdown text={ov.backlog.replace(/^# .*\n/, '')} /></Legacy></div></Section>
        <Section title="Changelog"><div className="dp-box dp-dash-md"><Legacy><Markdown text={ov.changelog.replace(/^# .*\n/, '')} /></Legacy></div></Section>
      </div>
    </Page>
  );
}
