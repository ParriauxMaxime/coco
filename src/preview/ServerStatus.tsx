import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { reloadNow, reloadWhenSafe, sawBuild, useUpdates } from '../updates.ts';
import Icon from './Icon.tsx';
import type { ServerInfo } from '../types.ts';

const POLL_MS = 60000;
const BACK_POLL_MS = 2000;
const BACK_WITHIN_MS = 180000;

// the coco commit this server runs; once main moved past it, a restart one click away. While the server is away: reconnecting;
// once it serves a new build and a box holds unsent text: the reload, a click away (src/updates.ts)
export default function ServerStatus() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const { offline, stale } = useUpdates();
  useEffect(() => {
    const load = () => api.server().then((s) => {
      setInfo(s);
      sawBuild(s.build);
    }, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);
  if (offline) return <span className="dp-sbi dp-t3" title="coco's server does not answer (a restart or a rebuild): the page reconnects by itself"><Icon name="refresh" className="dp-spin" />Reconnecting…</span>;
  if (stale) return <span className="dp-sbi dp-wait" title="coco runs a new build: reload onto it (layout, tabs and unsent drafts are kept)" onClick={reloadNow}><Icon name="refresh" />coco updated · Reload</span>;
  if (!info?.running) return null;

  const restart = async () => {
    setRestarting(true);
    try {
      await api.restartServer();
    } catch (e) {
      setRestarting(false);
      return void toast.error(`Restart failed: ${errorMessage(e)}`);
    }
    const until = Date.now() + BACK_WITHIN_MS;
    const wait = () => api.server().then((s) => (s.startedAt !== info.startedAt ? reloadWhenSafe() : retry()), retry);
    const retry = () => (Date.now() < until ? void setTimeout(wait, BACK_POLL_MS) : (setRestarting(false), void toast.error('coco did not come back: see server-restart.log in the data dir')));
    setTimeout(wait, BACK_POLL_MS);
  };

  const sha = info.running.slice(0, 7);
  if (!info.behind) return <span className="dp-sbi dp-t3" title={`coco runs ${info.running}${info.dirty ? ' with uncommitted changes' : ''}`}>coco {sha}{info.dirty ? '*' : ''}</span>;
  return (
    <span className="dp-sbi dp-wait" title={`coco runs ${info.running}; the checkout is at ${info.head}`} onClick={restarting ? undefined : restart}>
      <Icon name="refresh" className={restarting ? 'dp-spin' : undefined} />
      {restarting ? 'Restarting coco…' : `coco ${sha} is ${info.behind} commit${info.behind > 1 ? 's' : ''} behind · Restart`}
    </span>
  );
}
