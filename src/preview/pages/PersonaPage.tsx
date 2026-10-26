import React from 'react';
import Persona from '../../pages/Persona.tsx';
import { Legacy, Page } from './Page.tsx';

export default function PersonaPage({ login, tab }: { login: string; tab?: string }) {
  return <Page><Legacy><Persona login={login} tab={tab} /></Legacy></Page>;
}
