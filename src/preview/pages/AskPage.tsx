import React from 'react';
import Ask from '../../pages/Ask.tsx';
import { Legacy, Page } from './Page.tsx';

export default function AskPage({ convId }: { convId?: string }) {
  return <Page><Legacy><Ask convId={convId} /></Legacy></Page>;
}
