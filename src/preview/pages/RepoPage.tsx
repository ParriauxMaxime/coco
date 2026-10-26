import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { stateKey, stateLabel } from '../../components/PrBadge.tsx';
import { useConfig } from '../../config.ts';
import { RepoAsk } from '../chat/AskPanel.tsx';
import { addRepoAndOpen } from '../chat/Proposals.tsx';
import RulesLedger from '../widgets/Rules.tsx';
import Icon from '../Icon.tsx';
import { SegBar, workDot } from '../Shell.tsx';
import { workHref } from '../prefs.ts';
import { reloadOverview } from '../overview.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section, Tiles } from './Page.tsx';
import type { LoosePr, RepoPage as RepoData } from '../../types.ts';
import './newwork.css';
import './repo.css';

type RepoWork = RepoData['works'][number];

const PR_TONE: Record<string, string> = { ready: 'review', closed: 'planned' };
const prTone = (pr: LoosePr) => { const k = stateKey(pr); return `dp-st-${PR_TONE[k] || k}`; };
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '');
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function WorkCard({ w }: { w: RepoWork }) {
  const p = w.progress;
  return (
    <a className="dp-card dp-repop-work" href={workHref(w.slug)}>
      <span className="dp-card-t"><span className={`dp-dot dp-lg ${workDot(w)}`} /><span className="dp-ell dp-grow">{w.title}</span>{p.restack && <span className="dp-chip dp-warn" title="A parent PR merged: its children still sit on the old base">restack</span>}</span>
      <span className="dp-repop-bar"><SegBar w={w} thin={false} /><span className="dp-repop-pc">{p.merged}/{w.stack - p.closed}</span></span>
      <span className={`dp-repop-next${w.next ? '' : ' dp-repop-none'}`}>{w.next || 'No what’s next yet'}</span>
      <span className="dp-card-s">
        {p.attention && <span className="dp-chip dp-bad">changes requested or CI failing</span>}
        <span className="dp-sp" />{day(w.updatedAt)}
      </span>
    </a>
  );
}

