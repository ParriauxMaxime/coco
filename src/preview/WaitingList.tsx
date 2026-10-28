import React from 'react';
import PermissionCard, { usePendingPermissions } from './chat/Permission.tsx';
import Icon from './Icon.tsx';
import type { WaitingItem } from '../types.ts';
import './chat/chat.css';

const KIND: Record<WaitingItem['kind'], string> = { card: 'question', permission: 'permission', approve: 'approve', thread: 'your word', ask: 'your word', agent: 'done' };

// items of the waiting queue in a popover, a tab or a page section: a Paseo permission is answered in place, anything else opens where it is asked
export default function WaitingList({ items, empty }: { items: WaitingItem[]; empty?: React.ReactNode }) {
  const { pending } = usePendingPermissions();
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <div className="dp-perms">
      {items.map((i) => {
        const p = i.kind === 'permission' ? pending.find((x) => `perm:${x.agentId}:${x.request.id}` === i.id) : null;
        if (p) return <PermissionCard key={i.id} agentId={p.agentId} request={p.request} where={{ label: [p.agentTitle, p.where?.label].filter(Boolean).join(' · ') || p.agentId.slice(0, 8), href: i.link }} />;
        return (
          <a key={i.id} className="dp-wl-row" href={i.link} title={i.excerpt || i.title}>
            <span className="dp-chip dp-warn">{KIND[i.kind]}</span>
            <span className="dp-wl-b">
              <b className="dp-ell">{i.title}</b>
              {i.excerpt && <span className="dp-ell dp-t3">{i.excerpt}</span>}
            </span>
            {i.diagrams ? <span className="dp-chip dp-info">{i.diagrams === 1 ? '1 diagram' : `${i.diagrams} diagrams`}</span> : null}
            <Icon name="chevron-right" size={12} />
          </a>
        );
      })}
    </div>
  );
}
