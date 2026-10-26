import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import type { PackApplied, PackContents, PackFile, PackPreview } from '../../types.ts';
import './widgets.css';

const TONE: Record<string, string> = { new: 'dp-ok', changed: 'dp-warn', same: '' };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const counts = (files: PackFile[]) => Object.entries(files.reduce<Record<string, number>>((o, f) => ({ ...o, [f.status]: (o[f.status] || 0) + 1 }), {}));
const Counts = ({ files }: { files: PackFile[] }) => counts(files).map(([s, n]) => <span key={s} className={`dp-chip ${TONE[s]}`}>{n} {s}</span>);
const Changed = ({ files }: { files: PackFile[] }) => <span className="dp-pack-chips">{files.filter((f) => f.status !== 'same').map((f) => <span key={f.file} className={`dp-chip ${TONE[f.status]}`}>{f.file}</span>)}</span>;
const toggle = <T,>(set: Set<T>, v: T) => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

function Tick({ on, disabled = false, onChange, children, title }: { on: boolean; disabled?: boolean; onChange: () => void; children: React.ReactNode; title?: string }) {
  return (
    <label className={`dp-pack-tick${on ? ' dp-on' : ''}${disabled ? ' dp-off' : ''}`} title={title}>
      <input className="dp-vh" type="checkbox" checked={on} disabled={disabled} onChange={onChange} />
      <span className="dp-check" />
      {children}
    </label>
  );
}

const Sub = ({ children }: { children: React.ReactNode }) => <div className="dp-pack-h">{children}</div>;

function ExportPanel() {
  const [contents, setContents] = useState<PackContents | null>(null);
  const [personas, setPersonas] = useState(new Set<string | null>());
  const [skills, setSkills] = useState(new Set<string>());
  const [withConfig, setWithConfig] = useState(true);
  const [withProvider, setWithProvider] = useState(true);
  const [status, setStatus] = useState('Loading…');
  useEffect(() => {
    api.packContents().then((c) => {
      setContents(c);
      setPersonas(new Set(c.personas.map((p) => p.login)));
      setSkills(new Set(c.skills.map((s) => s.name)));
      setStatus('');
    }, (e) => setStatus(errorMessage(e)));
  }, []);
  if (!contents) return <div className="dp-pack-b dp-t3 dp-sm">{status}</div>;
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
      setStatus(errorMessage(e));
    }
  };
  return (
    <div className="dp-pack-b">
      <Sub>Personas<Tick on={allPersonas} onChange={() => setPersonas(allPersonas ? new Set() : new Set(contents.personas.map((p) => p.login)))}>Select all</Tick></Sub>
      <div className="dp-pack-grid">
        {contents.personas.map((p) => (
          <Tick key={p.login ?? '-'} on={personas.has(p.login)} onChange={() => setPersonas(toggle(personas, p.login))} title={p.files.join('\n')}>
            {p.login ? <code>{p.login}</code> : <span className="dp-t3">other files</span>}
            <span className="dp-t3 dp-num">{p.files.length}</span>
          </Tick>
        ))}
        {contents.personas.length === 0 && <span className="dp-t3 dp-sm">No persona files.</span>}
      </div>
      <Sub>Skills</Sub>
      <div className="dp-pack-list">
        {contents.skills.map((s) => (
          <Tick key={s.name} on={skills.has(s.name)} onChange={() => setSkills(toggle(skills, s.name))}>
            <b>{s.name}</b><span className="dp-t3 dp-sm">{s.files.length} files · {size(s.bytes)}</span>
          </Tick>
        ))}
        {contents.skills.length === 0 && <span className="dp-t3 dp-sm">No team skill found.</span>}
      </div>
      <Sub>Settings</Sub>
      <div className="dp-pack-list">
        <Tick on={withConfig && contents.config} disabled={!contents.config} onChange={() => setWithConfig(!withConfig)}>Team config<span className="dp-t3 dp-sm">{contents.config ? 'your config file minus personal keys (owner, paths, repo.path)' : 'no config file'}</span></Tick>
        <Tick on={withProvider && Boolean(contents.provider)} disabled={!contents.provider} onChange={() => setWithProvider(!withProvider)}>Feature-flag provider<span className="dp-t3 dp-sm">{contents.provider || 'none configured'}</span></Tick>
      </div>
      <div className="dp-pack-f">
        <button type="button" className="dp-btn dp-primary dp-sm" onClick={download} disabled={status.startsWith('Building')}><Icon name="download" size={12} />Download</button>
        <span className="dp-t3 dp-sm">{status}</span>
      </div>
    </div>
  );
}

