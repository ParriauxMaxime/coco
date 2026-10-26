import React, { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { useConfig } from '../../config.ts';
import { AskPanel } from '../chat/AskPanel.tsx';
import { askState, useAskConversation } from '../chat/conversation.ts';
import WorktreeChoice from '../widgets/WorktreeChoice.tsx';
import Icon from '../Icon.tsx';
import { workHref } from '../prefs.ts';
import { Empty, Page, PageHead, Section } from './Page.tsx';
import type { AskRun, WorktreeNotice } from '../../types.ts';
import './inbox.css';

const linkOf = (prompt: string) => (prompt.split('\n')[0].match(/https?:\/\/\S+/) || [prompt])[0];
const sourceOf = (url: string) => (/notion\.(so|site)/.test(url) ? 'Notion' : /github\.com/.test(url) ? 'GitHub' : /slack\.com/.test(url) ? 'Slack' : 'link');
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

function Notices() {
  const [notices, setNotices] = useState<WorktreeNotice[]>([]);
  const load = () => api.notices().then(setNotices, () => setNotices([]));
  useEffect(() => { void load(); }, []);
  if (!notices.length) return null;
  return (
    <Section title="Worktrees to clean up" count={notices.length}>
      <div className="dp-inbox-notes">
        {notices.map((n) => (
          <div key={n.id} className="dp-box dp-inbox-notice">
            <div className="dp-inbox-notice-h">
              <span className="dp-inbox-notice-ic"><Icon name="archive" size={14} /></span>
              <span className="dp-rowi-b">
                <span><a href={workHref(n.slug)}><b>{n.title}</b></a> was archived: every PR merged or closed</span>
                <span className="dp-t3 dp-sm">Its worktrees stay until you pick which ones go.</span>
              </span>
              <span className="dp-t3 dp-sm dp-num">{n.at.slice(0, 10)}</span>
            </div>
            <div className="dp-inbox-notice-b"><WorktreeChoice slug={n.slug} confirmLabel={(k) => `Remove ${k}`} secondary={{ label: 'Keep all', run: () => api.dismissNotice(n.id).then(load) }} onDone={() => void load()} /></div>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default function InboxPage() {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const github = useConfig((s) => s.repo.github);
  const convo = useAskConversation('inbox');
  const { run, history, watch, open, loadHistory } = convo;
  const here = useRef<HTMLDivElement>(null);
  const show = () => requestAnimationFrame(() => here.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
  const read = async () => {
    setError('');
    setReading(true);
    try {
      const { id } = await api.inbox({ url, note });
      watch({ id, prompt: url, kind: 'inbox', status: 'running' });
      void loadHistory();
      setUrl('');
      setNote('');
      show();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setReading(false);
    }
  };
  const pick = (h: AskRun) => {
    open(h);
    show();
  };
  const ready = url.trim() && !reading;

  return (
    <Page>
      <PageHead
        icon="inbox"
        title="Inbox"
        sub={<>Paste a Notion page, a {github || 'GitHub'} PR or issue, or a Slack permalink. Coco reads it, then proposes a work: tier, title, Surface | Before | After table, precedents, surfaces, personas, planned stack. Follow up to reshape it.</>}
      />
      <Notices />

      <Section title="Read a link">
        <form className="dp-inbox-form" onSubmit={(e) => { e.preventDefault(); if (ready) void read(); }}>
          <label className="dp-inbox-field">
            <Icon name="link" size={14} />
            <input value={url} aria-label="Link" placeholder={`https://www.notion.so/… · https://github.com/${github || 'acme/widgets'}/issues/… · https://example.slack.com/archives/…`} onChange={(e) => setUrl(e.target.value)} />
            {url.trim() && <span className="dp-chip">{sourceOf(url)}</span>}
          </label>
          <label className="dp-inbox-field dp-inbox-note">
            <Icon name="pencil" size={14} />
            <input value={note} aria-label="Note for coco" placeholder="Note for coco (optional): who asked, deadline, what you suspect" onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="dp-inbox-foot">
            <span className="dp-t3 dp-xs dp-ell">Read-only Notion, gh and Slack tools. Nothing is created until you press Create work.</span>
            <span className="dp-sp" />
            {error && <span className="dp-inbox-err"><Icon name="alert-triangle" size={12} />{error}</span>}
            <button type="submit" className="dp-btn dp-primary" disabled={!ready}>
              {reading ? <><span className="dp-ag-dot dp-ag-running dp-inbox-spin" />Starting coco…</> : <><Icon name="sparkles" size={14} />Read and propose<kbd>↵</kbd></>}
            </button>
          </div>
        </form>
      </Section>

      <div ref={here} className="dp-inbox-anchor" />
      {run && (
        <Section title="Proposal" meta={<span className="dp-ell dp-inbox-src">{linkOf(run.prompt || '')}</span>}>
          <div className="dp-inbox-run">
            <AskPanel convo={convo} placeholder="Reshape the proposal: smaller tier, split a PR, another precedent… (markdown, ⌘↵)" />
          </div>
        </Section>
      )}

      <Section title="Previous links" count={history.length}>
        {history.length ? (
          <div className="dp-rows">
            {history.map((h) => {
              const st = askState(h.status);
              const link = linkOf(h.prompt);
              return (
                <div key={h.id} className={`dp-rowi dp-click dp-inbox-row${run?.id === h.id ? ' dp-on' : ''}`} role="button" tabIndex={0} onClick={() => pick(h)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(h); } }}>
                  <span className="dp-inbox-ic"><Icon name="link" size={14} /></span>
                  <span className="dp-rowi-b">
                    <span className="dp-ell">{h.proposed?.title || link}</span>
                    <span className="dp-t3 dp-ell">{h.proposed?.title ? link : sourceOf(link)}</span>
                  </span>
                  <span className={`dp-chip ${st.tone}`}>{st.label}</span>
                  <span className="dp-rowi-m dp-inbox-meta">{when(h.startedAt)}{(h.turns ?? 0) > 1 ? ` · ${h.turns} turns` : ''}{h.cost != null ? ` · $${Number(h.cost).toFixed(3)}` : ''}</span>
                </div>
              );
            })}
          </div>
        ) : <Empty icon="inbox">No link read yet. Paste one above to get a work proposal.</Empty>}
      </Section>
    </Page>
  );
}
