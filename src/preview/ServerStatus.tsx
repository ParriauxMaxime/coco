import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import Icon from './Icon.tsx';
import type { ServerInfo } from '../types.ts';

const POLL_MS = 60000;
const BACK_POLL_MS = 2000;
const BACK_WITHIN_MS = 180000;

// the coco commit this server runs; once main moved past it, a restart one click away
export default function ServerStatus() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    const load = () => api.server().then(setInfo, () => {});
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);
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
    const wait = () => api.server().then((s) => (s.startedAt !== info.startedAt ? location.reload() : retry()), retry);
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
