import React, { useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { useUnsaved } from '../../updates.ts';
import Icon from '../Icon.tsx';
import { workHref } from '../prefs.ts';
import { reloadOverview } from '../overview.ts';
import { Page, PageHead } from './Page.tsx';
import type { Link } from '../../types.ts';
import './newwork.css';

type Form = { slug: string; title: string; stackText: string; notionProduct: string; notionDecisions: string };

const stackOf = (text: string) => text.split(/[\s,→>-]+/).filter(Boolean).map((n) => Number(n.replace('#', ''))).filter(Boolean);

export default function NewWorkPage({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [blank] = useState<Form>(() => ({ slug: projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: projectName, stackText: '', notionProduct: '', notionDecisions: '' }));
  const [form, setForm] = useState(blank);
  useUnsaved(JSON.stringify(form) !== JSON.stringify(blank));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const numbers = stackOf(form.stackText);
  const create = async () => {
    const stack = numbers.map((number) => ({ number, personas: [] }));
    const links = [form.notionProduct && { label: 'Product (Notion)', url: form.notionProduct }, form.notionDecisions && { label: 'Decisions and why (Notion)', url: form.notionDecisions }].filter((l): l is Link => typeof l !== 'string');
    setBusy(true);
    setStatus('');
    try {
      await api.createWork({ slug: form.slug, title: form.title, projectId, projectName, stack, links });
      reloadOverview();
      location.hash = workHref(form.slug);
    } catch (e) {
      setStatus(errorMessage(e));
    }
    setBusy(false);
  };
  return (
    <Page>
      <PageHead
        icon="layers"
        meta={<><a className="dp-crumb" href="#/projects">Projects</a><Icon name="chevron-right" size={12} /><span>{projectName}</span></>}
        title={<>Attach a work to {projectName}</>}
        sub="A work carries the project's long-term context: its PR stack in merge order, its product and decision pages, its personas and notes."
        actions={<a className="dp-btn" href="#/projects">Cancel</a>}
      />
      <form className="dp-box dp-nw-wrap" onSubmit={(e) => { e.preventDefault(); if (!busy) create(); }}>
        <div className="dp-nw-form">
          <div className="dp-nw-grid">
            <label className="dp-nw-field"><span className="dp-nw-l">Title</span><input className="dp-inp" value={form.title} onChange={set('title')} autoFocus /></label>
            <label className="dp-nw-field"><span className="dp-nw-l">Slug</span><input className="dp-inp dp-nw-mono" value={form.slug} onChange={set('slug')} /></label>
            <label className="dp-nw-field dp-nw-wide">
              <span className="dp-nw-l">PR stack, in merge order</span>
              <input className="dp-inp dp-nw-mono" value={form.stackText} onChange={set('stackText')} placeholder="101 102 103" />
              <span className="dp-nw-pv">{numbers.length ? numbers.map((n, i) => <React.Fragment key={`${n}-${i}`}>{i > 0 && <Icon name="chevron-right" size={12} />}<span className="dp-prb dp-st-planned"><Icon name="git-pull-request" size={12} />#{n}</span></React.Fragment>) : <span className="dp-nw-h">Optional: PR numbers separated by spaces, commas or arrows.</span>}</span>
            </label>
            <label className="dp-nw-field"><span className="dp-nw-l">Product page (Notion)</span><input className="dp-inp" value={form.notionProduct} onChange={set('notionProduct')} placeholder="https://www.notion.so/…" /></label>
            <label className="dp-nw-field"><span className="dp-nw-l">Decisions page (Notion)</span><input className="dp-inp" value={form.notionDecisions} onChange={set('notionDecisions')} placeholder="https://www.notion.so/…" /></label>
          </div>
        </div>
        <div className="dp-nw-foot">
          <button className="dp-btn dp-primary" type="submit" disabled={busy || !form.slug.trim() || !form.title.trim()}><Icon name="plus" size={14} />{busy ? 'Creating…' : 'Create work'}</button>
          {status ? <span className="dp-nw-err">{status}</span> : <span className="dp-nw-hint">Paseo project <code>{projectId}</code></span>}
        </div>
      </form>
      <div className="dp-nw-alt"><Icon name="message-square" size={16} /><span className="dp-grow">Or let coco scaffold it from a sentence: stack, personas and open questions, which you apply.</span><a className="dp-btn dp-sm" href="#/ask">Ask coco<Icon name="chevron-right" size={12} /></a></div>
    </Page>
  );
}
