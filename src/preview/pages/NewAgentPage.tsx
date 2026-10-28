import React, { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import { toast } from '../../components/Toast.tsx';
import { useUnsaved } from '../../updates.ts';
import Icon from '../Icon.tsx';
import { Header } from '../AgentTab.tsx';
import { Composer, Log } from '../chat/Composer.tsx';
import Conversation from '../chat/Conversation.tsx';
import { ModelControls, useModelCatalog, useModelChoice } from '../chat/ModelPicker.tsx';
import { nonceOf } from '../chat/conversation.ts';
import type { Pending } from '../chat/conversation.ts';
import { keepLast, parsePlace, readLast, takeDraft, useLaunchDraft } from '../launcher.ts';
import { ErrorNote } from './Page.tsx';
import type { NewAgentPlace, NewAgentPlaces, UploadRef } from '../../types.ts';
import './agents-page.css';

const family = (p: string) => p.split('/')[0];
const slugOf = (p: NewAgentPlace | null) => (p && (p.kind === 'work' || p.kind === 'row') ? p.slug : null);

// what the place means for the agent, under the pickers
function describe(p: NewAgentPlace, places: NewAgentPlaces) {
  const repo = 'repoId' in p ? places.repos.find((r) => r.id === p.repoId) : null;
  const work = slugOf(p) ? places.works.find((w) => w.slug === slugOf(p)) : null;
  if (p.kind === 'repo') return repo?.app ? 'coco\'s own checkout, on the branch it is on: the note in the message reminds the agent of this repo\'s workflow; edit or delete it.' : `The ${repo?.name ?? p.repoId} clone itself, on the branch it is on.`;
  if (p.kind === 'fresh') return `A new worktree on a new branch off ${repo?.defaultBranch ?? 'the default branch'} (a spare one when ready, else about 15 s).`;
  if (p.kind === 'work') return `${work?.title ?? p.slug}'s Plan workspace, a checkout of the default branch; the message carries the work's brief and the agent lists in the work.`;
  const row = places.rows.find((r) => r.key === p.key);
  return `${row?.label ?? p.key}'s own worktree, on its branch; the message carries that PR's brief and the agent is linked to the PR.`;
}

function shortLabel(p: NewAgentPlace, places: NewAgentPlaces) {
  const repo = 'repoId' in p ? places.repos.find((r) => r.id === p.repoId) : null;
  if (p.kind === 'repo') return repo?.app ? 'coco\'s own checkout' : `the ${repo?.name ?? p.repoId} clone`;
  if (p.kind === 'fresh') return `a new worktree of ${repo?.name ?? p.repoId}`;
  if (p.kind === 'work') return `${places.works.find((w) => w.slug === p.slug)?.title ?? p.slug}'s Plan workspace`;
  return `${places.rows.find((r) => r.key === p.key)?.label ?? p.key}'s worktree`;
}

// #/agents/new: start any agent like Paseo's new-agent screen, in a repo's clone, a work's Plan, a PR's worktree or a fresh worktree;
// once sent it shows as starting, then becomes the agent's page
export default function NewAgentPage({ place: asked }: { place?: string | null }) {
  const [id, setId] = useState(() => asked || readLast().place || '');
  const place = parsePlace(id);
  const slug = slugOf(place);
  const [loaded, setLoaded] = useState<{ slug: string | null; places: NewAgentPlaces } | null>(null);
  const places = loaded?.places ?? null;
  const [err, setErr] = useState('');
  useEffect(() => {
    api.newAgentPlaces(slug).then((p) => { setLoaded({ slug, places: p }); setErr(''); }, (e) => setErr(errorMessage(e)));
  }, [slug]);
  // `app` and a place that is gone fall back to coco's checkout or the first repo; a PR row no longer open to its work's Plan
  useEffect(() => {
    if (!places) return;
    const p = parsePlace(id);
    const known = p && ('repoId' in p ? places.repos.some((r) => r.id === p.repoId) : places.works.some((w) => w.slug === p.slug));
    if (!known) setId(id === 'app' && places.app ? `repo:${places.app}` : places.repos[0] ? `repo:${places.repos[0].id}` : '');
    else if (p.kind === 'row' && loaded?.slug === p.slug && !places.rows.some((r) => r.key === p.key)) setId(`work:${p.slug}`);
  }, [loaded]);

  const [text, setText] = useState(() => useLaunchDraft.getState().text ?? '');
  const seq = useLaunchDraft((s) => s.seq);
  const isApp = Boolean(places && place?.kind === 'repo' && place.repoId === places.app);
  const note = places?.appNote ?? '';
  // on coco's own checkout the workflow note sits under the owner's words, in plain sight; it goes when the place changes
  const noted = (t: string) => (!note ? t : isApp ? (t.includes(note) ? t : t.trim() ? `${t.trimEnd()}\n\n${note}` : `\n\n${note}`) : t.includes(note) ? t.replace(note, '').trim() : t);
  useEffect(() => {
    const d = takeDraft();
    if (d != null) setText(noted(d));
  }, [seq]);
  useEffect(() => setText(noted), [isApp, note]);
  useUnsaved(Boolean((note ? text.replace(note, '') : text).trim()));

  const model = useModelChoice('new-agent');
  const { catalog } = useModelCatalog();
  const fam = model.choice ? family(model.choice.provider) : null;
  const [modes, setModes] = useState(() => readLast().modes ?? {});
  const offered = catalog?.providers.find((p) => p.id === fam)?.modes ?? [];
  const mode = fam && offered.some((m) => m.id === modes[fam]) ? modes[fam] ?? null : null;
  const pickMode = (m: string | null) => {
    if (!fam) return;
    setModes((s) => ({ ...s, [fam]: m }));
    keepLast({ modes: { [fam]: m } });
  };

  const [starting, setStarting] = useState<(Pending & { title: string }) | null>(null);
  const start = async (prompt: string, files: UploadRef[]) => {
    if (!place) return false;
    const here = location.hash;
    setErr('');
    setStarting({ nonce: nonceOf(), text: prompt, title: prompt.split('\n')[0].slice(0, 60), ...(files.length ? { attachments: files } : {}) });
    keepLast({ place: id });
    try {
      const r = await api.newAgent({ place, prompt, attachments: files.map((f) => f.id), ...model.body(), ...(mode ? { mode } : {}) });
      if (location.hash === here) location.replace(`#/agents/${encodeURIComponent(r.agentId)}`);
      else toast.success(`Agent started: ${r.title}`);
      return true;
    } catch (e) {
      setStarting(null);
      setErr(errorMessage(e));
      return false;
    }
  };

  const repos = places?.repos ?? [];
  const where = slug ? `work:${slug}` : id;
  const placeLabel = place && places ? shortLabel(place, places) : 'its place';
  return (
    <div className="dp-page dp-agpage dp-newag" role="main">
      {starting && (
        <section className="dp-agpage-chat">
          <Header title={starting.title} kind="agent" pr={place?.kind === 'row' ? place.key : null} state="running" agentId={null} chips={<span className="dp-chip dp-info">Starting…</span>} />
          <Log size={1}>
            <Conversation run={{ id: 'new', prompt: '' }} events={[]} pending={[starting]} working={false} who="agent" />
            <div className="dp-na-starting"><span className="dp-ag-dot dp-ag-running" /><span>Starting in {placeLabel}…</span></div>
          </Log>
        </section>
      )}
      <section className="dp-agpage-chat" style={starting ? { display: 'none' } : undefined}>
        <div className="dp-vbar"><Icon name="bot" size={14} /><span className="dp-title">New agent</span><span className="dp-xs dp-t3">a free session, as in Paseo</span></div>
        <div className="dp-agent-log dp-ag-start">
          <div className="dp-ag-hello dp-na-hello">
            <span className="dp-bot dp-na-av"><Icon name="bot" size={16} /></span>
            <div className="dp-ag-h">Start an agent</div>
            <p className="dp-t3">Write its task, paste screenshots, pick the model, thinking and mode, and where it runs. It opens on its own page once started.</p>
            <div className="dp-na-where">
              <label className="dp-na-f">
                <span className="dp-xs dp-t3">Runs in</span>
                <select className="dp-inp" value={where} disabled={!places} onChange={(e) => setId(e.target.value)} aria-label="Where the agent runs">
                  {!places && <option value={where}>Loading…</option>}
                  {places && (
                    <optgroup label="Repos">
                      {repos.map((r) => (
                        <React.Fragment key={r.id}>
                          <option value={`repo:${r.id}`}>{r.name} · its clone{r.app ? ' (coco itself)' : ''}</option>
                          <option value={`fresh:${r.id}`}>{r.name} · new worktree off {r.defaultBranch}</option>
                        </React.Fragment>
                      ))}
                    </optgroup>
                  )}
                  {places && places.works.length > 0 && <optgroup label="Works">{places.works.map((w) => <option key={w.slug} value={`work:${w.slug}`}>{w.title}</option>)}</optgroup>}
                </select>
              </label>
              {slug && (
                <label className="dp-na-f">
                  <span className="dp-xs dp-t3">Workspace</span>
                  <select className="dp-inp" value={id} onChange={(e) => setId(e.target.value)} aria-label="Workspace of the work">
                    <option value={`work:${slug}`}>Plan workspace</option>
                    {loaded?.slug === slug && places?.rows.map((r) => <option key={r.key} value={`row:${slug}:${r.key}`}>{r.label}{r.title ? ` ${r.title}` : ''} · its worktree</option>)}
                    {place?.kind === 'row' && loaded?.slug !== slug && <option value={id}>{place.key}</option>}
                  </select>
                </label>
              )}
            </div>
            {place && places && <p className="dp-xs dp-t3 dp-na-what">{describe(place, places)}</p>}
          </div>
        </div>
        {err && <div className="dp-na-err"><ErrorNote>{err}</ErrorNote></div>}
        <Composer
          className="dp-na-comp"
          autoFocus
          placeholder="What should it do? Paste or drop screenshots and files (↵ starts it, ⇧↵ new line)"
          note={isApp ? 'coco\'s workflow note added: edit it freely' : ''}
          sendLabel="Start"
          disabled={!place || !places}
          value={text}
          onValue={setText}
          tools={<ModelControls choice={model.choice} onPick={model.pick} hint="for the agent this starts" mode={{ value: mode, onPick: pickMode }} />}
          onSend={start}
        />
      </section>
    </div>
  );
}
