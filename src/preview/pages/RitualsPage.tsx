import React from 'react';
import Rituals from '../../pages/Rituals.tsx';
import { Legacy, Page } from './Page.tsx';

export default function RitualsPage({ preset }: { preset?: string }) {
  return <Page><Legacy><Rituals preset={preset} /></Legacy></Page>;
}
