import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import type { Overview } from '../types.ts';

// archived works, per repo; they are out of the sidebar, here they stay reachable and can come back
export default function Archive() {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const load = () => api.overview().then(setData).catch((e) => setErr(errorMessage(e)));
  useEffect(() => {
    load();
  }, []);
  if (err) return <div className="card danger">{err}</div>;
  if (!data) return <div className="sub">Loading…</div>;
  const bySlug = new Map(data.works.map((w) => [w.slug, w]));
  const unarchive = (slug: string) => api.archiveWork(slug, false).then(load, (e) => toast.error(errorMessage(e)));
  const groups = data.repos.map((r) => ({ ...r, archived: r.works.map((s) => bySlug.get(s)).filter((w) => w?.archived) }));
  return (
    <>
      <h1>Archive</h1>
      {groups.every((g) => !g.archived.length) && <div className="card"><span className="sub">No archived work.</span></div>}
      {groups.filter((g) => g.archived.length).map((g) => (
        <section key={g.id}>
          <h2>{g.name}</h2>
          <div className="grid">
            {g.archived.map((w) => w && (
              <div key={w.slug} className="card">
                <a href={`#/work/${w.slug}`}><b>{w.title}</b></a>
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="chip c-grey">archived {w.archived?.reason === 'auto' ? 'automatically' : 'by hand'} {w.archived?.at.slice(0, 10)}</span>
                  <span className="status">{w.stack} PRs</span>
                  <button className="sm" onClick={() => unarchive(w.slug)}>Unarchive</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
