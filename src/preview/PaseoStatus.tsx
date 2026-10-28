import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { subscribe, topic } from '../live.ts';
import { useConfig } from '../config.ts';
import { toast } from '../components/Toast.tsx';
import { confirmDialog } from '../components/Dialogs.tsx';
import Icon from './Icon.tsx';
import { ago } from './format.ts';
import type { PaseoHealth, ProviderHealth } from '../types.ts';

const STATE: Record<PaseoHealth['state'], string> = { connected: 'connected', reconnecting: 'reconnecting…', down: 'down' };
const isOut = (p: ProviderHealth) => p.enabled && p.status !== 'ready' && p.status !== 'loading';

// the Paseo daemon as coco's bridge sees it (server/paseo-health.ts), live on topic `paseo`
function usePaseoHealth() {
  const [health, setHealth] = useState<PaseoHealth | null>(null);
  useEffect(() => subscribe(topic('paseo'), { message: (d: PaseoHealth) => setHealth(d) }), []);
  return [health, setHealth] as const;
}

function Provider({ p }: { p: ProviderHealth }) {
  const out = isOut(p);
  const tone = !p.enabled ? '' : out ? (p.status === 'error' ? 'dp-bad' : 'dp-warn') : 'dp-ok';
  return (
    <div className="dp-mi dp-paseo-pv" title={p.diagnostic || undefined}>
      <span className={`dp-chip ${tone}`}><span className="dp-d" />{p.enabled ? p.status : 'disabled'}</span>
      <span className="dp-ell">{p.label}</span>
      {out && p.reason && <span className="dp-r dp-ell">{p.reason}</span>}
    </div>
  );
}

// "Paseo" in the status bar: a green dot while coco's bridge is connected, amber reconnecting, red down or a provider coco uses out;
// its popover lists the providers and restarts the daemon or has it look at the providers again
export default function PaseoStatus() {
  const [health, setHealth] = usePaseoHealth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'refresh' | null>(null);
  const models = useConfig((s) => s.models);
  if (!health) return null;

  const used = new Set(Object.values(models).filter(Boolean).map((m) => String(m).split('/')[0]));
  const usedOut = health.providers.filter((p) => used.has(p.id) && isOut(p));
  const up = health.state === 'connected';
  const tone = health.restarting || health.state === 'reconnecting' ? 'dp-warn' : !up ? 'dp-bad' : usedOut.length ? 'dp-warn' : 'dp-ok';
  const label = health.restarting ? 'Restarting Paseo…' : !up ? `Paseo ${STATE[health.state]}` : usedOut.length ? `Paseo · ${usedOut.map((p) => p.label).join(', ')} ${usedOut.length > 1 ? 'are' : 'is'} out` : 'Paseo';

  const restart = async () => {
    const ok = await confirmDialog({ title: 'Restart the Paseo daemon?', body: 'Runs paseo daemon restart. Running agents lose their turn in flight; coco reconnects by itself once the daemon is back.', ok: 'Restart', danger: true });
    if (!ok) return;
    try {
      setHealth(await api.restartPaseo());
    } catch (e) {
      toast.error(`Restart failed: ${errorMessage(e)}`);
    }
  };
  const refresh = async () => {
    setBusy('refresh');
    try {
      setHealth(await api.refreshPaseoProviders());
    } catch (e) {
      toast.error(`Refresh failed: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <span className={`dp-sbi dp-paseo-sbi ${tone}`} title={up ? `Paseo ${health.version || ''} · connected ${ago(health.since)}` : health.reason || ''} onClick={() => setOpen(!open)}>
        {health.restarting || health.state === 'reconnecting' ? <Icon name="refresh" className="dp-spin" /> : <span className="dp-dot dp-lg" />}
        {label}
      </span>
      {open && (
        <div className="dp-pop dp-on dp-paseopop">
          <div className="dp-pop-h">
            <b>Paseo daemon</b>
            <span className={`dp-chip ${tone}`}><span className="dp-d" />{health.restarting ? 'restarting…' : STATE[health.state]}</span>
            {health.version && <span className="dp-xs dp-t3">v{health.version}</span>}
            <span className="dp-sp" />
            <button type="button" className="dp-ibtn" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button>
          </div>
          {(!up || health.restartError) && (
            <div className="dp-pop-s dp-paseo-why">
              {!up && <div>{health.reason || 'not connected'}{health.nextRetryAt ? ` · next try ${new Date(health.nextRetryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}</div>}
              {health.restartError && <div className="dp-paseo-bad">Restart failed: {health.restartError}</div>}
            </div>
          )}
          <div className="dp-pop-s">
            <div className="dp-paseo-sub dp-xs dp-t3">Providers{health.providersAt ? ` · checked ${ago(health.providersAt)}` : ''}</div>
            {health.providers.length ? health.providers.map((p) => <Provider key={p.id} p={p} />) : <div className="dp-mi dp-t3">{up ? 'loading…' : 'unknown while Paseo is not connected'}</div>}
          </div>
          <div className="dp-pop-s dp-paseo-acts">
            <button type="button" className="dp-btn dp-sm" disabled={!up || busy === 'refresh'} onClick={refresh}><Icon name="refresh" size={12} className={busy === 'refresh' ? 'dp-spin' : undefined} />Refresh providers</button>
            <button type="button" className="dp-btn dp-sm dp-danger" disabled={health.restarting} onClick={restart}><Icon name="refresh" size={12} />Restart Paseo daemon</button>
          </div>
        </div>
      )}
    </>
  );
}
