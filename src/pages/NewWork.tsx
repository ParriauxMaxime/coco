import React, { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import type { Link } from '../types.ts';

type Form = { slug: string; title: string; projectId: string; projectName: string; stackText: string; notionProduct: string; notionDecisions: string };

export default function NewWork({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [form, setForm] = useState<Form>({ slug: projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: projectName, projectId, projectName, stackText: '', notionProduct: '', notionDecisions: '' });
  const [status, setStatus] = useState('');
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const create = async () => {
    const stack = form.stackText.split(/[\s,→>-]+/).filter(Boolean).map((n) => ({ number: Number(n.replace('#', '')), personas: [] })).filter((s) => s.number);
    const links = [form.notionProduct && { label: 'Product (Notion)', url: form.notionProduct }, form.notionDecisions && { label: 'Decisions and why (Notion)', url: form.notionDecisions }].filter((l): l is Link => typeof l !== 'string');
    try {
      await api.createWork({ slug: form.slug, title: form.title, projectId: form.projectId, projectName: form.projectName, stack, links });
      location.hash = `#/work/${form.slug}`;
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };
  return (
    <>
      <h1>Attach a work to {projectName}</h1>
      <div className="card">
        <form className="ritual" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <label>Slug<input value={form.slug} onChange={set('slug')} /></label>
          <label>Title<input value={form.title} onChange={set('title')} /></label>
          <label>PR stack, in merge order<input value={form.stackText} onChange={set('stackText')} placeholder="101 102 103" /></label>
          <label>Product page (Notion)<input value={form.notionProduct} onChange={set('notionProduct')} placeholder="https://www.notion.so/…" /></label>
          <label>Decisions page (Notion)<input value={form.notionDecisions} onChange={set('notionDecisions')} placeholder="https://www.notion.so/…" /></label>
          <div className="row"><button className="primary" type="submit">Create</button><span className="status danger">{status}</span></div>
        </form>
      </div>
      <p className="sub">Or let coco scaffold it from a sentence: <a href="#/ask">Ask coco</a>.</p>
    </>
  );
}
