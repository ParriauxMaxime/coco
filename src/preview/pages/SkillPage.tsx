import React from 'react';
import Skill from '../../pages/Skill.tsx';
import { Legacy, Page } from './Page.tsx';

export default function SkillPage({ name, tab }: { name: string; tab?: string }) {
  return <Page><Legacy><Skill name={name} tab={tab} /></Legacy></Page>;
}
