import React from 'react';
import Agents from '../../pages/Agents.tsx';
import { Legacy, Page } from './Page.tsx';

export default function AgentsPage() {
  return <Page><Legacy><Agents /></Legacy></Page>;
}
