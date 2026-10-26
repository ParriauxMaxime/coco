import React from 'react';
import Rules from '../../components/Rules.tsx';
import { Legacy, Page, PageHead } from './Page.tsx';

export default function RulesPage() {
  return <Page><PageHead icon="scale" title="Rules" /><Legacy><Rules /></Legacy></Page>;
}
