import React, { useState } from 'react';
import Collapsible from '../../components/Collapsible.tsx';
import { useWork } from '../use-work.ts';
import { useWorkbench } from '../workbench-store.ts';
import { useConfig } from '../../config.ts';

export default function Artifacts({ group }) {
  const { w, prs, importArtifact } = useWork();
  const open = useWorkbench((s) => s.open);
  const kitKinds = useConfig((s) => s.kitKinds);
  const [importPath, setImportPath] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const [pr, setPr] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const run = async () => {
    setStatus('importing…');
    try { const r = await importArtifact({ path: importPath, label: importLabel, ...(pr ? { pr } : {}), ...(kind ? { kind } : {}) }); setStatus(`imported ${r.name}${r.headSha ? ` for head ${r.headSha.slice(0, 10)}` : ''}`); setImportPath(''); setImportLabel(''); } catch (e) { setStatus(e.message); }
  };
  return (
    <>
      {w.artifacts.map((a) => (
        <React.Fragment key={a.name}>
          <div className="list-item row" style={{ justifyContent: 'space-between' }}><span><b>{a.name}</b> <span className="status">{a.isDir ? `${a.files.length} files` : `${Math.round(a.size / 1024)} kB`} · {a.mtime.slice(0, 10)}</span></span>{!(a.isDir && !a.url.endsWith('index.html')) && <span className="row"><button className="sm" onClick={() => open(`artifact-${a.name}`, { preview: true, group })}>view ▸</button><a href={a.url} target="_blank" rel="noreferrer"><button className="sm">open</button></a></span>}</div>
          {a.isDir && !a.url.endsWith('index.html') && [...a.files].sort().reverse().map((f) => <div key={f} className="list-item row" style={{ justifyContent: 'space-between', paddingLeft: 16 }}><code>{f}</code><button className="sm" onClick={() => open(`artifact-${a.name}/${f}`, { preview: true, group })}>view ▸</button></div>)}
        </React.Fragment>
      ))}
      <Collapsible title="Import from disk">
        <p className="sub">Allowed roots: set by <code>importRoots</code> in the config (default /tmp, ~/.paseo/worktrees).</p>
        <input style={{ width: '100%', marginBottom: 6 }} value={importPath} onChange={(e) => setImportPath(e.target.value)} placeholder="/tmp/pr-review" />
        <div className="row" style={{ flexWrap: 'wrap' }}><input value={importLabel} onChange={(e) => setImportLabel(e.target.value)} placeholder="label (optional)" />
          <select value={pr} onChange={(e) => setPr(e.target.value)} title="The PR head this file was made for"><option value="">no PR</option>{prs.filter((p) => p.number).map((p) => <option key={p.number} value={p.number}>#{p.number}</option>)}</select>
          <select value={kind} onChange={(e) => setKind(e.target.value)} title="Kit piece: its freshness shows on the PR card"><option value="">not a kit piece</option>{kitKinds.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <button className="primary sm" disabled={!importPath} onClick={run}>Import</button><span className="status">{status}</span></div>
      </Collapsible>
    </>
  );
}
