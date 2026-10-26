import React from 'react';
import { setThemeMode, useTheme } from '../theme.ts';
import Icon from './Icon.tsx';
import { CHOICES, useBetaPanel, usePrefs } from './prefs.ts';

export default function BetaPanel() {
  const prefs = usePrefs();
  const theme = useTheme();
  const close = useBetaPanel((s) => s.close);
  return (
    <div className="dp-ctl">
      <div className="dp-row"><b>Beta features</b><span className="dp-sp" /><span className="dp-xs dp-t3">kept in this browser</span><button type="button" className="dp-ibtn" title="Hide  ⌘." onClick={close}><Icon name="x" size={14} /></button></div>
      <div className="dp-ctl-sub">
        <div className="dp-xs dp-t3">Design choices · • = recommended</div>
        {CHOICES.map((c) => (
          <div key={c.key} className="dp-ctl-row">
            <span className="dp-t2">{c.label}</span>
            <div className="dp-seg">
              {c.options.map((o) => <button key={o.value} type="button" className={prefs[c.key] === o.value ? 'dp-on' : ''} onClick={() => prefs.set(c.key, o.value)}>{o.label}{o.rec ? ' •' : ''}</button>)}
            </div>
          </div>
        ))}
      </div>
      <div className="dp-ctl-row">
        <span className="dp-t2">Theme</span>
        <div className="dp-seg">
          {(['light', 'dark', 'system'] as const).map((m) => <button key={m} type="button" className={theme.mode === m ? 'dp-on' : ''} onClick={() => setThemeMode(m)}>{m}</button>)}
        </div>
      </div>
    </div>
  );
}