function ImportPanel() {
  const [preview, setPreview] = useState<PackPreview | null>(null);
  const [done, setDone] = useState<PackApplied | null>(null);
  const [status, setStatus] = useState('');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setStatus('Reading the pack…');
    setDone(null);
    try {
      setPreview(await api.importPack(file));
      setStatus('');
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };
  const apply = async () => {
    if (!preview) return;
    setStatus('Applying…');
    try {
      setDone(await api.applyPack(preview.id));
      setPreview(null);
      setStatus('');
    } catch (e) {
      setStatus(errorMessage(e));
    }
  };
  const discard = async () => {
    if (!preview) return;
    await api.discardPack(preview.id).catch(() => {});
    setPreview(null);
    setStatus('Discarded.');
  };
  const cfg = preview?.config;
  return (
    <div className="dp-pack-b">
      {!preview && (
        <label className="dp-pack-drop">
          <input className="dp-vh" type="file" accept=".zip,application/zip" onChange={(e) => upload(e.target.files?.[0])} />
          <Icon name="upload" size={14} /><span>Choose a team pack <span className="dp-t3">(.zip)</span></span>
        </label>
      )}
      {preview && (
        <>
          <div className="dp-t3 dp-sm">From <code>{preview.by || 'unknown'}</code>{preview.createdAt ? `, ${preview.createdAt.slice(0, 16).replace('T', ' ')}` : ''}</div>
          {preview.personas.length > 0 && (
            <>
              <Sub>Personas</Sub>
              <div className="dp-pack-chips"><Counts files={preview.personas} /></div>
              <Changed files={preview.personas} />
            </>
          )}
          {preview.skills.length > 0 && (
            <>
              <Sub>Skills</Sub>
              <div className="dp-rows">
                {preview.skills.map((s) => (
                  <div key={s.name} className="dp-rowi dp-pack-skill">
                    <span className="dp-rowi-b"><span className="dp-pack-chips"><b>{s.name}</b><Counts files={s.files} /></span><Changed files={s.files} /></span>
                  </div>
                ))}
              </div>
            </>
          )}
          {preview.provider && (
            <>
              <Sub>Feature-flag provider</Sub>
              <span className={`dp-chip ${TONE[preview.provider.status]}`}>{preview.provider.file} · {preview.provider.status}</span>
            </>
          )}
          {cfg && (
            <>
              <Sub>Config</Sub>
              <div className="dp-pack-chips">
                {cfg.added.map((k) => <span key={k} className="dp-chip dp-ok">+ {k}</span>)}
                {cfg.changed.map((k) => <span key={k} className="dp-chip dp-warn">~ {k}</span>)}
                {cfg.kept.map((k) => <span key={k} className="dp-chip">kept {k}</span>)}
                {cfg.added.length + cfg.changed.length === 0 && <span className="dp-t3 dp-sm">No config change.</span>}
              </div>
            </>
          )}
          <div className="dp-pack-warn"><Icon name="alert-triangle" size={14} /><span>Packs carry skills and code that agents and coco run: import only from people you trust.</span></div>
          <div className="dp-pack-f">
            <button type="button" className="dp-btn dp-primary dp-sm" onClick={apply} disabled={status === 'Applying…'}><Icon name="check" size={12} />Apply</button>
            <button type="button" className="dp-btn dp-sm" onClick={discard}>Discard</button>
          </div>
        </>
      )}
      {done && (
        <div className="dp-pack-done">
          <div className="dp-pack-chips">
            <span className="dp-chip dp-ok">{done.applied.personas} persona files</span>
            <span className="dp-chip dp-ok">{done.applied.skills} skill files</span>
            {done.applied.provider > 0 && <span className="dp-chip dp-ok">provider</span>}
            {done.applied.config > 0 && <span className="dp-chip dp-ok">config merged</span>}
          </div>
          <div className="dp-t3 dp-sm">{done.backup ? <>Overwritten files backed up in <code>{done.backup}</code>.</> : 'Nothing was overwritten.'} Restart coco to load the new config.</div>
        </div>
      )}
      {status && <span className="dp-t3 dp-sm">{status}</span>}
    </div>
  );
}

export default function TeamPack() {
  const [mode, setMode] = useState<'export' | 'import' | null>(null);
  const pick = (m: 'export' | 'import') => setMode(mode === m ? null : m);
  return (
    <div className="dp-box dp-pack">
      <div className="dp-pack-top">
        <span className="dp-t2 dp-grow">Share personas, skills, the team config and the feature-flag provider with teammates as a zip. Personal keys (owner, paths) never leave; on import they stay yours.</span>
        <span className="dp-row dp-g6">
          <button type="button" className={`dp-btn dp-sm${mode === 'export' ? ' dp-on' : ''}`} aria-pressed={mode === 'export'} onClick={() => pick('export')}><Icon name="download" size={12} />Export</button>
          <button type="button" className={`dp-btn dp-sm${mode === 'import' ? ' dp-on' : ''}`} aria-pressed={mode === 'import'} onClick={() => pick('import')}><Icon name="upload" size={12} />Import</button>
        </span>
      </div>
      {mode === 'export' && <ExportPanel />}
      {mode === 'import' && <ImportPanel />}
    </div>
  );
}
