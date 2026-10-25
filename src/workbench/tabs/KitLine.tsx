import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import type { KitPiece, KitResponse } from '../../types.ts';
import type { PrKey } from '../types.ts';
const POLL_MS = 60000;
const CHIP: Record<string, string> = { fresh: 'c-green', stale: 'c-orange', missing: 'c-grey', present: 'c-blue' };
const tip = (p: KitPiece, head: KitResponse['head']) => [p.source && `from ${p.source}`, p.madeFor && `made for ${p.madeFor.slice(0, 10)}`, p.at && `at ${p.at.slice(0, 16).replace('T', ' ')}`, head?.sha && `head ${head.sha.slice(0, 10)}${head.at ? ` (${head.at.slice(0, 16).replace('T', ' ')})` : ''}`].filter(Boolean).join(' · ');

// kit pieces of a PR against its head: stale once the head moved after they were made
export default function KitLine({ slug, n }: { slug: string; n: PrKey }) {
  const [data, setData] = useState<KitResponse | null>(null);  useEffect(() => {
    const load = () => api.kit(slug, n).then(setData, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [slug, n]);
  const shown = data?.pieces.filter((p) => p.state !== 'off') || [];
  const betas = data?.betaFlags || [];
  if (!shown.length && !betas.length) return null;
  return (
    <>
      {shown.length > 0 && (
        <div className="row kit-line">
          <span className="status">kit:</span>
          {shown.map((p) => <span key={p.id} className={`chip ${CHIP[p.state]}`} title={data ? tip(p, data.head) : undefined}>{p.label}{p.state === 'fresh' || p.state === 'present' ? '' : ` ${p.state}`}</span>)}
        </div>
      )}
      {betas.length > 0 && (
        <div className="row kit-line">
          <span className="status" title="feature flags to turn on when testing this PR">feature flags:</span>
          {betas.map((f) => <span key={f.code} className={`chip ${f.inBody ? 'c-green' : 'c-orange'}`} title={[f.name, f.why, f.enable, f.inBody ? 'named in the PR body' : 'not named in the PR body yet'].filter(Boolean).join(' · ')}>{f.code}{f.mode ? ` · ${f.mode}` : ''}{f.inBody ? '' : ' · not in body'}</span>)}
        </div>
      )}
    </>
  );
}
