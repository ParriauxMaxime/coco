import React, { useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { toast } from '../components/Toast.tsx';
import { useResource } from '../resource.ts';
import Icon from './Icon.tsx';
import type { McpCheck, McpServers } from '../types.ts';

const POLL_MS = 60000;

// the MCP servers coco is configured with (config.mcpServers), and a Check that really runs one: its tools, or why it failed
export default function McpStatus() {
  const res = useResource<McpServers>('/api/mcp', api.mcp, { poll: POLL_MS });
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, McpCheck | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const servers = res.data?.servers ?? [];
  if (!servers.length) return null;
  const check = async (name: string, fresh: boolean) => {
    setBusy(name);
    try {
      const info = await api.checkMcp(name, fresh);
      setChecked((c) => ({ ...c, [name]: info.check }));
    } catch (e) {
      toast.error(`${name}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <span className="dp-sbi" title="MCP servers coco is configured with" onClick={() => setOpen((o) => !o)}>
        <Icon name="layers" />MCP {servers.length}
      </span>
      {open && (
        <div className="dp-pop dp-on dp-mcppop">
          <div className="dp-pop-h">
            <b>MCP servers</b>
            <span className="dp-count">{servers.length}</span>
            <span className="dp-sp" />
            <button type="button" className="dp-ibtn" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button>
          </div>
          <div className="dp-pop-s">
            {servers.map((s) => {
              const c = checked[s.name] === undefined ? s.check : checked[s.name];
              return (
                <div key={s.name} className="dp-mcp-row">
                  <div className="dp-mcp-h">
                    <b>{s.name}</b>
                    <span className="dp-tag">{s.type === 'stdio' ? 'local' : 'remote'}</span>
                    {s.onAsk && <span className="dp-tag dp-ok">Ask</span>}
                    {s.onNotion && <span className="dp-tag">Notion sync</span>}
                  </div>
                  <div className="dp-mcp-target" title={s.target}>{s.target}</div>
                  <div className="dp-mcp-state">
                    {c ? (c.ok ? <span className="dp-mcp-ok"><Icon name="check" size={12} />{c.tools.length} tool{c.tools.length === 1 ? '' : 's'}</span> : <span className="dp-mcp-bad" title={c.error ?? ''}>{c.error || 'no answer'}</span>) : <span className="dp-t3">not checked</span>}
                    <button type="button" className="dp-btn dp-ghost dp-sm" disabled={busy === s.name} onClick={() => check(s.name, Boolean(c))}>
                      {busy === s.name ? 'Checking…' : c ? 'Check again' : 'Check'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="dp-pop-t"><Icon name="file" size={12} />From <code>mcpServers</code> in coco.config.json (guide: Connectors on any provider)</div>
        </div>
      )}
    </>
  );
}
