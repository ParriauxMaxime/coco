import React from 'react';
import Ask from '../../pages/Ask.jsx';
import { useWork } from '../use-work.js';

export default function AskTab() {
  const { slug } = useWork();
  return <Ask workSlug={slug} />;
}
