import React from 'react';
import { useWork } from '../use-work.ts';

export default function Artifact({ tabId }: { tabId: string }) {
  const { w } = useWork();
  const name = tabId.slice(9);
  const [dir, file] = name.split('/');
  const a = w.artifacts.find((x) => x.name === name) || (file && w.artifacts.find((x) => x.name === dir && x.files.includes(file)) ? { name, url: `/works/${w.slug}/artifacts/${dir}/${encodeURIComponent(file)}` } : undefined);
  if (!a) return <div className="sub" style={{ padding: 16 }}>Artifact {name} is not in this work.</div>;
  return <iframe title={a.name} src={a.url} style={{ display: 'block', width: '100%', height: '100%', border: 0 }} />;
}
