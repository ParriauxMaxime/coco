import React, { useEffect, useState } from 'react';
import { api } from '../api.ts';

const STATUS = { new: 'c-green', changed: 'c-orange', same: 'c-grey' };
const size = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const counts = (files) => Object.entries(files.reduce((o, f) => ({ ...o, [f.status]: (o[f.status] || 0) + 1 }), {}));
const Counts = ({ files }) => counts(files).map(([s, n]) => <span key={s} className={`chip ${STATUS[s]}`}>{n} {s}</span>);
const toggle = (set, v) => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

function ExportPanel() {
  const [contents, setContents] = useState(null);
  const [personas, setPersonas] = useState(new Set());
  const [skills, setSkills] = useState(new Set());
  const [withConfig, setWithConfig] = useState(true);
  const [withProvider, setWithProvider] = useState(true);
  const [status, setStatus] = useState('Loading…');
  useEffect(() => {
    api.packContents().then((c) => {
      setContents(c);
      setPersonas(new Set(c.personas.map((p) => p.login)));
      setSkills(new Set(c.skills.map((s) => s.name)));
      setStatus('');
    }, (e) => setStatus(e.message));
  }, []);
  if (!contents) return <div className="status">{status}</div>;
  const allPersonas = personas.size === contents.personas.length;
  const download = async () => {
    setStatus('Building the zip…');
    try {
      const { blob, name } = await api.exportPack({ personas: [...personas], skills: [...skills], config: withConfig && contents.config, provider: withProvider && Boolean(contents.provider) });
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`${name} · ${size(blob.size)}`);
    } catch (e) {
      setStatus(e.message);
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <h3>Personas</h3>
      <label className="row"><input type="checkbox" checked={allPersonas} onChange={() => setPersonas(allPersonas ? new Set() : new Set(contents.personas.map((p) => p.login)))} /> Select all</label>
      <div className="row" style={{ marginTop: 4 }}>
        {contents.personas.map((p) => (
          <label key={p.login ?? '-'} className="row" title={p.files.join('\n')} style={{ gap: 4 }}>
            <input type="checkbox" checked={personas.has(p.login)} onChange={() => setPersonas(toggle(personas, p.login))} />
            {p.login ? <code>{p.login}</code> : <span className="sub" style={{ margin: 0 }}>other files</span>}
            <span className="status">{p.files.length}</span>
          </label>
        ))}
        {contents.personas.length === 0 && <span className="sub">No persona files.</span>}
      </div>
      <h3>Skills</h3>
      {contents.skills.map((s) => (
        <label key={s.name} className="row">
          <input type="checkbox" checked={skills.has(s.name)} onChange={() => setSkills(toggle(skills, s.name))} />
          <b>{s.name}</b> <span className="status">{s.files.length} files · {size(s.bytes)}</span>
        </label>
      ))}
      {contents.skills.length === 0 && <span className="sub">No team skill found.</span>}
      <h3>Settings</h3>
      <label className="row"><input type="checkbox" disabled={!contents.config} checked={withConfig && contents.config} onChange={() => setWithConfig(!withConfig)} /> Team config <span className="status">{contents.config ? 'your config file minus personal keys (owner, paths, repo.path)' : 'no config file'}</span></label>
      <label className="row"><input type="checkbox" disabled={!contents.provider} checked={withProvider && Boolean(contents.provider)} onChange={() => setWithProvider(!withProvider)} /> Feature-flag provider <span className="status">{contents.provider || 'none configured'}</span></label>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary" onClick={download} disabled={status.startsWith('Building')}>Download</button>
        <span className="status">{status}</span>
      </div>
    </div>
  );
}

