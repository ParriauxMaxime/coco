import { useWork } from '../workbench/use-work.ts';
import Icon from './Icon.tsx';
import { Empty } from './pages/Page.tsx';
import './run.css';

// artifact-<name> or artifact-<folder>/<file>: the artifact in a frame
export default function ArtifactView({ tabId }: { tabId: string }) {
  const { w } = useWork();
  const name = tabId.slice(9);
  const [dir, file] = name.split('/');
  const a = w.artifacts.find((x) => x.name === name) || (file && w.artifacts.find((x) => x.name === dir && x.files.includes(file)) ? { name, url: `/works/${w.slug}/artifacts/${dir}/${encodeURIComponent(file)}` } : undefined);
  return (
    <div className="dp-tabview dp-art">
      <div className="dp-vbar">
        <Icon name="file" size={14} />
        <span className="dp-title dp-ell" title={name}>{name}</span>
        <span className="dp-sp" />
        {a && <a className="dp-btn dp-sm dp-ghost" href={a.url} target="_blank" rel="noreferrer" title="Open in a new browser tab"><Icon name="external-link" size={12} />Open</a>}
      </div>
      {a ? <iframe className="dp-art-frame" title={a.name} src={a.url} /> : <div className="dp-doc"><Empty icon="file">Artifact {name} is not in this work.</Empty></div>}
    </div>
  );
}
