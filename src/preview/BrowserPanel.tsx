import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useShownInterval } from '../resource.ts';
import type { BrowserTab } from '../api.ts';
import './browser.css';

// the tabs an agent keeps in coco's headless Chrome (coco hosting Paseo's browser while the app is closed), read every 10 s
export function useAgentBrowser(agentId: string) {
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const at = useRef(agentId);
  at.current = agentId;
  const load = () => api.agentBrowserTabs(agentId).then((r) => at.current === agentId && setTabs(r.tabs), () => {});
  useEffect(() => { void load(); }, [agentId]);
  useShownInterval(load, 10_000);
  return tabs;
}

// what the agent's tab shows, read-only, captured again every 3 s
export function BrowserPanel({ tabs }: { tabs: BrowserTab[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useShownInterval(() => setTick((t) => t + 1), 3000);
  const tab = tabs.find((t) => t.browserId === picked) ?? [...tabs].sort((a, b) => b.usedAt - a.usedAt)[0];
  if (!tab) return <div className="dp-empty">No browser tab open</div>;
  return (
    <div className="bw">
      <div className="bw-bar">
        {tabs.length > 1 && (
          <span className="dp-seg" role="tablist">
            {tabs.map((t, i) => <button key={t.browserId} type="button" role="tab" aria-selected={t === tab} className={t === tab ? 'dp-on' : ''} title={t.url} onClick={() => setPicked(t.browserId)}>{t.title || `Tab ${i + 1}`}</button>)}
          </span>
        )}
        <a className="bw-url dp-ell dp-sm dp-t2" href={tab.url} target="_blank" rel="noreferrer" title={tab.title}>{tab.url}</a>
      </div>
      <div className="bw-view">
        <img alt={tab.title || tab.url} src={`/api/browser/tabs/${tab.browserId}/shot?t=${tick}`} />
      </div>
    </div>
  );
}
