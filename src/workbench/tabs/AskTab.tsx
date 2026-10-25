import React from 'react';
import Ask from '../../pages/Ask.tsx';
import { useWork } from '../use-work.ts';

export default function AskTab() {
  const { slug } = useWork();
  return <Ask workSlug={slug} />;
}
