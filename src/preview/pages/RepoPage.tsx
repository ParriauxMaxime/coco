import React from 'react';
import Repo, { NewRepo } from '../../pages/Repo.tsx';
import { Legacy, Page } from './Page.tsx';

export default function RepoPage({ id }: { id: string }) {
  return <Page><Legacy><Repo key={id} id={id} /></Legacy></Page>;
}

export function NewRepoPage() {
  return <Page><Legacy><NewRepo /></Legacy></Page>;
}
