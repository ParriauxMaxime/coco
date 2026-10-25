import React from 'react';
import Markdown from '../../components/Markdown.tsx';
import FileTree from '../../components/FileTree.tsx';
import { useWork } from '../use-work.ts';
import type { WorkDetail } from '../../types.ts';
import type { WorkPr } from '../types.ts';

function DevDetails({ work, pr, index }: { work: WorkDetail; pr: WorkPr; index: number }) {
  return (
    <>
      <div className="status" style={{ margin: '6px 0' }}><code>{pr.head}</code> ← <code>{pr.base}</code> · {pr.sha}{pr.reviewers && pr.reviewers.length > 0 && <> · {pr.reviewers.map((r) => `${r.login} ${r.state.toLowerCase().replace('_', ' ')}`).join(', ')}</>}</div>
      {pr.checks && pr.checks.length > 0 && <div className="row" style={{ marginBottom: 6 }}>{pr.checks.map((c, i) => <span key={i} className={`chip ${c.conclusion === 'SUCCESS' ? 'c-green' : c.conclusion === 'FAILURE' ? 'c-red' : 'c-orange'}`}>{c.name}</span>)}</div>}
      <h3>Changes vs <code>{pr.base}</code> · {pr.changedFiles} files <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span></h3>
      <FileTree files={pr.files || []} />
      <h3>Full PR body</h3>
      <Markdown text={pr.body || '_No body._'} />
      <div className="row" style={{ marginTop: 8 }}>{(work.stack?.[index]?.personas || []).map((p) => <a key={p} href={`#/rituals/review-as/${p}`}><button className="sm">self-review as {p}</button></a>)}</div>
    </>
  );
}

export default function Pr({ tabId }: { tabId: string }) {
  const { w, prs } = useWork();
  const n = Number(tabId.slice(3));
  const i = prs.findIndex((p) => p.number === n);
  if (i < 0) return <div className="sub">PR #{n} is not in this work.</div>;
  return <DevDetails work={w} pr={prs[i]} index={i} />;
}
