import { useMemo, useState } from 'react';
import { errorMessage } from '../api.ts';
import { pendingClass } from '../components/action.ts';
import { useConfig } from '../config.ts';
import type { Artifact } from '../types.ts';
import Icon from './Icon.tsx';
import Modal from './Modal.tsx';
import { Empty, ErrorNote } from './pages/Page.tsx';
import { prKey, prTitle } from './data.ts';
import type { PreviewData } from './data.ts';
import { ago, stamp } from './format.ts';
import './artifacts.css';

type Sort = 'name' | 'newest';

const size = (a: Artifact) => (a.isDir ? `${a.files.length} files` : a.size < 1024 ? `${a.size} B` : `${Math.round(a.size / 1024)} kB`);
const browsable = (a: Artifact) => !a.isDir || a.url.endsWith('index.html');

function ImportArtifact({ d, onClose, onDone }: { d: PreviewData; onClose: () => void; onDone: (msg: string) => void }) {
  const kitKinds = useConfig((s) => s.kitKinds);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [pr, setPr] = useState('');
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await d.work.importArtifact({ path: path.trim(), label: label.trim(), ...(pr ? { pr } : {}), ...(kind ? { kind } : {}) });
      onDone(`Imported ${r.name}${r.headSha ? ` for head ${r.headSha.slice(0, 10)}` : ''}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Import an artifact from disk"
      wide
      busy={busy}
      onClose={onClose}
      foot={<>
        <button type="button" className="dp-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="dp-af-import" className={`dp-btn dp-primary${pendingClass(busy)}`} disabled={!path.trim() || busy}><Icon name="upload" size={14} />Import</button>
      </>}
    >
      <form id="dp-af-import" className="dp-af-form" onSubmit={(e) => { e.preventDefault(); if (path.trim() && !busy) void run(); }}>
        <p className="dp-keep-lead">Copies a file or folder into this work so it outlives the scratch folder. Allowed roots come from <code>importRoots</code> in the config (default /tmp and ~/.paseo/worktrees).</p>
        <label className="dp-af-field"><span>Path</span><input className="dp-inp" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/tmp/pr-review" autoFocus /></label>
        <label className="dp-af-field"><span>Label <i className="dp-t4">optional, names the copy</i></span><input className="dp-inp" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="pr-review" /></label>
        <div className="dp-af-pair">
          <label className="dp-af-field" title="The PR head this file was made for"><span>PR</span>
            <select className="dp-inp" value={pr} onChange={(e) => setPr(e.target.value)}>
              <option value="">No PR</option>
              {d.prs.filter((p) => p.number).map((p) => <option key={prKey(p)} value={String(p.number)}>#{p.number} {prTitle(p)}</option>)}
            </select>
          </label>
          <label className="dp-af-field" title="Kit piece: its freshness shows on the PR card"><span>Kit piece</span>
            <select className="dp-inp" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Not a kit piece</option>
              {kitKinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </form>
    </Modal>
  );
}

function Actions({ name, url, onView }: { name: string; url?: string; onView: (name: string) => void }) {
  return (
    <span className="dp-row dp-g4 dp-af-act">
      <button type="button" className="dp-btn dp-sm" title="Open in a preview tab" onClick={() => onView(name)}><Icon name="eye" size={12} />View</button>
      {url && <a className="dp-btn dp-sm dp-ghost" href={url} target="_blank" rel="noreferrer" title="Open in a new browser tab"><Icon name="external-link" size={12} />Open</a>}
    </span>
  );
}

export default function ArtifactsView({ d, onView }: { d: PreviewData; onView: (name: string) => void }) {
  const [sort, setSort] = useState<Sort>('name');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState('');
  const all = d.work.w?.artifacts || [];
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (a: Artifact) => !needle || a.name.toLowerCase().includes(needle) || a.files.some((f) => f.toLowerCase().includes(needle));
    const rows = all.filter(hit);
    return sort === 'newest' ? [...rows].sort((a, b) => (a.mtime < b.mtime ? 1 : -1)) : rows;
  }, [all, q, sort]);
  const prOf = (pr: string | null) => (pr ? d.prs.find((p) => prKey(p) === pr || String(p.number) === pr) : undefined);

  return (
    <div className="dp-af">
      <div className="dp-vbar">
        <span className="dp-title">Artifacts</span>
        <span className="dp-count">{all.length}</span>
        <div className="dp-filters">
          <button type="button" className={sort === 'name' ? 'dp-on' : 'dp-off'} onClick={() => setSort('name')}>By name</button>
          <button type="button" className={sort === 'newest' ? 'dp-on' : 'dp-off'} onClick={() => setSort('newest')}>Newest</button>
        </div>
        <span className="dp-sp" />
        {status && <span className="dp-xs dp-t3 dp-ell">{status}</span>}
        <span className="dp-af-q">
          <Icon name="search" size={12} />
          <input className="dp-inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter artifacts" />
        </span>
        <button type="button" className="dp-btn dp-sm" title="Copy a file or folder from disk into this work" onClick={() => { setStatus(''); setImporting(true); }}><Icon name="upload" size={12} />Import from disk…</button>
      </div>
      {importing && <ImportArtifact d={d} onClose={() => setImporting(false)} onDone={(msg) => { setImporting(false); setStatus(msg); }} />}
      <div className="dp-doc">
        <div className="dp-doc-in">
          {!all.length ? (
            <Empty icon="folder">No artifacts yet. Import review pages, briefs or demo clips from disk so they outlive the scratch folders.</Empty>
          ) : !list.length ? (
            <Empty icon="search">No artifact matches “{q}”.</Empty>
          ) : (
            <div className="dp-rows">
              {list.map((a) => {
                const pr = prOf(a.meta?.pr ?? null);
                return (
                  <div key={a.name} className="dp-af-item">
                    <div className="dp-rowi dp-af-row">
                      <Icon name={a.isDir ? 'folder' : 'file'} size={14} />
                      {browsable(a) ? (
                        <button type="button" className="dp-af-name dp-ell" title={a.name} onClick={() => onView(a.name)}>{a.name}</button>
                      ) : (
                        <span className="dp-af-name dp-af-dir dp-ell" title={a.name}>{a.name}</span>
                      )}
                      {a.meta?.kind && <span className="dp-chip dp-acc" title={a.meta.headSha ? `Made for head ${a.meta.headSha.slice(0, 10)}` : undefined}>{a.meta.kind}</span>}
                      {a.meta?.pr && <span className="dp-chip" title={pr ? prTitle(pr) : undefined}>#{a.meta.pr}</span>}
                      <span className="dp-sp" />
                      <span className="dp-xs dp-t3 dp-num dp-af-meta" title={stamp(a.mtime)}>{size(a)} · {ago(a.mtime)}</span>
                      {browsable(a) ? <Actions name={a.name} url={a.url} onView={onView} /> : <span className="dp-af-act" />}
                    </div>
                    {!browsable(a) && [...a.files].sort().reverse().map((f) => (
                      <div key={f} className="dp-rowi dp-af-row dp-af-sub">
                        <Icon name="file" size={12} />
                        <button type="button" className="dp-af-name dp-mono dp-ell" title={f} onClick={() => onView(`${a.name}/${f}`)}>{f}</button>
                        <span className="dp-sp" />
                        <Actions name={`${a.name}/${f}`} url={`${a.url}/${encodeURIComponent(f)}`} onView={onView} />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
