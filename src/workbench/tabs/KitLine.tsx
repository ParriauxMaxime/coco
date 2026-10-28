import React, { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { subscribe, topic } from '../../live.ts';
import type { KitPiece, KitResponse } from '../../types.ts';
import type { PrKey } from '../types.ts';
import { pendingClass, useAction } from '../../components/action.ts';
import '../../components/parts.css';

const POLL_MS = 60000;
const CHIP: Record<string, string> = { fresh: 'dp-ok', stale: 'dp-warn', missing: '', present: 'dp-info' };
const tip = (p: KitPiece, head: KitResponse['head']) => [p.source && `from ${p.source}`, p.madeFor && `made for ${p.madeFor.slice(0, 10)}`, p.at && `at ${p.at.slice(0, 16).replace('T', ' ')}`, head?.sha && `head ${head.sha.slice(0, 10)}${head.at ? ` (${head.at.slice(0, 16).replace('T', ' ')})` : ''}`].filter(Boolean).join(' · ');

// kit pieces of a PR against its head: stale once the head moved after they were made
export default function KitLine({ slug, n }: { slug: string; n: PrKey }) {
  const [data, setData] = useState<KitResponse | null>(null);
  useEffect(() => {
    const load = () => api.kit(slug, n).then(setData, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    let soon: ReturnType<typeof setTimeout>;
    const off = subscribe(topic('work', slug), { message: () => { clearTimeout(soon); soon = setTimeout(load, 50); } });
    return () => { clearInterval(t); clearTimeout(soon); off(); };
  }, [slug, n]);
  const { pending, busy, run } = useAction();
  const pieces = data?.pieces.filter((p) => p.id !== 'notion' || p.state !== 'off') || [];
  const betas = data?.betaFlags || [];
  if (!pieces.length && !betas.length) return null;
  const scope = data?.scope ? `scoped by ${data.scope.by === 'agent' ? 'the review plan' : 'you'}${data.scope.why ? `: ${data.scope.why}` : ''}` : 'not scoped yet: the body alone counts';
  const flip = (p: KitPiece) => run(p.id, async () => setData(await api.kitScope(slug, n, { [p.id]: !p.expected })));
  return (
    <>
      {pieces.length > 0 && (
        <div className="dp-kl">
          <span className="dp-kl-t" title={scope}>Kit</span>
          {pieces.map((p) => (p.id === 'notion'
            ? <span key={p.id} className={`dp-chip ${CHIP[p.state]}`} title={data ? tip(p, data.head) : undefined}>{p.label}</span>
            : <button key={p.id} type="button" className={`dp-chip dp-kl-p ${p.expected ? CHIP[p.state] : 'dp-kl-out'}${pendingClass(pending === p.id)}`} disabled={busy} title={[p.expected ? 'in scope' : 'not needed for this PR', data && tip(p, data.head), `${scope}. Click to ${p.expected ? 'drop it from' : 'add it to'} the scope`].filter(Boolean).join(' · ')} onClick={() => flip(p)}>
                {p.expected ? '' : '+ '}{p.label}{!p.expected || p.state === 'fresh' || p.state === 'present' ? '' : ` ${p.state}`}
              </button>))}
        </div>
      )}
      {betas.length > 0 && (
        <div className="dp-kl">
          <span className="dp-kl-t" title="feature flags to turn on when testing this PR">Feature flags</span>
          {betas.map((f) => <span key={f.code} className={`dp-chip ${f.inBody ? 'dp-ok' : 'dp-warn'}`} title={[f.name, f.why, f.enable, f.inBody ? 'named in the PR body' : 'not named in the PR body yet'].filter(Boolean).join(' · ')}>{f.code}{f.mode ? ` · ${f.mode}` : ''}{f.inBody ? '' : ' · not in body'}</span>)}
        </div>
      )}
    </>
  );
}
