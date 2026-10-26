import React, { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api.ts';
import Markdown from '../../components/Markdown.tsx';
import Icon from '../Icon.tsx';
import { ErrorNote, Legacy, Loading, Page, PageHead, Section } from './Page.tsx';
import { FeedbackForm, FileEditor, FileList, SubTabs } from './PersonaPage.tsx';
import type { SkillDetail } from '../../types.ts';
import './skill.css';

const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

export default function SkillPage({ name, tab = 'read' }: { name: string; tab?: string }) {
  const [s, setS] = useState<SkillDetail | null>(null);
  const [err, setErr] = useState('');
  const [file, setFile] = useState('SKILL.md');
  const [text, setText] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState('');
  useEffect(() => {
    api.skill(name).then(setS).catch((e) => setErr(errorMessage(e)));
  }, [name]);
  useEffect(() => {
    if (!s) return;
    let alive = true;
    setText(null);
    setFileErr('');
    api.skillFile(name, file).then((t) => alive && setText(t)).catch((e) => alive && setFileErr(errorMessage(e)));
    return () => { alive = false; };
  }, [name, file, s]);
  const load = useCallback(() => api.skillFile(name, file), [name, file]);
  const save = useCallback((t: string) => api.saveSkillFile(name, file, t), [name, file]);
  if (!s) return <Page>{err ? <ErrorNote>{err}</ErrorNote> : <Loading what="Loading skill…" />}</Page>;

  const on = tab === 'edit' ? 'edit' : 'read';
  const many = s.files.length > 1;
  return (
    <Page>
      <div className="dp-skill">
        <PageHead
          icon="book"
          meta={<>Skill{s.userInvocable && <><span className="dp-t4">·</span><span className="dp-mono">/{s.name}</span></>}<span className="dp-t4">·</span>modified {stamp(s.mtime)}</>}
          title={s.name}
          sub={<>{s.description}{s.argumentHint && <span className="dp-skill-arg"><span className="dp-t3">Argument</span><code>{s.argumentHint}</code></span>}</>}
        />
        <SubTabs base={`#/skill/${name}`} on={on} tabs={[{ id: 'read', label: 'Read' }, { id: 'edit', label: 'Edit' }]} />
        <div className={`dp-skill-body${many ? ' dp-skill-many' : ''}`}>
          {many && <FileList files={s.files} on={file} pick={setFile} />}
          <div className="dp-skill-main">
            {on === 'read' && (
              <>
                <div className="dp-box dp-skill-doc">
                  <div className="dp-skill-docbar"><Icon name="file" size={14} /><span className="dp-mono dp-ell">{file}</span></div>
                  {fileErr ? <div className="dp-skill-pad"><ErrorNote>{fileErr}</ErrorNote></div> : text === null ? <div className="dp-skill-pad"><Loading what="Loading file…" /></div> : <div className="dp-skill-md"><Legacy><Markdown text={text.replace(/^---[\s\S]*?---\n/, '')} /></Legacy></div>}
                </div>
                <Section title="Feedback" meta={<span className="dp-mono">{file}</span>}>
                  <div className="dp-box dp-skill-fb"><FeedbackForm key={file} node={`skill:${name}:${file}`} title={`${name} · ${file}`} verdicts={['keep', 'change', 'drop', 'question']} /></div>
                </Section>
              </>
            )}
            {on === 'edit' && <FileEditor key={file} load={load} save={save} label={`${name}/${file}`} />}
          </div>
        </div>
      </div>
    </Page>
  );
}
