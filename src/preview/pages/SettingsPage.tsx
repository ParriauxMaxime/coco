import React, { useCallback, useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { devicesApi, errorMessage } from '../../api.ts';
import type { DeviceView, DevicesResponse } from '../../api.ts';
import { ask, confirmDialog } from '../../components/Dialogs.tsx';
import { toast } from '../../components/Toast.tsx';
import Icon from '../Icon.tsx';
import { BetaChoices } from '../BetaPanel.tsx';
import { NAV_MODES, usePrefs } from '../prefs.ts';
import { ago } from '../format.ts';
import { Empty, ErrorNote, Loading, Page, PageHead, Section } from './Page.tsx';
import './settings.css';

const POLL_MS = 3000;

// dark modules on white whatever the theme: phone cameras read that best
function Qr({ text }: { text: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const size = q.getModuleCount();
    let path = '';
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { n: size, d: path };
  }, [text]);
  return (
    <svg className="dp-dev-qr" viewBox={`-4 -4 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <rect x={-4} y={-4} width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

function useCountdown(until: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : 0;
}

// while a code waits, the list is read again: a new device there means the code was used
function Pairing({ origins, apk, count, refresh }: { origins: string[]; apk: boolean; count: number; refresh: () => void }) {
  const [origin, setOrigin] = useState(origins[0]);
  const [withApk, setWithApk] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const left = useCountdown(code?.expiresAt ?? null);
  const live = code && left > 0;
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [live, refresh]);
  useEffect(() => setCode(null), [count]);
  const url = code ? `${origin}/pair?code=${code.code}${withApk ? '&then=apk' : ''}` : '';
  const make = () => devicesApi.code().then(setCode, (e) => toast.error(errorMessage(e)));
  if (!origins.length) {
    return (
      <div className="dp-dev-hint">
        No address a phone can reach coco under yet. Expose coco on your tailnet (<code>tailscale serve --bg --https=443 http://127.0.0.1:8777</code>), add its
        name, e.g. <code>mac.tailnet.ts.net</code>, to <code>hosts</code> in coco.config.json, then restart coco.
      </div>
    );
  }
  return (
    <div className="dp-dev-pair">
      <div className="dp-row dp-g8 dp-dev-ctl">
        {origins.length > 1 && (
          <select className="dp-inp" value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Address the phone opens">
            {origins.map((o) => <option key={o} value={o}>{o.replace(/^https?:\/\//, '')}</option>)}
          </select>
        )}
        {apk && <label className="dp-dev-apk"><input type="checkbox" checked={withApk} onChange={(e) => setWithApk(e.target.checked)} />then download the Android app</label>}
        <button type="button" className="dp-btn dp-primary" onClick={make}><Icon name="smartphone" size={14} />{live ? 'New code' : 'Pair a phone'}</button>
      </div>
      {live && (
        <div className="dp-dev-code">
          <Qr text={url} />
          <div className="dp-dev-codeb">
            <span className="dp-t2">Scan with the phone's camera or the coco app, or open:</span>
            <code className="dp-dev-url">{url}</code>
            <span className="dp-dev-big">{code.code}</span>
            <span className="dp-xs dp-t3">One use, expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>
          </div>
        </div>
      )}
      {code && !live && <span className="dp-sm dp-t3">That code expired. Make a new one.</span>}
    </div>
  );
}

function DeviceRow({ d, onChange }: { d: DeviceView; onChange: () => void }) {
  const rename = async () => {
    const v = await ask({ title: 'Rename device', fields: [{ placeholder: 'Name', initial: d.name }], ok: 'Rename' });
    if (v?.[0]?.trim()) devicesApi.rename(d.id, v[0]).then(onChange, (e) => toast.error(errorMessage(e)));
  };
  const revoke = async () => {
    if (await confirmDialog({ title: `Revoke ${d.name}?`, body: 'It loses access at once and has to be paired again.', ok: 'Revoke', danger: true })) devicesApi.revoke(d.id).then(onChange, (e) => toast.error(errorMessage(e)));
  };
  return (
    <div className="dp-rowi">
      <Icon name="smartphone" size={16} />
      <span className="dp-rowi-b">
        <span className="dp-ell">{d.name}</span>
        <span className="dp-t3">paired {new Date(d.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })} · seen {ago(d.lastSeen)}{ago(d.lastSeen) === 'now' ? '' : ' ago'}</span>
      </span>
      <span className="dp-row dp-g4">
        <button type="button" className="dp-ibtn" title="Rename" onClick={rename}><Icon name="pencil" size={14} /></button>
        <button type="button" className="dp-btn dp-danger" onClick={revoke}>Revoke</button>
      </span>
    </div>
  );
}

function Devices() {
  const [data, setData] = useState<DevicesResponse | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => devicesApi.list().then(setData, (e) => setError(errorMessage(e))), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <Section id="settings-devices" title="Devices"><ErrorNote>{error}</ErrorNote></Section>;
  if (!data) return <Section id="settings-devices" title="Devices"><Loading /></Section>;
  return (
    <Section id="settings-devices" title="Devices" count={data.devices.length} meta="phones that reach coco through tailscale serve or another proxy">
      <p className="dp-dev-lead">Anything but this Mac needs a paired device to open coco. A code pairs one device, and revoking one cuts it off at once.</p>
      <Pairing origins={data.origins} apk={data.apk} count={data.devices.length} refresh={load} />
      {data.devices.length ? <div className="dp-rows">{data.devices.map((d) => <DeviceRow key={d.id} d={d} onChange={load} />)}</div> : <Empty icon="smartphone">No paired device.</Empty>}
    </Section>
  );
}

function Beta() {
  const nav = usePrefs((s) => s.nav);
  const set = usePrefs((s) => s.set);
  return (
    <Section id="settings-beta" title="Beta" meta="kept in this browser · also under ⌘.">
      <div className="dp-beta-nav" role="radiogroup" aria-label="Navigation">
        {NAV_MODES.map((m) => (
          <label key={m.value} className={`dp-beta-opt${nav === m.value ? ' dp-on' : ''}`}>
            <input type="radio" name="nav" checked={nav === m.value} onChange={() => set('nav', m.value)} />
            <span className="dp-beta-optb"><b>{m.label}{m.value === 'classic' ? <span className="dp-xs dp-t3"> · default</span> : null}</b><span className="dp-t3">{m.hint}</span></span>
          </label>
        ))}
      </div>
      <p className="dp-dev-lead">Drill, Expand and Columns cover the sidebar, a work's Overview, Stack, Findings and Decisions, and threads. A mode too wide for the window opens as Drill.</p>
      <div className="dp-beta-more"><BetaChoices skip="nav" /></div>
    </Section>
  );
}

// section: the part of the page to scroll to (#/settings/beta, which the desktop app's View > Beta… opens)
export default function SettingsPage({ section }: { section?: string }) {
  useEffect(() => {
    if (section) document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
  }, [section]);
  return (
    <Page>
      <PageHead icon="wrench" title="Settings" />
      <Beta />
      <Devices />
    </Page>
  );
}
