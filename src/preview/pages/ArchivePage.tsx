import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import Icon from '../Icon.tsx';
import { SegBar } from '../Shell.tsx';
import { workHref } from '../prefs.ts';
import { reloadOverview, useOverview } from '../overview.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import type { WorkSummary } from '../../types.ts';
import './archive.css';

const SUB = 'Works out of the sidebar, per repo. They stay reachable here and can come back: unarchive puts a work back in its repo.';
const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '');

function ArchivedRow({ w, busy, onUnarchive }: { w: WorkSummary; busy: boolean; onUnarchive: () => void }) {
  const p = w.progress;
  const auto = w.archived?.reason === 'auto';
  return (
    <div className="dp-rowi dp-arch-row">
      <span className="dp-arch-ic"><Icon name="archive" size={14} /></span>
      <a className="dp-rowi-b dp-arch-main" href={workHref(w.slug)}>
        <span className="dp-ell dp-arch-t">{w.title}</span>
        <span className="dp-arch-sub">{w.projectName && w.projectName !== w.title && <span className="dp-ell">{w.projectName}</span>}<span className="dp-t4 dp-mono">{w.slug}</span></span>
      </a>
      {w.stack > 0 && <span className="dp-arch-bar"><SegBar w={w} /><span className="dp-arch-pc">{p.merged + p.landed}/{w.stack - p.closed}</span></span>}
      <span className="dp-arch-prs">{w.stack} PR{w.stack === 1 ? '' : 's'}</span>
      <span className={`dp-chip${auto ? ' dp-ok' : ''}`} title={auto ? 'Every PR merged or closed' : 'Archived by hand'}>{auto ? 'auto' : 'by hand'}</span>
      <span className="dp-rowi-m dp-arch-at">{day(w.archived?.at)}</span>
      <button type="button" className="dp-btn dp-sm dp-arch-btn" disabled={busy} onClick={onUnarchive}><Icon name="upload" size={12} />Unarchive</button>
    </div>
  );
}

export default function ArchivePage() {
  const { ov, err } = useOverview();
  const [busy, setBusy] = useState<string | null>(null);
  if (!ov) return <Page><PageHead icon="archive" title="Archive" sub={SUB} />{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading archived works…" />}</Page>;

  const bySlug = new Map(ov.works.map((w) => [w.slug, w]));
  const groups = ov.repos
    .map((r) => ({ ...r, archived: r.works.map((s) => bySlug.get(s)).filter((w): w is WorkSummary => Boolean(w?.archived)).sort((a, b) => (b.archived?.at || '').localeCompare(a.archived?.at || '')) }))
    .filter((g) => g.archived.length);
  const total = groups.reduce((n, g) => n + g.archived.length, 0);
  const unarchive = async (slug: string) => {
    setBusy(slug);
    try {
      await api.archiveWork(slug, false);
      await reloadOverview();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHead
        icon="archive"
        title="Archive"
        meta={total ? <span className="dp-num">{total} archived work{total === 1 ? '' : 's'} across {groups.length} repo{groups.length === 1 ? '' : 's'}</span> : undefined}
        sub={SUB}
      />
      {err && <ErrorNote>{err}</ErrorNote>}
      {groups.length ? groups.map((g) => (
        <Section key={g.id} title={<><Icon name="git-branch" size={14} />{g.name}</>} count={g.archived.length}>
          <div className="dp-rows">
            {g.archived.map((w) => <ArchivedRow key={w.slug} w={w} busy={busy === w.slug} onUnarchive={() => void unarchive(w.slug)} />)}
          </div>
        </Section>
      )) : <Section title="Archived works" count={0}><Empty icon="archive">No archived work. Works land here once every PR is merged or closed, or when you archive one by hand.</Empty></Section>}
    </Page>
  );
}