function NewWorkForm({ repo, onCancel }: { repo: string; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const s = slug || slugOf(title);
    setBusy(true);
    try {
      await api.createWork({ slug: s, title: title.trim(), repo, stack: [], links: [] });
      reloadOverview();
      location.hash = workHref(s);
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };
  return (
    <form className="dp-box dp-repop-new" onSubmit={(e) => { e.preventDefault(); if (title.trim() && !busy) create(); }}>
      <div className="dp-nw-form">
        <div className="dp-nw-grid">
          <label className="dp-nw-field"><span className="dp-nw-l">Title</span><input className="dp-inp" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="CSV export of invoices" /></label>
          <label className="dp-nw-field"><span className="dp-nw-l">Slug</span><input className="dp-inp dp-nw-mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugOf(title) || 'csv-export'} /></label>
        </div>
      </div>
      <div className="dp-nw-foot">
        <button className="dp-btn dp-primary" type="submit" disabled={!title.trim() || busy}>{busy ? 'Creating…' : 'Create'}</button>
        <button className="dp-btn" type="button" onClick={onCancel}>Cancel</button>
        {error ? <span className="dp-nw-err">{error}</span> : <span className="dp-nw-hint">Or describe it to this repo’s Ask coco below: it proposes a full scaffold (stack, personas, open questions) you apply.</span>}
      </div>
    </form>
  );
}

export function NewRepoPage() {
  const cloneDir = useConfig((s) => s.cloneDir);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const add = async () => {
    setBusy(true);
    setError('');
    await addRepoAndOpen(() => api.addRepo(source.trim())).then(() => reloadOverview(), (e) => setError(errorMessage(e)));
    setBusy(false);
  };
  return (
    <Page>
      <PageHead
        icon="git-branch"
        title="New repo"
        sub="A GitHub slug or a local clone becomes a repo of coco: its works, its Ask coco, its loose PRs and its lessons."
      />
      <form className="dp-box dp-nw-wrap" onSubmit={(e) => { e.preventDefault(); if (source.trim() && !busy) add(); }}>
        <div className="dp-nw-form">
          <label className="dp-nw-field"><span className="dp-nw-l">GitHub slug or folder</span><input className="dp-inp dp-nw-mono" autoFocus value={source} onChange={(e) => setSource(e.target.value)} placeholder="acme/widgets or ~/code/widgets" /></label>
        </div>
        <div className="dp-nw-foot">
          <button className="dp-btn dp-primary" type="submit" disabled={!source.trim() || busy}><Icon name="plus" size={14} />{busy ? 'Adding…' : 'Add repo'}</button>
          {error && <span className="dp-nw-err">{error}</span>}
        </div>
      </form>
      <Section title="What happens">
        <ol className="dp-repop-steps">
          <li><span className="dp-repop-n">1</span><span>A GitHub slug is looked for among the clones in <code>{cloneDir || 'the clone folder'}</code> by their origin remote, and cloned there with <code>gh</code> when none matches.</span></li>
          <li><span className="dp-repop-n">2</span><span>coco lists the repo in your config and adds its Paseo project.</span></li>
          <li><span className="dp-repop-n">3</span><span>A setup run starts and proposes the repo’s config.</span></li>
        </ol>
        <div className="dp-nw-alt"><Icon name="message-square" size={16} /><span className="dp-grow">The global Ask coco can add one too.</span><a className="dp-btn dp-sm" href="#/ask">Ask coco<Icon name="chevron-right" size={12} /></a></div>
      </Section>
    </Page>
  );
}

export default function RepoPage({ id }: { id: string }) {
  const [data, setData] = useState<RepoData | null>(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const load = (fresh = false) => api.repo(id, fresh).then((d) => { setData(d); setErr(''); }, (e) => setErr(errorMessage(e)));
  useEffect(() => {
    setData(null);
    setCreating(false);
    load();
  }, [id]);
  if (!data) return <Page>{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading the repo…" />}</Page>;
  const refresh = () => {
    setRefreshing(true);
    load(true).finally(() => setRefreshing(false));
  };
  const openPrs = data.works.reduce((n, w) => n + w.progress.ready + w.progress.draft, 0);
  const attention = data.works.filter((w) => w.progress.attention || w.progress.restack).length;

  return (
    <Page>
      <PageHead
        icon="git-branch"
        title={data.name}
        meta={<>
          {data.github ? <a className="dp-crumb dp-row dp-g6" href={`https://github.com/${data.github}`} target="_blank" rel="noreferrer">{data.github}<Icon name="external-link" size={12} /></a> : <span>no GitHub slug</span>}
          <span className="dp-t4">·</span><span className="dp-row dp-g6"><Icon name="git-branch" size={12} />{data.defaultBranch}</span>
        </>}
        sub={<code className="dp-repop-path">{data.path}</code>}
        actions={!creating && <button type="button" className="dp-btn dp-primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New work</button>}
      />
      {err && <div className="dp-repop-gap"><ErrorNote>{err}</ErrorNote></div>}
      <Tiles items={[
        { label: 'Works', value: data.works.length, hint: data.archivedCount ? `${data.archivedCount} archived` : 'none archived', href: data.archivedCount ? '#/archive' : undefined },
        { label: 'Open PRs', value: openPrs, hint: attention ? `${attention} need attention` : 'all calm', tone: attention ? 'warn' : undefined },
        { label: 'Loose PRs', value: data.loose.prs.length, hint: 'held by no work', tone: data.loose.prs.length ? 'acc' : undefined },
        { label: 'Lessons', value: data.lessons.length, hint: 'from your corrections' },
      ]} />

      <Section title="Works" count={data.works.length} action={data.archivedCount > 0 && <a className="dp-lnk" href="#/archive">{data.archivedCount} archived<Icon name="chevron-right" size={12} /></a>}>
        {creating && <NewWorkForm repo={data.id} onCancel={() => setCreating(false)} />}
        {data.works.length ? <div className="dp-cards dp-repop-works">{data.works.map((w) => <WorkCard key={w.slug} w={w} />)}</div> : !creating && <Empty icon="layers">No work in {data.name} yet: start one, or describe it to Ask coco below.</Empty>}
      </Section>

      <Section title="Ask coco">
        <RepoAsk key={data.id} repoId={data.id} repoName={data.name} />
      </Section>

      <Section title="Loose PRs" count={data.loose.prs.length} action={<button type="button" className="dp-btn dp-sm" onClick={refresh} disabled={refreshing} title="Ask GitHub again"><Icon name="refresh" size={12} className={refreshing ? 'dp-spin' : undefined} />{refreshing ? 'Asking GitHub…' : 'Refresh'}</button>}>
        <p className="dp-repop-lead">Your open PRs on {data.github || data.name} that no work holds.</p>
        {data.loose.error && <ErrorNote>{data.loose.error}</ErrorNote>}
        {data.loose.prs.length > 0 && (
          <div className="dp-rows dp-repop-loose">
            {data.loose.prs.map((pr) => (
              <a key={pr.number} className="dp-rowi" href={pr.url} target="_blank" rel="noreferrer">
                <span className={`dp-prb ${prTone(pr)}`}><Icon name="git-pull-request" size={12} />#{pr.number}</span>
                <span className="dp-rowi-b"><span className="dp-ell">{pr.title}</span><span className="dp-repop-ref dp-ell">{pr.headRefName}</span></span>
                <span className={`dp-chip dp-tone ${prTone(pr)}`}>{stateLabel(pr)}</span>
                <span className="dp-rowi-m dp-repop-date">{pr.updatedAt.slice(0, 10)}</span>
                <Icon name="external-link" size={12} />
              </a>
            ))}
          </div>
        )}
        {!data.loose.error && data.loose.prs.length === 0 && <Empty icon="git-pull-request">None: every open PR of yours belongs to a work.</Empty>}
      </Section>

      <Section title="Lessons" count={data.lessons.length}>
        <p className="dp-repop-lead">What agent briefs in this repo learned from your mid-run corrections.</p>
        {data.lessons.length ? (
          <div className="dp-rows">
            {data.lessons.map((l, i) => (
              <div key={i} className="dp-rowi dp-repop-lesson">
                <Icon name="notebook" size={14} />
                <span className="dp-grow">{l.text}</span>
                {(l.work || l.at) && <span className="dp-rowi-m">{l.work && <a href={workHref(l.work)}>{l.work}</a>}{l.work && l.at && ' · '}{l.at?.slice(0, 10)}</span>}
              </div>
            ))}
          </div>
        ) : <Empty icon="notebook">No lesson yet.</Empty>}
      </Section>

      <Section title="Rules" meta={data.ruleFiles.length ? `${data.ruleFiles.length} repo rule ${data.ruleFiles.length === 1 ? 'file' : 'files'}` : undefined}>
        {data.ruleFiles.length > 0 && (
          <>
            <p className="dp-repop-lead">Agents read the repo’s own rules first. The ledger below applies in every repo.</p>
            <div className="dp-rows dp-repop-files">{data.ruleFiles.map((f) => <div key={f} className="dp-rowi"><Icon name="file" size={14} /><code className="dp-ell">{f}</code></div>)}</div>
          </>
        )}
        <RulesLedger />
      </Section>
    </Page>
  );
}
