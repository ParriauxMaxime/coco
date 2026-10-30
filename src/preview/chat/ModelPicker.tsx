import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../../api.ts';
import Icon from '../Icon.tsx';
import { useModelList, useModelPicks } from '../prefs.ts';
import type { ModelPickPref } from '../prefs.ts';
import { latestModels, modelMark } from './model-view.ts';
import { toast } from '../../components/Toast.tsx';
import type { AgentMode, AgentModes, ModelCatalog, ModelChoice } from '../../types.ts';
import './model.css';

export type Choice = ModelPickPref;

const useCatalog = create<{ catalog: ModelCatalog | null; error: string | null; loading: boolean; load: () => void }>()((set, get) => ({
  catalog: null,
  error: null,
  loading: false,
  load: () => {
    if (get().catalog || get().loading) return;
    set({ loading: true });
    api.models().then((catalog) => set({ catalog, error: null, loading: false }), (e) => set({ error: errorMessage(e), loading: false }));
  },
}));

export function useModelCatalog() {
  const s = useCatalog();
  useEffect(() => { s.load(); }, []);
  return s;
}

const family = (p: string) => p.split('/')[0];
const idOf = (p: string) => p.split('/').slice(1).join('/');
export const modelOf = (catalog: ModelCatalog | null, provider: string | null | undefined) => {
  if (!catalog || !provider) return null;
  const id = idOf(provider);
  const models = catalog.providers.find((p) => p.id === family(provider))?.models ?? [];
  return models.find((m) => m.id === id) ?? models.find((m) => m.aliases.includes(id)) ?? null;
};
const sameChoice = (a: Choice | null, b: Choice | null) => a?.provider === b?.provider && (a?.thinking ?? null) === (b?.thinking ?? null);

// a composer's model and thinking: a live agent's own until picked (sent only once it differs), else the kind's last pick, else its default
export function useModelChoice(kind: string | null, { fast = false, live = false, current = null }: { fast?: boolean; live?: boolean; current?: Choice | null } = {}) {
  const { catalog } = useModelCatalog();
  const remembered = useModelPicks((s) => (kind ? s.picks[kind] : undefined));
  const [picked, setPicked] = useState<Choice | null>(null);
  const fallback = catalog ? { provider: fast ? catalog.defaults.fast : catalog.defaults.default, thinking: null } : null;
  const choice = live ? picked ?? current : picked ?? remembered ?? fallback;
  const pick = (c: Choice) => {
    setPicked(c);
    if (kind && !live) useModelPicks.getState().remember(kind, c);
  };
  const body = (): ModelChoice => {
    if (!choice || (live && (!picked || sameChoice(picked, current)))) return {};
    const provider = !live || picked?.provider !== current?.provider ? { provider: choice.provider } : {};
    return { ...provider, ...(choice.thinking ? { thinking: choice.thinking } : {}) };
  };
  return { choice, pick, body };
}

// an Ask conversation's pick: the kind's until it starts, then its agent's; a parked or closed one takes it to its next agent
export function useAskModel(run: { model?: string | null; thinking?: string | null; status?: string; agentId?: string | null } | null) {
  const { catalog } = useModelCatalog();
  const provider = run ? run.model || catalog?.defaults.default : null;
  const m = useModelChoice('ask', { live: Boolean(run), current: provider ? { provider, thinking: run?.thinking ?? null } : null });
  const later = run && !['idle', 'running'].includes(run.status || '');
  // its live agent, for the composer's slash commands and prompt recall
  const agentId = later ? null : run?.agentId ?? null;
  const mode = useLiveMode(agentId);
  const hint = !run ? 'for the agent this starts' : later ? 'applies to the next agent' : 'switches its agent from your next message';
  return { ...m, agentId, tools: <ModelControls choice={m.choice} onPick={m.pick} hint={hint} mode={mode} /> };
}

// a live agent's mode chip as a menu: its current mode from Paseo (read again on each open), a pick switches it at once
export function useLiveMode(agentId: string | null | undefined): ModePick | undefined {
  const [now, setNow] = useState<AgentModes | null>(null);
  const read = () => {
    if (agentId) api.agentModes(agentId).then(setNow, () => {});
  };
  useEffect(() => {
    setNow(null);
    read();
  }, [agentId]);
  if (!agentId || !now || now.archived || !now.modes.length) return undefined;
  const pick = (id: string | null) => {
    if (!id || id === now.mode) return;
    const was = now;
    setNow({ ...now, mode: id });
    api.setAgentMode(agentId, id).then(setNow, (e) => {
      setNow(was);
      toast.error(`Mode not changed: ${errorMessage(e)}`);
    });
  };
  return { value: now.mode, onPick: pick, live: true, modes: now.modes, defaultMode: now.defaultMode, onOpen: read };
}

const MODE_TITLE = 'Every coco agent runs in Paseo\'s auto mode: it works on its own, and a brief that says not to touch code is what keeps one read-only';

