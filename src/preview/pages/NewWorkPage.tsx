import React from 'react';
import NewWork from '../../pages/NewWork.tsx';
import { Legacy, Page } from './Page.tsx';

export default function NewWorkPage({ projectId, projectName }: { projectId: string; projectName: string }) {
  return <Page><Legacy><NewWork projectId={projectId} projectName={projectName} /></Legacy></Page>;
}
