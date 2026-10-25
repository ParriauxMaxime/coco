import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import Markdown from '../components/Markdown.tsx';
import Editor from '../components/Editor.tsx';
import Feedback from '../components/Feedback.tsx';
import type { SkillDetail } from '../types.ts';

export default function Skill({ name, tab = 'read' }: { name: string; tab?: string }) {
  const [s, setS] = useState<SkillDetail | null>(null);
  const [err, setErr] = useState('');
  const [file, setFile] = useState('SKILL.md');
  const [text, setText] = useState('');
  useEffect(() => {
    api.skill(name).then(setS).catch((e) => setErr(errorMessage(e)));
  }, [name]);
  useEffect(() => {
    if (!s) return;
    api.skillFile(name, file).then(setText);
  }, [name, file, s]);
  const load = useCallback(() => api.skillFile(name, file), [name, file]);
  const save = useCallback((t: string) => api.saveSkillFile(name, file, t), [name, file]);
  if (err) return <div className="card danger">{err}</div>;
  if (!s) return <div className="sub">Loading…</div>;
  return (
    <>
      <h1>{s.name}</h1>
      <p className="sub">{s.description}</p>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={file} onChange={(e) => setFile(e.target.value)}>{s.files.map((f) => <option key={f}>{f}</option>)}</select>
        <div className="tabs" style={{ margin: 0 }}>
          <a href={`#/skill/${name}/read`}><button className={tab === 'read' ? 'on' : ''}>Read</button></a>
          <a href={`#/skill/${name}/edit`}><button className={tab === 'edit' ? 'on' : ''}>Edit</button></a>
        </div>
        <span className="status">modified {s.mtime.slice(0, 16).replace('T', ' ')}</span>
      </div>
      {tab === 'read' && <div className="card"><Markdown text={text.replace(/^---[\s\S]*?---\n/, '')} /><Feedback node={`skill:${name}:${file}`} title={`${name} · ${file}`} verdicts={['keep', 'change', 'drop', 'question']} /></div>}
      {tab === 'edit' && <div className="card"><Editor key={file} load={load} save={save} label={`${name}/${file}`} /></div>}
    </>
  );
}