// the composer's model and thinking pickers, then the mode chip; hint says when a pick applies
// mode: a new agent's own pick among the provider's Paseo modes (null: the provider's default), instead of coco's fixed auto chip;
// live: a running agent's mode (modes: its own list), switched at once; lock: a live agent keeps its provider, so only that one's models are offered
type ModePick = { value: string | null; onPick: (id: string | null) => void; live?: boolean; modes?: AgentMode[]; defaultMode?: string | null; onOpen?: () => void };
export function ModelControls({ choice, onPick, hint, disabled = false, mode, lock = false }: { choice: Choice | null; onPick: (c: Choice) => void; hint: string; disabled?: boolean; mode?: ModePick; lock?: boolean }) {
  const { catalog, error } = useModelCatalog();
  const [open, setOpen] = useState<'model' | 'thinking' | 'mode' | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (!(e.target instanceof Node && box.current?.contains(e.target))) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(null); } };
    addEventListener('mousedown', away);
    addEventListener('keydown', esc, true);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const { all, toggle: toggleAll } = useModelList();
  const model = modelOf(catalog, choice?.provider);
  const kept = [model, modelOf(catalog, catalog?.defaults.default), modelOf(catalog, catalog?.defaults.fast)].flatMap((m) => (m ? [m.id] : []));
  const only = lock && choice ? family(choice.provider) : null;
  const offered = catalog?.providers.filter((p) => p.models.length && (!only || p.id === only)) ?? [];
  const providers = all ? offered : offered.map((p) => ({ ...p, models: latestModels(p.models, kept) }));
  const hidden = offered.reduce((n, p) => n + p.models.length, 0) - providers.reduce((n, p) => n + p.models.length, 0);
  const failed = error || catalog?.providers.map((p) => p.error && `${p.id}: ${p.error}`).filter(Boolean).join(' · ');
  const tag = (id: string) => (catalog?.defaults.default === id ? 'default' : catalog?.defaults.fast === id ? 'fast' : null);
  const level = (id: string | null | undefined) => model?.thinking.find((t) => t.id === id)?.label ?? id;
  const thinkingLabel = choice?.thinking ? level(choice.thinking) : model?.defaultThinking ? level(model.defaultThinking) : 'default';
  const entry = choice ? catalog?.providers.find((p) => p.id === family(choice.provider)) : null;
  const modes = mode ? mode.modes ?? entry?.modes ?? [] : [];
  const defaultMode = mode?.defaultMode !== undefined ? mode.defaultMode : entry?.defaultMode ?? null;
  const modeId = mode?.value ?? defaultMode;
  const shown = modes.find((m) => m.id === modeId);
  const toggle = (which: 'model' | 'thinking' | 'mode') => {
    if (which === 'mode' && open !== 'mode') mode?.onOpen?.();
    setOpen((o) => (o === which ? null : which));
  };
  const choose = (c: Choice) => {
    onPick(c);
    setOpen(null);
  };
  return (
    <span className="dp-mdl" ref={box}>
      <button type="button" className={`dp-btn dp-ghost dp-sm dp-mdl-btn${open === 'model' ? ' dp-on' : ''}`} disabled={disabled || !choice} aria-haspopup="menu" aria-expanded={open === 'model'} title={`Model: ${choice?.provider ?? 'loading…'}`} onClick={() => toggle('model')}>
        <Icon name={modelMark(choice?.provider ?? '', model?.label)} size={12} /><span className="dp-ell">{model?.label ?? (choice ? idOf(choice.provider) || choice.provider : 'model')}</span><Icon name="chevron-down" size={12} />
      </button>
      <button type="button" className={`dp-btn dp-ghost dp-sm dp-mdl-btn dp-mdl-th${open === 'thinking' ? ' dp-on' : ''}`} disabled={disabled || !choice} aria-haspopup="menu" aria-expanded={open === 'thinking'} title={`Thinking: ${choice?.thinking ?? 'the model default'}`} onClick={() => toggle('thinking')}>
        <Icon name="brain" size={12} /><span className="dp-mdl-v">{thinkingLabel}</span><Icon name="chevron-down" size={12} />
      </button>
      {mode && modes.length ? (
        <button type="button" className={`dp-btn dp-ghost dp-sm dp-mdl-btn dp-mdl-md${shown?.tier === 'dangerous' ? ' dp-mdl-danger' : ''}${open === 'mode' ? ' dp-on' : ''}`} disabled={disabled} aria-haspopup="menu" aria-expanded={open === 'mode'} title={`Mode: ${shown?.label ?? modeId ?? 'the provider default'}${shown?.description ? ` · ${shown.description}` : ''}`} onClick={() => toggle('mode')}>
          <Icon name="settings" size={12} /><span className="dp-mdl-v">{shown?.label ?? 'default'}</span><Icon name="chevron-down" size={12} />
        </button>
      ) : <span className="dp-chip dp-mdl-mode" title={MODE_TITLE}>{mode ? 'default' : 'auto'}</span>}
      {open === 'mode' && mode && (
        <div className="dp-pop dp-on dp-mdl-pop dp-mdl-mpop" role="menu">
          <div className="dp-pop-h"><b>Mode</b><span className="dp-xs dp-t3 dp-ell">{entry?.label || entry?.id}</span></div>
          <div className="dp-pop-s">
            {modes.map((m) => (
              <div key={m.id} role="menuitemradio" aria-checked={m.id === modeId} className={`dp-mi${m.id === modeId ? ' dp-hl' : ''}`} title={m.description ?? m.label} onClick={() => { mode.onPick(!mode.live && m.id === defaultMode ? null : m.id); setOpen(null); }}>
                {m.id === modeId ? <Icon name="check" size={14} /> : <span className="dp-mdl-sp" />}
                <span className="dp-ell">{m.label}</span>
                {m.id === defaultMode && <span className="dp-chip dp-mdl-tag">default</span>}
                {m.tier === 'dangerous' && <span className="dp-chip dp-bad dp-mdl-tag">no prompts</span>}
                <span className="dp-r dp-ell">{m.description ?? ''}</span>
              </div>
            ))}
          </div>
          <div className="dp-pop-s dp-mdl-foot dp-xs dp-t3">{mode.live ? 'Switches the agent now, its turn in flight included' : `Paseo's modes for ${entry?.label || entry?.id}; the agent starts in this one`}</div>
        </div>
      )}
      {open === 'model' && (
        <div className="dp-pop dp-on dp-mdl-pop" role="menu">
          <div className="dp-pop-h"><b>Model</b><span className="dp-xs dp-t3 dp-ell">{hint}</span></div>
          {failed && <div className="dp-mdl-err dp-xs"><Icon name="alert-triangle" size={12} />{failed}</div>}
          {!catalog && !error && <div className="dp-mdl-err dp-xs dp-t3">Loading Paseo's models…</div>}
          {providers.map((p) => (
            <div key={p.id} className="dp-pop-s">
              {providers.length > 1 && <div className="dp-pop-t" title={`Paseo provider ${p.id}`}>{p.label || p.id}</div>}
              {p.models.map((m) => {
                const id = `${p.id}/${m.id}`;
                const on = model === m;
                const keep = m.thinking.some((t) => t.id === choice?.thinking);
                return (
                  <div key={id} role="menuitemradio" aria-checked={on} className={`dp-mi${on ? ' dp-hl' : ''}`} title={m.description || m.label} onClick={() => choose({ provider: id, thinking: keep ? choice?.thinking ?? null : null })}>
                    {on ? <Icon name="check" size={14} /> : <span className="dp-mdl-sp" />}
                    <Icon name={modelMark(id, m.label)} size={12} />
                    <span className="dp-ell">{m.label}</span>
                    {tag(id) && <span className="dp-chip dp-mdl-tag">{tag(id)}</span>}
                    <span className="dp-r dp-ell">{(m.description || '').replace(`${m.label} · `, '')}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {(all || hidden > 0) && (
            <div className="dp-pop-s dp-mdl-all">
              <div role="menuitemcheckbox" aria-checked={all} className="dp-mi" title="Older releases and 1M-context variants" onClick={toggleAll}>
                <span className={`dp-check${all ? ' dp-on' : ''}`} />
                <span>Show all models</span>
                {!all && <span className="dp-r">{hidden} more</span>}
              </div>
            </div>
          )}
        </div>
      )}
      {open === 'thinking' && choice && (
        <div className="dp-pop dp-on dp-mdl-pop dp-mdl-tpop" role="menu">
          <div className="dp-pop-h"><b>Thinking</b><span className="dp-xs dp-t3 dp-ell">{model?.label ?? choice.provider}</span></div>
          <div className="dp-pop-s">
            <div role="menuitemradio" aria-checked={!choice.thinking} className={`dp-mi${!choice.thinking ? ' dp-hl' : ''}`} onClick={() => choose({ ...choice, thinking: null })}>
              {!choice.thinking ? <Icon name="check" size={14} /> : <span className="dp-mdl-sp" />}
              <span>Model default</span>
              {model?.defaultThinking && <span className="dp-r">{level(model.defaultThinking)}</span>}
            </div>
            {(model?.thinking ?? []).map((t) => (
              <div key={t.id} role="menuitemradio" aria-checked={choice.thinking === t.id} className={`dp-mi${choice.thinking === t.id ? ' dp-hl' : ''}`} onClick={() => choose({ ...choice, thinking: t.id })}>
                {choice.thinking === t.id ? <Icon name="check" size={14} /> : <span className="dp-mdl-sp" />}
                <span>{t.label}</span>
              </div>
            ))}
            {model && !model.thinking.length && <div className="dp-mdl-err dp-xs dp-t3">{model.label} has no thinking levels</div>}
          </div>
          <div className="dp-pop-s dp-mdl-foot dp-xs dp-t3">{hint}</div>
        </div>
      )}
    </span>
  );
}