function ImportPanel() {
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const [status, setStatus] = useState('');
  const upload = async (file) => {
    if (!file) return;
    setStatus('Reading the pack…');
    setDone(null);
    try {
      setPreview(await api.importPack(file));
      setStatus('');
    } catch (e) {
      setStatus(e.message);
    }
  };
  const apply = async () => {
    setStatus('Applying…');
    try {
      setDone(await api.applyPack(preview.id));
      setPreview(null);
      setStatus('');
    } catch (e) {
      setStatus(e.message);
    }
  };
  const discard = async () => {
    await api.discardPack(preview.id).catch(() => {});
    setPreview(null);
    setStatus('Discarded.');
  };
  const cfg = preview?.config;
  return (
    <div style={{ marginTop: 10 }}>
      {!preview && <input type="file" accept=".zip,application/zip" onChange={(e) => upload(e.target.files[0])} />}
      {preview && (
        <>
          <div className="sub">From <code>{preview.by || 'unknown'}</code>{preview.createdAt ? `, ${preview.createdAt.slice(0, 16).replace('T', ' ')}` : ''}</div>
          {preview.personas.length > 0 && (
            <>
              <h3>Personas</h3>
              <div className="row"><Counts files={preview.personas} /></div>
              <div className="row" style={{ marginTop: 4 }}>{preview.personas.filter((f) => f.status !== 'same').map((f) => <span key={f.file} className={`chip ${STATUS[f.status]}`}>{f.file}</span>)}</div>
            </>
          )}
          {preview.skills.length > 0 && (
            <>
              <h3>Skills</h3>
              {preview.skills.map((s) => (
                <div key={s.name} className="list-item">
                  <div className="row"><b>{s.name}</b> <Counts files={s.files} /></div>
                  <div className="row" style={{ marginTop: 4 }}>{s.files.filter((f) => f.status !== 'same').map((f) => <span key={f.file} className={`chip ${STATUS[f.status]}`}>{f.file}</span>)}</div>
                </div>
              ))}
            </>
          )}
          {preview.provider && (
            <>
              <h3>Feature-flag provider</h3>
              <span className={`chip ${STATUS[preview.provider.status]}`}>{preview.provider.file} · {preview.provider.status}</span>
            </>
          )}
          {cfg && (
            <>
              <h3>Config</h3>
              <div className="row">
                {cfg.added.map((k) => <span key={k} className="chip c-green">+ {k}</span>)}
                {cfg.changed.map((k) => <span key={k} className="chip c-orange">~ {k}</span>)}
                {cfg.kept.map((k) => <span key={k} className="chip c-grey">kept {k}</span>)}
                {cfg.added.length + cfg.changed.length === 0 && <span className="status">No config change.</span>}
              </div>
            </>
          )}
          <div className="danger" style={{ marginTop: 10, fontSize: 13 }}>Packs carry skills and code that agents and coco run: import only from people you trust.</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={apply} disabled={status === 'Applying…'}>Apply</button>
            <button onClick={discard}>Discard</button>
          </div>
        </>
      )}
      {done && (
        <div style={{ marginTop: 8 }}>
          <div className="row">
            <span className="chip c-green">{done.applied.personas} persona files</span>
            <span className="chip c-green">{done.applied.skills} skill files</span>
            {done.applied.provider > 0 && <span className="chip c-green">provider</span>}
            {done.applied.config > 0 && <span className="chip c-green">config merged</span>}
          </div>
          <div className="sub" style={{ marginTop: 6 }}>{done.backup ? <>Overwritten files backed up in <code>{done.backup}</code>.</> : 'Nothing was overwritten.'} Restart coco to load the new config.</div>
        </div>
      )}
      <span className="status">{status}</span>
    </div>
  );
}

export default function TeamPack() {
  const [mode, setMode] = useState(null);
  const pick = (m) => setMode(mode === m ? null : m);
  return (
    <div className="card">
      <div className="sub">Share personas, skills, the team config and the feature-flag provider with teammates as a zip. Personal keys (owner, paths) never leave; on import they stay yours.</div>
      <div className="row">
        <button className={mode === 'export' ? 'on' : ''} onClick={() => pick('export')}>Export</button>
        <button className={mode === 'import' ? 'on' : ''} onClick={() => pick('import')}>Import</button>
      </div>
      {mode === 'export' && <ExportPanel />}
      {mode === 'import' && <ImportPanel />}
    </div>
  );
}
