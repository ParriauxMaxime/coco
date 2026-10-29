import React from 'react';
import { workHref } from '../prefs.ts';
import { useOverview } from '../overview.ts';
import { WorkCard } from './DashboardPage.tsx';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import type { WorkSummary } from '../../types.ts';

// #/works: the live works by repo, each opening on its stack; the phone's Works tab
export default function WorksPage() {
  const { ov, err } = useOverview();
  if (!ov) return <Page>{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading your works…" />}</Page>;
  const live = new Map(ov.works.filter((w) => !w.archived).map((w) => [w.slug, w]));
  const repos = ov.repos.map((r) => ({ r, works: r.works.map((s) => live.get(s)).filter((w): w is WorkSummary => Boolean(w)) })).filter((x) => x.works.length);
  return (
    <Page>
      <PageHead icon="layers" title="Works" />
      {!repos.length && <Empty icon="layers">No work yet: open a repo and ask coco to scaffold one.</Empty>}
      {repos.map(({ r, works }) => (
        <Section key={r.id} title={<a href={`#/repo/${r.id}`}>{r.name}</a>} count={works.length}>
          <div className="dp-cards">{works.map((w) => <WorkCard key={w.slug} w={w} href={`${workHref(w.slug)}/stack`} />)}</div>
        </Section>
      ))}
    </Page>
  );
}
